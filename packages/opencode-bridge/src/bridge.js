import { createHash } from 'node:crypto';
import { StateStore } from './store.js';
import { RelayClient } from './relay.js';
import { validateChannel } from './protocol.js';
import { normalizeQuota } from './normalize.js';

export function inventoryHash(inventory) {
  return createHash('sha256').update(JSON.stringify(inventory.providers)).digest('hex');
}

/** Only fixed local error codes are exposed to OpenCode or the CLI. */
const ERROR_CODES = new Set([
  'invalid_state_directory', 'invalid_state', 'busy', 'already_configured',
  'source_scope_changed', 'quota_timeout', 'bridge_failed', 'pairing_cleanup_failed',
  'invalidConfiguration', 'invalidState', 'credentialOriginMismatch', 'invalidPayload',
  'invalidResponse', 'responseTooLarge', 'redirect', 'timeout', 'aborted', 'networkError',
  'legacyUnavailable', 'encryptionFailed', 'invalidRequest', 'notFound', 'channelNotFound',
  'channelExpired', 'pairingExpired', 'snapshotNotFound', 'staleSnapshot', 'rateLimited',
  'internalError', 'httpError', 'invalidChannel', 'invalidEnvelope', 'decryptionFailed', 'randomFailed',
]);
export function safeError(error) {
  return ERROR_CODES.has(error?.code) ? error.code : 'bridge_failed';
}

export function createBridge({ readQuota, store = new StateStore(), accounts = {}, services = ['codex', 'antigravity', 'claude'], maxAgeMs = 900000,
  pollMs = 60000, now = Date.now, makeRelay = options => new RelayClient(options) }) {
  let disposed = false;
  let busy;
  let failures = 0;
  let nextAttemptAt = 0;
  let controller;
  let timer;
  let status = { state: 'unpaired', lastPublishedAt: null, error: null };

  function tick() {
    if (disposed || now() < nextAttemptAt) return Promise.resolve(status);
    if (busy) return busy.then(() => status);
    busy = store.withLock(async () => {
      const state = await store.read();
      if (disposed) return;
      if (!state) { status = { state: 'unpaired', lastPublishedAt: null, error: null }; return; }
      validateChannel(state);
      if (Number.isFinite(state.retryAtMs) && now() < state.retryAtMs) {
        status = { state: 'backoff', lastPublishedAt: state.lastPublishedAt ?? null, error: state.lastError ? safeError({ code: state.lastError }) : null, nextAttemptAt: state.retryAtMs };
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      const timeout = setTimeout(() => controller?.abort(), 10000);
      let onAbort;
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(Object.assign(new Error('Quota cache read cancelled'), { code: 'quota_timeout' }));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      let raw;
      try { raw = await Promise.race([readQuota(signal), cancelled]); }
      finally { clearTimeout(timeout); signal.removeEventListener('abort', onAbort); }
      if (disposed || controller.signal.aborted) return;
      const scope = raw?.snapshot?.sourceScope;
      if (state.sourceScope && state.sourceScope !== scope) {
        status = { state: 'error', lastPublishedAt: state.lastPublishedAt ?? null, error: 'source_scope_changed' };
        return;
      }
      const { inventory, diagnostics } = normalizeQuota(raw, { nowMs: now(), maxAgeMs, accounts });
      // Discovery may temporarily omit providers on network/auth failure. Retain
      // only the public sample time as unavailable until explicitly excluded.
      const projected = new Map(inventory.providers.map(provider => [provider.id, provider]));
      inventory.providers = services.flatMap(id => {
        if (projected.has(id)) return [projected.get(id)];
        const previous = state.knownProviders?.find(provider => provider.id === id);
        if (!previous || !Number.isSafeInteger(previous.updatedAt) || previous.updatedAt <= 0) return [];
        diagnostics.push({ code: 'source_missing', serviceId: id });
        return [{ id, status: 'unavailable', updatedAt: Math.min(previous.updatedAt, inventory.updatedAt), weekly: null, shortWindow: null }];
      });
      const hash = inventoryHash(inventory);
      if (!state.pendingPublication && state.lastHash === hash) {
        failures = 0;
        status = { state: 'unchanged', lastPublishedAt: state.lastPublishedAt ?? null, error: null, diagnostics };
        return;
      }
      const sequence = Math.max(now(), state.sequence + 1);
      if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('Invalid clock');
      // Advance before network I/O, so a process crash cannot reuse a sequence.
      // An interrupted/failed request may still have reached the relay. Until a
      // successful acknowledgement is durable, an old hash is not proof of sync.
      const pending = { ...state, sequence, pendingPublication: true, ...(typeof scope === 'string' ? { sourceScope: scope } : {}) };
      await store.write(pending);
      if (disposed) return;
      const relay = makeRelay({ baseUrl: state.relayUrl, signal: controller.signal });
      let result;
      try { result = await relay.publish(state, inventory, sequence); }
      catch (error) {
        if (!disposed) {
          const attempt = (Number.isSafeInteger(state.failures) ? state.failures : 0) + 1;
          const delay = Math.max(Math.min(60000 * 2 ** Math.min(attempt - 1, 6), 3600000),
            Math.min(Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0, 86400000));
          await store.write({ ...pending, failures: attempt, retryAtMs: now() + delay, lastError: safeError(error) });
        }
        throw error;
      }
      if (disposed) return;
      const lastPublishedAt = now();
      const knownProviders = inventory.providers.map(({ id, updatedAt }) => ({ id, updatedAt }));
      await store.write({ ...pending, pendingPublication: false, knownProviders, lastHash: hash, lastPublishedAt, failures: 0, retryAtMs: 0, lastError: null });
      failures = 0;
      nextAttemptAt = 0;
      status = { state: 'published', kind: result.kind, lastPublishedAt, error: null, diagnostics };
    }).catch(error => {
      const code = safeError(error);
      if (disposed || code === 'busy') return;
      failures++;
      const delay = Math.max(Math.min(60000 * 2 ** Math.min(failures - 1, 6), 3600000),
        Math.min(Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0, 86400000));
      nextAttemptAt = now() + delay;
      status = { ...status, state: 'error', error: code, nextAttemptAt };
    }).finally(() => { busy = undefined; controller = undefined; });
    return busy.then(() => status);
  }

  return {
    tick,
    status: () => ({ ...status }),
    start() {
      if (timer || disposed) return;
      void tick();
      timer = setInterval(() => { void tick(); }, pollMs);
      timer.unref?.();
    },
    async dispose() {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
      await busy;
    },
  };
}
