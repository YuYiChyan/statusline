import { mkdir, readFile, writeFile, rename, rm, lstat, chmod, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export class StoreError extends Error {
  constructor(code) { super(code); this.name = 'StoreError'; this.code = code; }
}

export function defaultStateDirectory() {
  return process.env.STATUSLINE_BRIDGE_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'statusline-bridge');
}

/** State is shared across OpenCode locations and the local pairing CLI. */
export class StateStore {
  constructor(directory = defaultStateDirectory()) { this.directory = resolve(directory); }

  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StoreError('invalid_state_directory');
    await chmod(this.directory, 0o700);
  }

  async read() {
    try {
      const file = join(this.directory, 'publisher.json');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new StoreError('invalid_state');
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data?.version !== 1 || !Number.isSafeInteger(data.sequence) || data.sequence < 0 || typeof data.relayUrl !== 'string') throw new StoreError('invalid_state');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      if (error instanceof StoreError) throw error;
      throw new StoreError('invalid_state');
    }
  }

  async write(state) {
    const temp = join(this.directory, `.state-${randomUUID()}`);
    try {
      const fd = await open(temp, 'wx', 0o600);
      try { await fd.writeFile(JSON.stringify(state) + '\n'); await fd.sync(); } finally { await fd.close(); }
      await rename(temp, join(this.directory, 'publisher.json'));
    } finally { await rm(temp, { force: true }); }
  }

  async clear() {
    await rm(join(this.directory, 'publisher.json'), { force: true });
    await rm(join(this.directory, 'pairing.html'), { force: true });
  }

  async writePairingPage(html) {
    const path = join(this.directory, 'pairing.html');
    await rm(path, { force: true });
    await writeFile(path, html, { mode: 0o600, flag: 'wx' });
    return path;
  }

  async withLock(operation) {
    await this.prepare();
    const token = randomUUID();
    const candidate = join(this.directory, `.candidate-${token}`);
    const lock = join(this.directory, 'publisher.lock');
    await mkdir(candidate, { mode: 0o700 });
    await writeFile(join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' });
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await rename(candidate, lock); acquired = true; break; }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
          let owner;
          try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); } catch { throw new StoreError('busy'); }
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[0-9a-f-]{36}$/.test(owner.token)) throw new StoreError('busy');
          try { process.kill(owner.pid, 0); throw new StoreError('busy'); }
          catch (error) { if (error.code !== 'ESRCH') throw new StoreError('busy'); }
          // A nonempty tombstone is retained: a second stale-lock observer cannot
          // accidentally rename a newly acquired lock over this destination.
          try { await rename(lock, join(this.directory, `.retired-${owner.token}`)); }
          catch { throw new StoreError('busy'); }
        }
      }
      if (!acquired) throw new StoreError('busy');
      return await operation();
    } finally {
      if (acquired) await rm(lock, { recursive: true, force: true });
      await rm(candidate, { recursive: true, force: true });
    }
  }
}
