import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const DEFAULT_RELAY = 'https://statusline-relay.inmerzion.workers.dev';

const MAX_CIPHERTEXT_BYTES = 4096;
const CHANNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KNOWN_PROVIDERS = new Set(['codex', 'antigravity', 'claude']);
const MESSAGES = {
  invalidChannel: 'Invalid Statusline channel.',
  invalidPayload: 'Invalid Statusline payload.',
  invalidEnvelope: 'Invalid Statusline envelope.',
  encryptionFailed: 'Statusline encryption failed.',
  decryptionFailed: 'Statusline decryption failed.',
  randomFailed: 'Secure random data is unavailable.',
};

function failure(code) {
  return Object.assign(new Error(MESSAGES[code]), { code });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function channel(value) {
  return typeof value === 'string' && value.length === 36 && CHANNEL.test(value);
}

function decode(value, minimum, maximum, code) {
  // Buffer's decoder is intentionally permissive; require canonical encoding too.
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3)
      || value.length === 0 || /[^A-Za-z0-9_-]/u.test(value)) {
    throw failure(code);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minimum || bytes.length > maximum
      || bytes.toString('base64url') !== value) throw failure(code);
  return bytes;
}

export function newKey() {
  try {
    return randomBytes(32).toString('base64url');
  } catch {
    throw failure('randomFailed');
  }
}

export function validateChannel(state) {
  if (!object(state) || !channel(state.channelId)) throw failure('invalidChannel');
  decode(state.publisherToken, 32, 32, 'invalidChannel');
  decode(state.key, 32, 32, 'invalidChannel');
}

export function pairingUri(channelId, pairingToken, key) {
  validateChannel({ channelId, publisherToken: pairingToken, key });
  // All components have already been restricted to URI-safe ASCII.
  return `statusline://pair?v=1&channel=${channelId}&pairing=${pairingToken}&key=${key}`;
}

function validWindow(window, id, weekly) {
  if (window === null) return true;
  if (!object(window) || !Number.isInteger(window.remainingPercentage)
      || window.remainingPercentage < 0 || window.remainingPercentage > 100
      || !positive(window.resetAt) || !positive(window.windowMinutes)) return false;
  if (id === 'codex') {
    return weekly ? window.windowMinutes >= 8640 && window.windowMinutes <= 11520
      : window.windowMinutes < 8640;
  }
  return window.windowMinutes === (weekly ? 10080 : 300);
}

function validatePayload(payload, kind) {
  if (!object(payload) || payload.schemaVersion !== 1 || !positive(payload.updatedAt)) {
    throw failure('invalidPayload');
  }
  if (kind === undefined) {
    if (!Number.isInteger(payload.remainingPercentage) || payload.remainingPercentage < 0
        || payload.remainingPercentage > 100 || !positive(payload.resetAt)) {
      throw failure('invalidPayload');
    }
    return;
  }
  if (!Array.isArray(payload.providers) || payload.providers.length > 16) {
    throw failure('invalidPayload');
  }
  const ids = new Set();
  for (const provider of payload.providers) {
    if (!object(provider) || typeof provider.id !== 'string' || provider.id.length < 1
        || provider.id.length > 64 || /[^a-z0-9-]/u.test(provider.id) || ids.has(provider.id)) {
      throw failure('invalidPayload');
    }
    ids.add(provider.id);
    // Future adapters are opaque to v1 readers. Do not impose today's windows on them.
    if (!KNOWN_PROVIDERS.has(provider.id)) continue;
    if (!positive(provider.updatedAt) || provider.updatedAt > payload.updatedAt
        || !['ready', 'unavailable'].includes(provider.status)
        || !validWindow(provider.weekly, provider.id, true)
        || !validWindow(provider.shortWindow, provider.id, false)
        || (provider.status === 'ready') !== (provider.weekly !== null || provider.shortWindow !== null)) {
      throw failure('invalidPayload');
    }
  }
}

function aad(channelId, sequence, kind) {
  return Buffer.from(kind === 'services-v1'
    ? `statusline.services.v1|${channelId}|${sequence}`
    : `statusline.snapshot.v1|${channelId}`, 'utf8');
}

export async function encryptEnvelope(payload, options) {
  if (!object(options) || !channel(options.channelId)) throw failure('invalidChannel');
  const key = decode(options.key, 32, 32, 'invalidChannel');
  const { channelId, sequence, kind } = options;
  if (!positive(sequence) || (kind !== undefined && kind !== 'services-v1')) {
    throw failure('invalidEnvelope');
  }
  if (options.nonce !== undefined
      && (!(options.nonce instanceof Uint8Array) || options.nonce.byteLength !== 12)) {
    throw failure('invalidEnvelope');
  }
  validatePayload(payload, kind);
  let plaintext;
  try {
    plaintext = JSON.stringify(payload);
    if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_CIPHERTEXT_BYTES - 16) {
      throw failure('invalidPayload');
    }
    // A custom toJSON must not circumvent the schema checks.
    validatePayload(JSON.parse(plaintext), kind);
  } catch {
    throw failure('invalidPayload');
  }
  try {
    // Deterministic nonces are solely for public fixture tests, never production calls.
    const nonce = options.nonce === undefined ? randomBytes(12) : Buffer.from(options.nonce);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(channelId, sequence, kind));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return {
      protocolVersion: 1,
      ...(kind === undefined ? {} : { payloadKind: kind }),
      sequence,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  } catch {
    throw failure('encryptionFailed');
  }
}

export async function decryptEnvelope(envelope, options) {
  if (!object(options) || !channel(options.channelId)) throw failure('invalidChannel');
  const key = decode(options.key, 32, 32, 'invalidChannel');
  if (!object(envelope) || envelope.protocolVersion !== 1 || !positive(envelope.sequence)
      || (Object.hasOwn(envelope, 'payloadKind') && envelope.payloadKind !== 'services-v1')) {
    throw failure('invalidEnvelope');
  }
  const nonce = decode(envelope.nonce, 12, 12, 'invalidEnvelope');
  const ciphertext = decode(envelope.ciphertext, 17, MAX_CIPHERTEXT_BYTES, 'invalidEnvelope');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad(options.channelId, envelope.sequence, envelope.payloadKind));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const bytes = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    validatePayload(payload, envelope.payloadKind);
    return payload;
  } catch {
    // Do not surface crypto, JSON, or attacker-controlled plaintext exceptions.
    throw failure('decryptionFailed');
  }
}

export function legacyProjection(inventory) {
  validatePayload(inventory, 'services-v1');
  const codex = inventory.providers.find((provider) => provider.id === 'codex');
  if (codex?.status !== 'ready' || codex.weekly === null) return null;
  return {
    schemaVersion: 1,
    remainingPercentage: codex.weekly.remainingPercentage,
    resetAt: codex.weekly.resetAt,
    updatedAt: codex.updatedAt,
  };
}
