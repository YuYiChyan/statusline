import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/store.js';
import { pair, liveSmoke } from '../src/cli.js';
import { encryptEnvelope } from '../src/protocol.js';

const channelId = '11111111-1111-4111-8111-111111111111';
const token = Buffer.alloc(32, 1).toString('base64url');
const pairingToken = Buffer.alloc(32, 2).toString('base64url');
const created = { channelId, publisherToken: token, pairingToken, pairingExpiresAt: 1900000600 };

test('pairing stores credentials privately, never prints the link, and cannot overwrite an existing channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-pair-'));
  const store = new StateStore(dir);
  let calls = 0;
  const relay = { baseUrl: 'https://relay.example', createChannel: async () => { calls++; return created; } };
  try {
    const result = await pair(store, relay);
    const state = await store.read();
    assert.equal(state.channelId, channelId);
    assert.equal(state.pairingToken, undefined);
    for (const privateValue of [token, pairingToken, state.key]) assert.ok(!JSON.stringify(result).includes(privateValue));
    assert.match(await readFile(result.pairingPage, 'utf8'), /statusline:\/\/pair\?v=1/);
    if (process.platform !== 'win32') assert.equal((await stat(result.pairingPage)).mode & 0o777, 0o600);
    await assert.rejects(pair(store, relay), { code: 'already_configured' });
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed pairing-page write deletes its new channel and clears saved state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-pair-fail-'));
  const store = new StateStore(dir);
  let deleted = false;
  store.writePairingPage = async () => { throw Error('disk failure'); };
  try {
    await assert.rejects(pair(store, { baseUrl: 'https://relay.example', createChannel: async () => created,
      deleteChannel: async state => { assert.equal(state.channelId, channelId); deleted = true; } }));
    assert.ok(deleted);
    assert.equal(await store.read(), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('smoke validates encrypted readback and always deletes only its own temporary channel', async () => {
  for (const fail of [false, true]) {
    let envelope, deleted = false;
    const relay = { baseUrl: 'https://relay.example', createChannel: async () => created,
      publish: async (state, inventory, sequence) => {
        assert.equal(state.relayUrl, relay.baseUrl);
        envelope = await encryptEnvelope(inventory, { ...state, sequence, kind: 'services-v1' });
        return { kind: 'services-v1' };
      }, claim: async () => ({ readerToken: token }), read: async () => { if (fail) throw Error('unavailable'); return envelope; },
      deleteChannel: async state => { assert.equal(state.channelId, channelId); deleted = true; } };
    if (fail) await assert.rejects(liveSmoke(relay));
    else assert.equal((await liveSmoke(relay)).encryptedRoundTrip, true);
    assert.ok(deleted);
  }
});

test('initial disk and remote cleanup failure returns a fixed safe cleanup error', async () => {
  const store = { withLock: operation => operation(), read: async () => undefined,
    write: async () => { throw Error('private disk path'); } };
  await assert.rejects(pair(store, { baseUrl: 'https://relay.example', createChannel: async () => created,
    deleteChannel: async () => { throw Error('private remote failure'); } }), { code: 'pairing_cleanup_failed' });
});
