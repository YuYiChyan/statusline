import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/store.js';

test('atomic private state and exclusive cross-instance lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'statusline-store-'));
  try {
    const a = new StateStore(directory), b = new StateStore(directory);
    let release;
    let acquired;
    const ready = new Promise(r => { acquired = r; });
    const hold = a.withLock(async () => {
      await a.write({ version: 1, relayUrl: 'https://relay.example', sequence: 1 });
      acquired();
      await new Promise(r => { release = r; });
    });
    await ready;
    await assert.rejects(b.withLock(() => assert.fail('second writer acquired')), { code: 'busy' });
    release(); await hold;
    await b.withLock(async () => { assert.equal((await b.read()).sequence, 1); await b.write({ version: 1, relayUrl: 'https://relay.example', sequence: 2 }); });
    assert.equal((await a.read()).sequence, 2);
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, 'publisher.json'))).mode & 0o777, 0o600);
    }
    await a.withLock(() => a.clear());
    assert.equal(await b.read(), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dead owner recovery keeps a nonempty tombstone against competing recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'statusline-recovery-'));
  try {
    const token = '11111111-1111-4111-8111-111111111111';
    await mkdir(join(directory, 'publisher.lock'));
    await writeFile(join(directory, 'publisher.lock', 'owner.json'), JSON.stringify({ pid: 2147483647, token }));
    const store = new StateStore(directory);
    await store.withLock(() => store.write({ version: 1, relayUrl: 'https://relay.example', sequence: 3 }));
    assert.equal((await store.read()).sequence, 3);
    assert.ok((await stat(join(directory, `.retired-${token}`, 'owner.json'))).isFile());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
