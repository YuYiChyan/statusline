import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEFAULT_RELAY, newKey, validateChannel, pairingUri,
  encryptEnvelope, decryptEnvelope, legacyProjection,
} from '../src/protocol.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../../../protocol/fixtures/${name}`, import.meta.url), 'utf8'));
// Public interoperability vectors, not real channels or account credentials.
const legacy = await fixture('aes-gcm-v1.json');
const services = await fixture('aes-gcm-services-v1.json');
const claude = await fixture('services-claude-v1.json');
const identity = { channelId: legacy.channelId, key: legacy.key };
const state = { ...identity, publisherToken: Buffer.alloc(32, 9).toString('base64url') };
const token = Buffer.alloc(32, 8).toString('base64url');
const changedChannel = '018f47a0-7b52-4c15-9e55-5f0f266b7441';
const options = { ...identity, sequence: 42, kind: 'services-v1' };
const errorCode = (code) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.ok(!error.message.includes(legacy.key));
  assert.ok(!error.message.includes(legacy.channelId));
  return true;
};

function wire(vector) {
  return {
    protocolVersion: vector.protocolVersion,
    ...(vector.payloadKind ? { payloadKind: vector.payloadKind } : {}),
    sequence: vector.sequence, nonce: vector.nonce, ciphertext: vector.ciphertextAndTag,
  };
}

function sealRaw(text) {
  const nonce = Buffer.from(services.nonce, 'base64url');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(services.key, 'base64url'), nonce);
  cipher.setAAD(Buffer.from(services.aad));
  const bytes = Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]);
  return { ...wire(services), ciphertext: bytes.toString('base64url') };
}

for (const vector of [legacy, services]) {
  test(`matches exact ${vector.payloadKind ?? 'legacy'} fixture and plaintext encoding`, async () => {
    assert.equal(JSON.stringify(vector.plaintext), vector.plaintextUtf8);
    const envelope = await encryptEnvelope(vector.plaintext, {
      ...identity, sequence: vector.sequence, kind: vector.payloadKind,
      nonce: Buffer.from(vector.nonce, 'base64url'),
    });
    assert.deepEqual(envelope, wire(vector));
    assert.deepEqual(await decryptEnvelope(envelope, identity), vector.plaintext);
    assert.deepEqual(await decryptEnvelope(wire(vector), identity), vector.plaintext);
  });
}

test('services rejects changed channel, sequence, discriminator, key, nonce, ciphertext, and tag', async () => {
  const envelope = wire(services);
  await assert.rejects(decryptEnvelope(envelope, { ...identity, channelId: changedChannel }), errorCode('decryptionFailed'));
  await assert.rejects(decryptEnvelope(envelope, { ...identity, key: token }), errorCode('decryptionFailed'));
  const legacyAAD = { ...envelope };
  delete legacyAAD.payloadKind;
  for (const changed of [
    { ...envelope, sequence: 43 }, legacyAAD,
    { ...envelope, nonce: legacy.nonce },
    ...[0, -1].map((index) => {
      const bytes = Buffer.from(envelope.ciphertext, 'base64url');
      const position = index < 0 ? bytes.length + index : index;
      bytes[position] ^= 1;
      return { ...envelope, ciphertext: bytes.toString('base64url') };
    }),
  ]) await assert.rejects(decryptEnvelope(changed, identity), errorCode('decryptionFailed'));
  await assert.rejects(decryptEnvelope({ ...wire(legacy), payloadKind: 'services-v1' }, identity), errorCode('decryptionFailed'));
  // Legacy AAD deliberately does NOT bind sequence; do not invent a v1 change.
  assert.deepEqual(await decryptEnvelope({ ...wire(legacy), sequence: 43 }, identity), legacy.plaintext);
});

test('channel and bearer validation rejects noncanonical encodings and non-v4/lowercase UUIDs', () => {
  assert.doesNotThrow(() => validateChannel({ ...state, sequence: -10, relayUrl: 'ignored', other: 1n }));
  for (const channelId of [null, 4, legacy.channelId.toUpperCase(), `${legacy.channelId}\n`, changedChannel.replace('-4c15-', '-1c15-'), legacy.channelId.replace('-9e55-', '-7e55-'), '../snapshot']) {
    assert.throws(() => validateChannel({ ...state, channelId }), errorCode('invalidChannel'));
  }
  const invalid = [undefined, null, 4, '', `${legacy.key}=`, `${legacy.key}\n`, `${legacy.key.slice(0, -1)}d`,
    'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(10000), '+'.repeat(43), '/'.repeat(43)];
  for (const value of invalid) {
    assert.throws(() => validateChannel({ ...state, key: value }), errorCode('invalidChannel'));
    assert.throws(() => validateChannel({ ...state, publisherToken: value }), errorCode('invalidChannel'));
    assert.throws(() => pairingUri(legacy.channelId, value, legacy.key), errorCode('invalidChannel'));
  }
  for (const value of [null, undefined, [], 'state']) assert.throws(() => validateChannel(value), errorCode('invalidChannel'));
});

test('pairing URI has exactly the four protocol fields, never publisher token or origin', () => {
  assert.equal(DEFAULT_RELAY, 'https://statusline-relay.inmerzion.workers.dev');
  const uri = pairingUri(legacy.channelId, token, legacy.key);
  assert.equal(uri, `statusline://pair?v=1&channel=${legacy.channelId}&pairing=${token}&key=${legacy.key}`);
  const url = new URL(uri);
  assert.deepEqual([...url.searchParams.keys()], ['v', 'channel', 'pairing', 'key']);
  assert.ok(!uri.includes(state.publisherToken));
  assert.ok(!uri.includes(DEFAULT_RELAY));
});

test('production keys and nonces are canonical random bytes and envelopes do not expose keys', async () => {
  const keys = new Set(Array.from({ length: 16 }, newKey));
  assert.equal(keys.size, 16);
  for (const key of keys) assert.doesNotThrow(() => validateChannel({ ...state, key }));
  const nonces = new Set();
  for (let i = 0; i < 16; i++) {
    const envelope = await encryptEnvelope(services.plaintext, { ...options, sequence: i + 1 });
    assert.equal(Buffer.from(envelope.nonce, 'base64url').length, 12);
    nonces.add(envelope.nonce);
    assert.deepEqual(Object.keys(envelope), ['protocolVersion', 'payloadKind', 'sequence', 'nonce', 'ciphertext']);
    assert.deepEqual(await decryptEnvelope(envelope, identity), services.plaintext);
  }
  assert.equal(nonces.size, 16);
});

test('invalid sequence, kind, nonce, and envelope encodings are rejected before crypto', async () => {
  for (const sequence of [0, -1, 1.5, NaN, Infinity, '42', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(encryptEnvelope(services.plaintext, { ...options, sequence }), errorCode('invalidEnvelope'));
    await assert.rejects(decryptEnvelope({ ...wire(services), sequence }, identity), errorCode('invalidEnvelope'));
  }
  for (const kind of [null, '', 'legacy', 'services-v2']) {
    await assert.rejects(encryptEnvelope(services.plaintext, { ...options, kind }), errorCode('invalidEnvelope'));
  }
  for (const nonce of [null, [], new Uint8Array(11), new Uint8Array(13), services.nonce, new ArrayBuffer(12)]) {
    await assert.rejects(encryptEnvelope(services.plaintext, { ...options, nonce }), errorCode('invalidEnvelope'));
  }
  for (const changes of [
    { protocolVersion: '1' }, { protocolVersion: 2 }, { payloadKind: undefined }, { payloadKind: null },
    { payloadKind: 'services-v2' }, { nonce: `${services.nonce}=` }, { nonce: 'A'.repeat(15) },
    { ciphertext: Buffer.alloc(16).toString('base64url') }, { ciphertext: Buffer.alloc(4097).toString('base64url') },
    { ciphertext: `${services.ciphertextAndTag}=` }, { ciphertext: 'A'.repeat(100000) },
  ]) await assert.rejects(decryptEnvelope({ ...wire(services), ...changes }, identity), errorCode('invalidEnvelope'));
});

test('schemas enforce quota ranges, known window semantics, timestamps, uniqueness and ready/unavailable state', async () => {
  const mutations = [
    (p) => { p.schemaVersion = 2; }, (p) => { p.updatedAt = 0; }, (p) => { p.updatedAt = '1900000000'; },
    (p) => { p.providers = {}; }, (p) => { p.providers.push(p.providers[0]); },
    (p) => { p.providers[0].id = 'Codex'; }, (p) => { p.providers[0].id = 'codex\n'; },
    (p) => { p.providers[0].updatedAt = p.updatedAt + 1; }, (p) => { p.providers[0].updatedAt = null; },
    (p) => { p.providers[0].status = 'error'; }, (p) => { p.providers[0].status = 'unavailable'; },
    (p) => { p.providers[0].weekly = null; }, (p) => { delete p.providers[0].shortWindow; },
    (p) => { p.providers[0].weekly.remainingPercentage = 101; },
    (p) => { p.providers[0].weekly.remainingPercentage = -1; },
    (p) => { p.providers[0].weekly.remainingPercentage = 1.5; },
    (p) => { p.providers[0].weekly.remainingPercentage = '53'; },
    (p) => { p.providers[0].weekly.resetAt = NaN; },
    (p) => { p.providers[0].weekly.windowMinutes = 300; },
    (p) => { p.providers[1].shortWindow.windowMinutes = 10080; },
    (p) => { p.providers = Array.from({ length: 17 }, (_, i) => ({ id: `future-${i}` })); },
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(services.plaintext);
    mutate(payload);
    await assert.rejects(encryptEnvelope(payload, options), errorCode('invalidPayload'));
  }
  for (const changes of [{ remainingPercentage: -1 }, { remainingPercentage: 100.5 }, { remainingPercentage: 101 },
    { resetAt: 0 }, { updatedAt: Infinity }, { schemaVersion: '1' }]) {
    await assert.rejects(encryptEnvelope({ ...legacy.plaintext, ...changes }, { ...options, kind: undefined }), errorCode('invalidPayload'));
  }
});

test('empty, unavailable, Claude, boundary percentages and future adapter inventories round-trip', async () => {
  const unavailable = { id: 'codex', status: 'unavailable', updatedAt: services.plaintext.updatedAt, weekly: null, shortWindow: null };
  const boundaries = structuredClone(claude);
  boundaries.providers[0].weekly.remainingPercentage = 0;
  boundaries.providers[1].shortWindow.remainingPercentage = 100;
  for (const payload of [claude, boundaries,
    { ...services.plaintext, providers: [] },
    { ...services.plaintext, providers: [unavailable] },
    { ...services.plaintext, providers: [{ id: 'future-v2', futureSchema: { value: true } }] },
  ]) {
    assert.deepEqual(await decryptEnvelope(await encryptEnvelope(payload, options), identity), payload);
  }
});

test('payload bytes including GCM tag are bounded, and serialization/decryption errors stay safe', async () => {
  const base = { ...services.plaintext, padding: '' };
  const room = 4080 - Buffer.byteLength(JSON.stringify(base));
  const maximum = { ...base, padding: 'x'.repeat(room) };
  const envelope = await encryptEnvelope(maximum, options);
  assert.equal(Buffer.from(envelope.ciphertext, 'base64url').length, 4096);
  for (const payload of [
    { ...base, padding: 'x'.repeat(room + 1) }, { ...base, padding: '界'.repeat(room) },
    { ...base, toJSON() { throw new Error(token); } }, { ...base, toJSON() { return { secret: token }; } },
    { ...base, cycle: null },
  ]) {
    if (Object.hasOwn(payload, 'cycle')) payload.cycle = payload;
    await assert.rejects(encryptEnvelope(payload, options), errorCode('invalidPayload'));
  }
  for (const text of ['not JSON', '{}', JSON.stringify({ ...services.plaintext, schemaVersion: 2 }), Buffer.from([0xff, 0xfe])]) {
    await assert.rejects(decryptEnvelope(sealRaw(text), identity), errorCode('decryptionFailed'));
  }
});

test('legacy projection uses ONLY a ready Codex weekly sample, preserving its own sample time', () => {
  const inventory = structuredClone(claude);
  inventory.providers[0].updatedAt -= 100;
  assert.deepEqual(legacyProjection(inventory), {
    schemaVersion: 1, remainingPercentage: 53, resetAt: 1900500000, updatedAt: 1899999900,
  });
  assert.equal(legacyProjection({ ...inventory, providers: inventory.providers.slice(1) }), null);
  assert.equal(legacyProjection({ ...inventory, providers: [] }), null);
  inventory.providers[0].shortWindow = { ...inventory.providers[0].weekly, windowMinutes: 300 };
  inventory.providers[0].weekly = null;
  assert.equal(legacyProjection(inventory), null);
  inventory.providers[0].status = 'unavailable';
  inventory.providers[0].shortWindow = null;
  assert.equal(legacyProjection(inventory), null);
});
