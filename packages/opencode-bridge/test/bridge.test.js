import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge, inventoryHash, safeError } from '../src/bridge.js';
import { StateStore } from '../src/store.js';

const channelId = '11111111-1111-4111-8111-111111111111';
const key = Buffer.alloc(32, 7).toString('base64url');
const initial = { version: 1, channelId, key, publisherToken: key, relayUrl: 'https://relay.example', sequence: 0 };
const sample = time => ({ snapshot: { version: 6, providers: [{ providerId: 'openai', okAtMs: time, rows: [
  { id: 'openai.weekly', providerId: 'openai', label: 'Weekly', type: 'quota', method: 'remote_api', authority: 'provider_reported', window: 'week', percentRemaining: 57, resetsAt: new Date(time + 86400000).toISOString() },
] }] } });

test('sampling time, not poll time, controls dedupe across restart and locations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-bridge-'));
  const store = new StateStore(dir);
  let time = 1900000000000, calls = 0;
  const snapshot = sample(time);
  try {
    await store.withLock(() => store.write(initial));
    const create = () => createBridge({ store, now: () => time, readQuota: async () => snapshot,
      makeRelay: () => ({ publish: async (_state, _inventory, sequence) => {
        assert.equal(_inventory.providers[0].weekly.remainingPercentage, 57);
        calls++; assert.equal((await store.read()).sequence, sequence); return { kind: 'services-v1' };
      } }) });
    const first = create();
    assert.equal((await first.tick()).state, 'published');
    const observer = create();
    assert.equal((await observer.status()).state, 'published_elsewhere');
    assert.equal((await observer.status()).lastPublishedAt, time);
    await observer.dispose();
    time += 60000;
    assert.equal((await first.tick()).state, 'unchanged');
    await first.dispose();
    const restarted = create();
    assert.equal((await restarted.tick()).state, 'unchanged');
    assert.equal(calls, 1);
    snapshot.snapshot.providers[0].okAtMs += 60000;
    assert.equal((await restarted.tick()).state, 'published');
    assert.equal(calls, 2);
    await restarted.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unpaired plugin never reads quota or contacts relay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-unpaired-'));
  try {
    const bridge = createBridge({ store: new StateStore(dir), readQuota: () => assert.fail('quota'), makeRelay: () => assert.fail('relay') });
    assert.equal((await bridge.tick()).state, 'unpaired');
    await bridge.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unload aborts an in-flight cache read and releases the lock without publishing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-cancel-'));
  const store = new StateStore(dir);
  try {
    await store.withLock(() => store.write(initial));
    let started;
    const ready = new Promise(r => { started = r; });
    const bridge = createBridge({ store, readQuota: signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); started();
    }), makeRelay: () => assert.fail('relay after dispose') });
    const flight = bridge.tick();
    await ready;
    await bridge.dispose(); await flight;
    await store.withLock(() => assert.ok(true));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dedupe excludes observation timestamp but includes provider freshness', () => {
  assert.equal(inventoryHash({ updatedAt: 1, providers: [] }), inventoryHash({ updatedAt: 2, providers: [] }));
  assert.notEqual(inventoryHash({ providers: [{ updatedAt: 1 }] }), inventoryHash({ providers: [{ updatedAt: 2 }] }));
});

test('failed publication retains last success, reserves sequence and shares backoff across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-retry-'));
  const store = new StateStore(dir);
  let time = 1900000000000, calls = 0;
  const snapshot = sample(time);
  const make = () => createBridge({ store, now: () => time, readQuota: async () => snapshot,
    makeRelay: () => ({ publish: async () => {
      if (++calls === 1) throw Object.assign(new Error('private upstream prose'), { code: 'rateLimited', retryAfterMs: 120000 });
      return { kind: 'services-v1' };
    } }) });
  try {
    await store.withLock(() => store.write({ ...initial, lastHash: 'previous', lastPublishedAt: time - 60000 }));
    const first = make();
    assert.equal((await first.tick()).error, 'rateLimited');
    const failed = await store.read();
    assert.equal(failed.lastHash, 'previous');
    assert.equal(failed.sequence, time);
    assert.equal(failed.retryAtMs, time + 120000);
    await first.dispose();
    const restarted = make();
    assert.equal((await restarted.tick()).state, 'backoff');
    assert.equal(calls, 1);
    time += 120000;
    assert.equal((await restarted.tick()).state, 'published');
    const success = await store.read();
    assert.ok(success.sequence > failed.sequence);
    assert.equal(success.retryAtMs, 0);
    assert.notEqual(success.lastHash, 'previous');
    await restarted.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source-scope binding prevents a different location replacing the paired cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-scope-'));
  const store = new StateStore(dir);
  const snapshot = sample(1900000000000);
  snapshot.snapshot.sourceScope = 'synthetic-scope-a';
  let calls = 0;
  const bridge = createBridge({ store, now: () => 1900000000000, readQuota: async () => snapshot,
    makeRelay: () => ({ publish: async () => { calls++; return { kind: 'services-v1' }; } }) });
  try {
    await store.withLock(() => store.write(initial));
    await bridge.tick();
    snapshot.snapshot.sourceScope = 'synthetic-scope-b';
    assert.equal((await bridge.tick()).error, 'source_scope_changed');
    assert.equal(calls, 1);
    assert.equal((await store.read()).sourceScope, 'synthetic-scope-a');
  } finally { await bridge.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('concurrent runtimes cannot publish the same sample twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-concurrent-'));
  const store = new StateStore(dir);
  let release, acquired, calls = 0;
  const ready = new Promise(r => { acquired = r; });
  const make = () => createBridge({ store, now: () => 1900000000000, readQuota: async () => sample(1900000000000),
    makeRelay: () => ({ publish: async () => {
      calls++; acquired(); await new Promise(r => { release = r; }); return { kind: 'services-v1' };
    } }) });
  const first = make(), second = make();
  try {
    await store.withLock(() => store.write(initial));
    const flight = first.tick();
    await ready;
    await second.tick();
    release(); await flight;
    assert.equal((await second.tick()).state, 'unchanged');
    assert.equal(calls, 1);
  } finally { await first.dispose(); await second.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('unload bounds an uncooperative RPC and status rejects arbitrary error codes', async () => {
  assert.equal(safeError({ code: 'a_private_account_name' }), 'bridge_failed');
  const dir = await mkdtemp(join(tmpdir(), 'statusline-stuck-'));
  const store = new StateStore(dir);
  let started;
  const ready = new Promise(r => { started = r; });
  const bridge = createBridge({ store, readQuota: () => { started(); return new Promise(() => {}); } });
  try {
    await store.withLock(() => store.write(initial));
    void bridge.tick(); await ready;
    await bridge.dispose();
    await store.withLock(() => assert.ok(true));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing source stays unavailable across restart until explicitly removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-missing-'));
  const store = new StateStore(dir);
  let snapshot = sample(1900000000000);
  const publications = [];
  const make = services => createBridge({ store, services, now: () => 1900000000000,
    readQuota: async () => snapshot, makeRelay: () => ({ publish: async (_state, inventory) => {
      publications.push(inventory); return { kind: 'services-v1' };
    } }) });
  try {
    await store.withLock(() => store.write(initial));
    const first = make(); await first.tick(); await first.dispose();
    snapshot = { snapshot: { version: 6, providers: [] } };
    const second = make(); await second.tick(); await second.dispose();
    assert.equal(publications[1].providers[0].id, 'codex');
    assert.equal(publications[1].providers[0].status, 'unavailable');
    assert.equal(publications[1].providers[0].updatedAt, 1900000000);
    const removed = make([]); await removed.tick(); await removed.dispose();
    assert.deepEqual(publications[2].providers, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lost acknowledgement cannot dedupe against a superseded successful hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'statusline-uncertain-'));
  const store = new StateStore(dir);
  let time = 1900000000000, calls = 0, remotePercentage;
  const snapshot = sample(time);
  const make = () => createBridge({ store, now: () => time, readQuota: async () => snapshot,
    makeRelay: () => ({ publish: async (_state, inventory) => {
      remotePercentage = inventory.providers[0].weekly.remainingPercentage;
      if (++calls === 2) throw Object.assign(new Error('response lost after acceptance'), { code: 'timeout' });
      return { kind: 'services-v1' };
    } }) });
  try {
    await store.withLock(() => store.write(initial));
    const first = make(); await first.tick();
    snapshot.snapshot.providers[0].rows[0].percentRemaining = 40;
    await first.tick(); await first.dispose();
    assert.equal(remotePercentage, 40);
    assert.equal((await store.read()).pendingPublication, true);
    snapshot.snapshot.providers[0].rows[0].percentRemaining = 57;
    time += 60000;
    const restarted = make();
    assert.equal((await restarted.tick()).state, 'published');
    assert.equal(remotePercentage, 57);
    assert.equal(calls, 3);
    assert.equal((await store.read()).pendingPublication, false);
    await restarted.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
