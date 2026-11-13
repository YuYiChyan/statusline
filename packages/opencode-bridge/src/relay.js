import { DEFAULT_RELAY, encryptEnvelope, legacyProjection, validateChannel } from './protocol.js';

const MAX_RESPONSE_BYTES = 16 * 1024;
const SERVICES = 'services-v1';
const MEDIA_TYPE = 'application/vnd.statusline.services-v1+json';
const CAPABILITIES = new Set([SERVICES, 'reset-push-v1', 'quota-alerts-v1']);
const MESSAGES = Object.freeze({
  invalidConfiguration: 'Invalid relay configuration.',
  invalidState: 'Invalid relay credentials.',
  credentialOriginMismatch: 'Relay credentials belong to a different origin.',
  invalidPayload: 'Invalid relay publication.',
  invalidResponse: 'The relay returned an invalid response.',
  responseTooLarge: 'The relay response is too large.',
  redirect: 'Relay redirects are not allowed.',
  timeout: 'The relay request timed out.',
  aborted: 'The relay request was cancelled.',
  networkError: 'The relay request failed.',
  legacyUnavailable: 'This relay requires a ready Codex weekly reading.',
  encryptionFailed: 'Relay publication encryption failed.',
  invalidRequest: 'The relay rejected the request.',
  notFound: 'The relay resource was not found.',
  channelNotFound: 'The relay channel was not found.',
  channelExpired: 'The relay channel has expired.',
  pairingExpired: 'The pairing code has expired.',
  snapshotNotFound: 'No relay snapshot is available.',
  staleSnapshot: 'The relay already has a newer snapshot.',
  rateLimited: 'The relay rate limit was reached.',
  internalError: 'The relay is temporarily unavailable.',
  httpError: 'The relay rejected the request.',
});
const ERROR_STATUSES = new Map([
  ['invalidRequest', 400], ['notFound', 404], ['channelNotFound', 404],
  ['channelExpired', 410], ['pairingExpired', 410], ['snapshotNotFound', 404],
  ['staleSnapshot', 409], ['rateLimited', 429], ['internalError', 500],
]);

export class RelayError extends Error {
  constructor(code, { status, retryAfterMs } = {}) {
    const safeCode = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'httpError';
    super(MESSAGES[safeCode]);
    this.name = 'RelayError';
    this.code = safeCode;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

function origin(value, allowLoopback) {
  try {
    // Check the raw form before URL can erase empty query/fragment markers, dot
    // segments, credentials, whitespace, or backslashes during normalization.
    if (typeof value !== 'string' || value.length > 2048
        || /[\u0000-\u0020\u007f\\%@?#]/u.test(value)
        || !/^https?:\/\/[^/]+\/?$/iu.test(value)) throw new Error();
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && loopback))) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new RelayError('invalidConfiguration');
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function expect(condition) {
  if (!condition) throw new RelayError('invalidResponse');
}

function version(value) {
  expect(object(value) && value.protocolVersion === 1);
}

function credentials(channelId, token) {
  // The same canonical 32-byte rule applies to all three bearer roles and keys.
  try {
    validateChannel({ channelId, publisherToken: token, key: token });
  } catch {
    throw new RelayError('invalidState');
  }
}

function capabilities(value) {
  if (value === undefined) return [];
  expect(Array.isArray(value) && value.length <= 32);
  expect(value.every((item) => typeof item === 'string' && item.length >= 1
    && item.length <= 64 && !/[^a-z0-9-]/u.test(item)) && new Set(value).size === value.length);
  // Unknown additive capabilities must not activate an extension.
  return value.filter((item) => CAPABILITIES.has(item));
}

function retryAfter(value) {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  let ms;
  if (/^\d{1,10}$/u.test(value)) ms = Number(value) * 1000;
  else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) {
    ms = Date.parse(value) - Date.now();
  }
  return Number.isFinite(ms) ? Math.min(86_400_000, Math.max(0, ms)) : undefined;
}

function discard(response) {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* best effort */ }
}

async function boundedBody(response, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    expect(/^\d+$/u.test(declared));
    if (Number(declared) > MAX_RESPONSE_BYTES) throw new RelayError('responseTooLarge');
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* best effort */ } };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new RelayError('aborted');
      const chunk = await reader.read();
      if (signal.aborted) throw new RelayError('aborted');
      if (chunk.done) break;
      expect(chunk.value instanceof Uint8Array);
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new RelayError('responseTooLarge');
      if (chunk.value.byteLength > 0) chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function parseJSON(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RelayError('invalidResponse');
  }
}

function envelope(value) {
  version(value);
  expect(positive(value.sequence));
  expect(!Object.hasOwn(value, 'payloadKind') || value.payloadKind === SERVICES);
  for (const [field, minimum, maximum] of [['nonce', 12, 12], ['ciphertext', 17, 4096]]) {
    const text = value[field];
    expect(typeof text === 'string' && text.length > 0 && text.length <= Math.ceil(maximum * 4 / 3)
      && !/[^A-Za-z0-9_-]/u.test(text));
    const bytes = Buffer.from(text, 'base64url');
    expect(bytes.length >= minimum && bytes.length <= maximum && bytes.toString('base64url') === text);
  }
  return {
    protocolVersion: 1,
    ...(value.payloadKind === SERVICES ? { payloadKind: SERVICES } : {}),
    sequence: value.sequence, nonce: value.nonce, ciphertext: value.ciphertext,
  };
}

export class RelayClient {
  #baseUrl;
  #fetch;
  #timeoutMs;
  #allowLoopback;
  #signal;

  constructor(options = {}) {
    if (!object(options)) throw new RelayError('invalidConfiguration');
    const { baseUrl = DEFAULT_RELAY, fetchImpl = globalThis.fetch, timeoutMs = 10000, allowLoopback = false, signal } = options;
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
        || timeoutMs > 2_147_483_647 || typeof allowLoopback !== 'boolean'
        || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw new RelayError('invalidConfiguration');
    }
    this.#baseUrl = origin(baseUrl, allowLoopback);
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#allowLoopback = allowLoopback;
    this.#signal = signal;
  }

  get baseUrl() { return this.#baseUrl; }

  #publisher(state) {
    try { validateChannel(state); } catch { throw new RelayError('invalidState'); }
    let storedOrigin;
    try { storedOrigin = origin(state.relayUrl, this.#allowLoopback); }
    catch { throw new RelayError('invalidState'); }
    if (storedOrigin !== this.#baseUrl) throw new RelayError('credentialOriginMismatch');
    return `/v1/channels/${state.channelId}`;
  }

  async #request(path, { method = 'GET', token, body, status = 200, empty = false, gone = false, accept = 'application/json' } = {}) {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const signal = this.#signal ? AbortSignal.any([controller.signal, this.#signal]) : controller.signal;
    if (signal.aborted) throw new RelayError('aborted');
    const cancellationCode = () => controller.signal.aborted ? 'timeout' : 'aborted';
    let response;
    let timer;
    let onAbort;
    const cancellation = new Promise((_, reject) => {
      onAbort = () => {
        discard(response);
        reject(new RelayError(cancellationCode()));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    });
    const perform = async () => {
      const headers = { Accept: accept };
      if (token !== undefined) headers.Authorization = `Bearer ${token}`;
      let encoded;
      if (body !== undefined) {
        encoded = JSON.stringify(body);
        if (Buffer.byteLength(encoded) > (path.endsWith('/services') ? 16384 : 8192)) {
          throw new RelayError('invalidPayload');
        }
        headers['Content-Type'] = 'application/json';
      }
      response = await this.#fetch(url, {
        method, headers, ...(encoded === undefined ? {} : { body: encoded }),
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      });
      if (signal.aborted) {
        discard(response);
        throw new RelayError(cancellationCode());
      }
      if (response.redirected || response.type === 'opaqueredirect'
          || (response.status >= 300 && response.status < 400)) throw new RelayError('redirect');
      // A custom fetch must not silently follow redirects with a bearer token.
      if (response.url && response.url !== url) throw new RelayError('redirect');
      const bytes = await boundedBody(response, signal);
      if (gone && response.status === 404) return undefined;
      if (response.status !== status) {
        if (response.status < 400 || response.status > 599) throw new RelayError('invalidResponse');
        let code = response.status === 429 ? 'rateLimited'
          : response.status >= 500 ? 'internalError' : 'httpError';
        try {
          const reported = parseJSON(bytes)?.error?.code;
          if (ERROR_STATUSES.get(reported) === response.status) code = reported;
        } catch { /* Never include upstream prose, even for non-JSON gateway errors. */ }
        throw new RelayError(code, { status: response.status, retryAfterMs: retryAfter(response.headers.get('retry-after')) });
      }
      if (empty) {
        expect(bytes.length === 0);
        return undefined;
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      expect(contentType === 'application/json' || (accept === MEDIA_TYPE && contentType === MEDIA_TYPE));
      return parseJSON(bytes);
    };
    try {
      return await Promise.race([perform(), cancellation]);
    } catch (error) {
      discard(response);
      if (signal.aborted) throw new RelayError(cancellationCode());
      if (error instanceof RelayError) throw error;
      throw new RelayError('networkError');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async health() {
    const result = await this.#request('/health');
    version(result);
    expect(result.status === 'ok');
    return { status: 'ok', protocolVersion: 1, capabilities: capabilities(result.capabilities) };
  }

  async createChannel() {
    const result = await this.#request('/v1/channels', { method: 'POST', status: 201 });
    version(result);
    try {
      credentials(result.channelId, result.publisherToken);
      credentials(result.channelId, result.pairingToken);
    } catch { throw new RelayError('invalidResponse'); }
    expect(result.publisherToken !== result.pairingToken && positive(result.pairingExpiresAt)
      && positive(result.expiresAt) && result.expiresAt > result.pairingExpiresAt);
    return {
      protocolVersion: 1, channelId: result.channelId, publisherToken: result.publisherToken,
      pairingToken: result.pairingToken, pairingExpiresAt: result.pairingExpiresAt, expiresAt: result.expiresAt,
    };
  }

  async metadata(state) {
    const path = this.#publisher(state);
    const result = await this.#request(path, { token: state.publisherToken });
    version(result);
    expect(positive(result.pairingExpiresAt) && positive(result.expiresAt)
      && result.expiresAt > result.pairingExpiresAt);
    for (const key of ['readerClaimedAt', 'lastPublishedAt']) {
      expect(result[key] === null || positive(result[key]));
    }
    expect(result.servicesLastPublishedAt === undefined || result.servicesLastPublishedAt === null
      || positive(result.servicesLastPublishedAt));
    return {
      protocolVersion: 1, readerClaimedAt: result.readerClaimedAt, pairingExpiresAt: result.pairingExpiresAt,
      lastPublishedAt: result.lastPublishedAt, expiresAt: result.expiresAt,
      capabilities: capabilities(result.capabilities), servicesLastPublishedAt: result.servicesLastPublishedAt ?? null,
    };
  }

  async publish(state, inventory, sequence) {
    const path = this.#publisher(state);
    let services;
    let codex = null;
    try {
      const options = { channelId: state.channelId, key: state.key, sequence };
      services = await encryptEnvelope(inventory, { ...options, kind: SERVICES });
      const legacy = legacyProjection(inventory);
      if (legacy !== null) {
        // Random collisions are fantastically unlikely, but must never be sent.
        for (let attempt = 0; attempt < 4; attempt++) {
          codex = await encryptEnvelope(legacy, options);
          if (codex.nonce !== services.nonce) break;
        }
        if (codex.nonce === services.nonce) throw new RelayError('encryptionFailed');
      }
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError(error?.code === 'encryptionFailed' ? 'encryptionFailed' : 'invalidPayload');
    }
    const info = await this.metadata(state);
    if (info.capabilities.includes(SERVICES)) {
      await this.#request(`${path}/services`, { method: 'PUT', token: state.publisherToken,
        body: { services, codex }, status: 201, empty: true });
      return { kind: SERVICES };
    }
    if (codex === null) throw new RelayError('legacyUnavailable');
    await this.#request(`${path}/snapshot`, { method: 'PUT', token: state.publisherToken, body: codex, status: 201, empty: true });
    return { kind: 'legacy' };
  }

  async deleteChannel(state) {
    await this.#request(this.#publisher(state), { method: 'DELETE', token: state.publisherToken,
      status: 204, empty: true, gone: true });
  }

  async claim(channelId, pairingToken) {
    credentials(channelId, pairingToken);
    const result = await this.#request(`/v1/channels/${channelId}/claim`, { method: 'POST', token: pairingToken, status: 201 });
    version(result);
    try { credentials(channelId, result.readerToken); } catch { throw new RelayError('invalidResponse'); }
    expect(positive(result.expiresAt) && result.readerToken !== pairingToken);
    return { protocolVersion: 1, readerToken: result.readerToken, expiresAt: result.expiresAt };
  }

  async read(channelId, readerToken) {
    credentials(channelId, readerToken);
    return envelope(await this.#request(`/v1/channels/${channelId}/snapshot`, { token: readerToken, accept: MEDIA_TYPE }));
  }
}
