#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StateStore } from './store.js';
import { RelayClient } from './relay.js';
import { DEFAULT_RELAY, newKey, pairingUri, decryptEnvelope, validateChannel } from './protocol.js';
import { safeError } from './bridge.js';

function options(argv) {
  const [command = 'help', ...rest] = argv;
  const result = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const name = { '--state-dir': 'stateDirectory', '--relay': 'relayUrl' }[rest[i]];
    if (!name || !rest[i + 1] || Object.hasOwn(result, name)) throw new Error('Invalid arguments');
    result[name] = rest[i + 1];
  }
  return result;
}

export function pairingPage(uri, expiresAt) {
  // The URI is built from protocol-validated URL-safe fields, never upstream HTML.
  const escaped = uri.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const expiry = new Date(expiresAt * 1000).toISOString();
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Statusline · Private pairing</title><style>body{font:16px system-ui;background:#11120f;color:#ece9dc;max-width:620px;margin:12vh auto;padding:24px}h1{color:#efc65a}input{box-sizing:border-box;width:100%;padding:14px;background:#22241d;color:inherit;border:1px solid #555;border-radius:8px}button{margin-top:16px;padding:12px 20px;border:0;border-radius:8px;background:#efc65a;font:inherit}p{line-height:1.7}.small{color:#b9b8ad;font-size:13px}</style><h1>Pair Statusline / 配对手机</h1><p>Open Statusline on your phone → Pair device → Paste private link.<br>在手机 App 中选择配对设备，粘贴下方私人链接。</p><input id="link" readonly value="${escaped}" aria-label="Private pairing link"><button id="copy">Copy private link / 复制配对链接</button><p id="result" role="status"></p><p>Expires / 到期：<time>${expiry}</time></p><p class="small">This page contains the encryption key. Keep it private; it never contacts a server. The link expires after ten minutes and can be claimed once.<br>本页含加密密钥，请勿分享或截图。此页面不会访问网络。</p><script>document.getElementById('copy').onclick=async()=>{const input=document.getElementById('link');input.select();try{await navigator.clipboard.writeText(input.value);document.getElementById('result').textContent='Copied / 已复制'}catch{document.getElementById('result').textContent='Press ⌘C or Ctrl+C / 请手动复制'}};</script></html>`;
}

export async function pair(store, relay) {
  return store.withLock(async () => {
    if (await store.read()) throw Object.assign(new Error('Already paired'), { code: 'already_configured' });
    const key = newKey();
    const created = await relay.createChannel();
    const state = { version: 1, relayUrl: relay.baseUrl, channelId: created.channelId,
      publisherToken: created.publisherToken, key, sequence: 0 };
    try {
      validateChannel(state);
      await store.write(state);
      const page = await store.writePairingPage(pairingPage(pairingUri(state.channelId, created.pairingToken, state.key), created.pairingExpiresAt));
      return { configured: true, pairingPage: page, expiresAt: created.pairingExpiresAt, next: 'Open the private page locally and paste its link into the mobile app. No token is printed here.' };
    } catch (error) {
      try { await relay.deleteChannel(state); await store.clear(); }
      catch {
        // Saved state remains usable by disconnect. If the initial disk write
        // also failed, the empty remote channel must expire without credentials.
        throw Object.assign(new Error('Pairing cleanup failed'), { code: 'pairing_cleanup_failed' });
      }
      throw error;
    }
  });
}

export async function liveSmoke(relay) {
  const key = newKey();
  const created = await relay.createChannel();
  const state = { relayUrl: relay.baseUrl, channelId: created.channelId, publisherToken: created.publisherToken, key };
  try {
    const now = Math.floor(Date.now() / 1000);
    const inventory = { schemaVersion: 1, updatedAt: now, providers: [
      { id: 'codex', status: 'ready', updatedAt: now,
        weekly: { remainingPercentage: 57, resetAt: now + 86400, windowMinutes: 10080 }, shortWindow: null },
      { id: 'antigravity', status: 'ready', updatedAt: now, weekly: null,
        shortWindow: { remainingPercentage: 73, resetAt: now + 3600, windowMinutes: 300 } },
    ] };
    const published = await relay.publish(state, inventory, Date.now());
    const reader = await relay.claim(state.channelId, created.pairingToken);
    const envelope = await relay.read(state.channelId, reader.readerToken);
    const plaintext = await decryptEnvelope(envelope, state);
    if (published.kind === 'services-v1') {
      if (JSON.stringify(plaintext) !== JSON.stringify(inventory)) throw new Error('Readback mismatch');
    } else if (plaintext.remainingPercentage !== 57 || plaintext.updatedAt !== now) throw new Error('Readback mismatch');
    return { ok: true, kind: published.kind, syntheticOnly: true, encryptedRoundTrip: true, cleanup: true };
  } finally { await relay.deleteChannel(state); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  const store = new StateStore(args.stateDirectory);
  switch (args.command) {
    case 'pair': return pair(store, new RelayClient({ baseUrl: args.relayUrl ?? DEFAULT_RELAY }));
    case 'status': {
      const state = await store.read();
      if (!state) return { configured: false };
      validateChannel(state);
      const remote = await new RelayClient({ baseUrl: state.relayUrl }).metadata(state);
      return { configured: true, phonePaired: remote.readerClaimedAt != null,
        lastPublishedAt: state.lastPublishedAt ?? null, capabilities: remote.capabilities ?? [] };
    }
    case 'disconnect': return store.withLock(async () => {
      const state = await store.read();
      if (state) { validateChannel(state); await new RelayClient({ baseUrl: state.relayUrl }).deleteChannel(state); }
      await store.clear();
      return { disconnected: true };
    });
    case 'smoke': return liveSmoke(new RelayClient({ baseUrl: args.relayUrl ?? DEFAULT_RELAY }));
    case 'help': return { usage: 'statusline-bridge pair|status|disconnect|smoke [--state-dir PATH] [--relay HTTPS_ORIGIN]',
      pair: 'Creates a private local pairing page. Never prints the key or URI.',
      smoke: 'Synthetic, temporary encrypted relay round trip; deletes its own channel.' };
    default: throw new Error('Unknown command');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, error: safeError(error) }));
    process.exitCode = 1;
  });
}
