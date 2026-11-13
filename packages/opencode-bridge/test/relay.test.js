import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RelayClient, RelayError } from '../src/relay.js';
import { DEFAULT_RELAY, decryptEnvelope, legacyProjection } from '../src/protocol.js';

// All credentials below are synthetic public-vector data. Tests never use fetch.
const fixture = async (name) => JSON.parse(await readFile(new URL(`../../../protocol/fixtures/${name}`, import.meta.url), 'utf8'));
const vector = await fixture('aes-gcm-services-v1.json');
const legacy = await fixture('aes-gcm-v1.json');
const baseUrl = 'https://relay.example';
const publisherToken = Buffer.alloc(32, 9).toString('base64url');
const pairingToken = Buffer.alloc(32, 8).toString('base64url');
const readerToken = Buffer.alloc(32, 10).toString('base64url');
const state = Object.freeze({ relayUrl: baseUrl, channelId: vector.channelId, key: vector.key, publisherToken, sequence: 42 });
const created = {
  protocolVersion: 1, channelId: vector.channelId, publisherToken, pairingToken,
  pairingExpiresAt: 1900000600, expiresAt: 1902592000,
};
const meta = {
  protocolVersion: 1, readerClaimedAt: null, pairingExpiresAt: 1900000600,
  lastPublishedAt: null, expiresAt: 1902592000, servicesLastPublishedAt: null,
  capabilities: ['services-v1'],
};
const health = { status: 'ok', protocolVersion: 1, capabilities: ['services-v1'] };
const wire = (v) => ({ protocolVersion: v.protocolVersion, ...(v.payloadKind ? { payloadKind: v.payloadKind } : {}),
  sequence: v.sequence, nonce: v.nonce, ciphertext: v.ciphertextAndTag });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const empty = (status = 201) => new Response(null, { status });

function mocked(responses, options = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, ...init });
    assert.ok(responses.length > 0, 'unexpected extra relay request');
    const response = responses.shift();
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { client: new RelayClient({ baseUrl, fetchImpl, ...options }), requests };
}

function safeError(code, status) {
  return (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    for (const secret of [publisherToken, pairingToken, readerToken, vector.key, vector.channelId, baseUrl, 'PRIVATE_DETAIL']) {
      assert.ok(!error.message.includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
    }
    return true;
  };
}

test('origins normalize without accepting credentials, URL suffixes, or insecure non-loopback transport', () => {
  assert.equal(new RelayClient({ fetchImpl() {} }).baseUrl, DEFAULT_RELAY);
  assert.equal(new RelayClient({ baseUrl: 'https://RELAY.example:443/', fetchImpl() {} }).baseUrl, baseUrl);
  for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://127.0.0.2:8080', 'http://[::1]:8080']) {
    assert.equal(new RelayClient({ baseUrl: url, allowLoopback: true, fetchImpl() {} }).baseUrl, url);
    assert.throws(() => new RelayClient({ baseUrl: url, fetchImpl() {} }), safeError('invalidConfiguration'));
  }
  for (const url of [null, '', 'file:///relay', '//relay.example', 'https:relay.example', 'http://relay.example',
    'http://localhost.evil.example', 'http://0.0.0.0', 'https://user:password@relay.example', 'https://@relay.example',
    `${baseUrl}/path`, `${baseUrl}/a/..`, `${baseUrl}//`, `${baseUrl}?`, `${baseUrl}#`, `${baseUrl}/?x=1`,
    `${baseUrl}/#x`, ` ${baseUrl}`, `${baseUrl}\n`, 'https://relay.example\\@evil.example', 'https://%72elay.example',
    `https://${'x'.repeat(2050)}.example`,
  ]) assert.throws(() => new RelayClient({ baseUrl: url, allowLoopback: true, fetchImpl() {} }), safeError('invalidConfiguration'));
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: Infinity },
    { timeoutMs: 2 ** 31 }, { timeoutMs: '100' }, { fetchImpl: null }, { allowLoopback: 'true' }, { signal: {} }]) {
    assert.throws(() => new RelayClient({ fetchImpl() {}, ...options }), safeError('invalidConfiguration'));
  }
  for (const options of [null, [], false, 'https://relay.example']) {
    assert.throws(() => new RelayClient(options), safeError('invalidConfiguration'));
  }
});

test('mock smoke performs exact routes, role credentials, media type and decryptable dual publication', async () => {
  const { client, requests } = mocked([
    json(health), json(created, 201), json(meta), empty(),
    json({ protocolVersion: 1, readerToken, expiresAt: created.expiresAt }, 201),
    json(wire(vector)), empty(204),
  ]);
  assert.deepEqual(await client.health(), health);
  assert.deepEqual(await client.createChannel(), created);
  assert.deepEqual(await client.publish(state, vector.plaintext, 42), { kind: 'services-v1' });
  assert.deepEqual(await client.claim(vector.channelId, pairingToken), { protocolVersion: 1, readerToken, expiresAt: created.expiresAt });
  assert.deepEqual(await decryptEnvelope(await client.read(vector.channelId, readerToken), state), vector.plaintext);
  assert.equal(await client.deleteChannel(state), undefined);
  const prefix = `/v1/channels/${state.channelId}`;
  assert.deepEqual(requests.map((request) => [new URL(request.url).pathname, request.method]), [
    ['/health', 'GET'], ['/v1/channels', 'POST'], [prefix, 'GET'], [`${prefix}/services`, 'PUT'],
    [`${prefix}/claim`, 'POST'], [`${prefix}/snapshot`, 'GET'], [prefix, 'DELETE'],
  ]);
  assert.deepEqual(requests.map((request) => request.headers.Authorization), [undefined, undefined,
    `Bearer ${publisherToken}`, `Bearer ${publisherToken}`, `Bearer ${pairingToken}`, `Bearer ${readerToken}`, `Bearer ${publisherToken}`]);
  for (const request of requests) {
    assert.equal(request.redirect, 'manual');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.cache, 'no-store');
    assert.ok(request.signal instanceof AbortSignal);
    assert.ok(!request.url.includes(publisherToken));
    assert.ok(!JSON.stringify({ headers: request.headers, body: request.body }).includes(vector.key));
  }
  assert.equal(requests[3].headers['Content-Type'], 'application/json');
  assert.equal(requests[5].headers.Accept, 'application/vnd.statusline.services-v1+json');
  const publication = JSON.parse(requests[3].body);
  assert.deepEqual(Object.keys(publication), ['services', 'codex']);
  assert.equal(publication.services.sequence, 42);
  assert.equal(publication.codex.sequence, 42);
  assert.notEqual(publication.services.nonce, publication.codex.nonce);
  assert.deepEqual(await decryptEnvelope(publication.services, state), vector.plaintext);
  assert.deepEqual(await decryptEnvelope(publication.codex, state), legacyProjection(vector.plaintext));
  assert.equal(state.sequence, 42, 'sequence persistence belongs to the caller');
});

test('services publications preserve absent Codex as null, including empty inventories', async () => {
  for (const providers of [[], vector.plaintext.providers.slice(1)]) {
    const { client, requests } = mocked([json(meta), empty()]);
    const inventory = { ...vector.plaintext, providers };
    assert.deepEqual(await client.publish(state, inventory, 43), { kind: 'services-v1' });
    const body = JSON.parse(requests[1].body);
    assert.equal(body.codex, null);
    assert.deepEqual(await decryptEnvelope(body.services, state), inventory);
  }
});

test('every publication renegotiates authenticated metadata and uses fresh independent nonces', async () => {
  const oldMetadata = { ...meta };
  delete oldMetadata.capabilities;
  delete oldMetadata.servicesLastPublishedAt;
  const { client, requests } = mocked([json(meta), empty(), json(meta), empty(), json(oldMetadata), empty()]);
  await client.publish(state, vector.plaintext, 42);
  await client.publish(state, vector.plaintext, 43);
  assert.deepEqual(await client.publish(state, vector.plaintext, 44), { kind: 'legacy' });
  assert.equal(requests.length, 6);
  assert.ok(requests[4].url.endsWith(state.channelId));
  assert.ok(requests[5].url.endsWith('/snapshot'));
  const a = JSON.parse(requests[1].body);
  const b = JSON.parse(requests[3].body);
  const c = JSON.parse(requests[5].body);
  assert.equal(new Set([a.services.nonce, a.codex.nonce, b.services.nonce, b.codex.nonce, c.nonce]).size, 5);
  assert.equal(c.sequence, 44);
  assert.equal(Object.hasOwn(c, 'payloadKind'), false);
  assert.deepEqual(await decryptEnvelope(c, state), legacyProjection(vector.plaintext));
});

test('health capabilities do not substitute for metadata and unsupported services never relabel Gemini', async () => {
  const oldMetadata = { ...meta, capabilities: [] };
  const { client, requests } = mocked([json(health), json(oldMetadata)]);
  await client.health();
  const gemini = { ...vector.plaintext, providers: vector.plaintext.providers.slice(1) };
  await assert.rejects(client.publish(state, gemini, 43), safeError('legacyUnavailable'));
  assert.equal(requests.length, 2);
  const emptyInventory = mocked([json(oldMetadata)]);
  await assert.rejects(emptyInventory.client.publish(state, { ...gemini, providers: [] }, 43), safeError('legacyUnavailable'));
  const noCapability = mocked([json({ ...meta, capabilities: ['future-v9'] }), empty()]);
  assert.deepEqual(await noCapability.client.publish(state, vector.plaintext, 43), { kind: 'legacy' });
});

test('invalid or cross-origin credentials and payloads are rejected before any network request', async () => {
  const { client, requests } = mocked([]);
  for (const bad of [{ ...state, relayUrl: 'https://other.example' }, { ...state, relayUrl: 'https://relay.example:444' }]) {
    await assert.rejects(client.metadata(bad), safeError('credentialOriginMismatch'));
    await assert.rejects(client.publish(bad, vector.plaintext, 42), safeError('credentialOriginMismatch'));
    await assert.rejects(client.deleteChannel(bad), safeError('credentialOriginMismatch'));
  }
  for (const bad of [{ ...state, relayUrl: undefined }, { ...state, relayUrl: `${baseUrl}/path` },
    { ...state, channelId: state.channelId.toUpperCase() }, { ...state, publisherToken: 'bad' }, { ...state, key: 'bad' }]) {
    await assert.rejects(client.metadata(bad), safeError('invalidState'));
  }
  await assert.rejects(client.claim(state.channelId, 'bad'), safeError('invalidState'));
  await assert.rejects(client.read('../snapshot', readerToken), safeError('invalidState'));
  await assert.rejects(client.publish(state, vector.plaintext, 0), safeError('invalidPayload'));
  await assert.rejects(client.publish(state, { ...vector.plaintext, huge: 'x'.repeat(20000) }, 43), safeError('invalidPayload'));
  assert.equal(requests.length, 0);
  const normalized = mocked([json(meta)]);
  await normalized.client.metadata({ ...state, relayUrl: 'https://RELAY.example:443/' });
  assert.equal(normalized.requests.length, 1);
  assert.throws(() => { client.baseUrl = 'https://other.example'; }, TypeError);
});

test('complete create and claim response validation is strict and never retries creation', async () => {
  for (const changes of [{ protocolVersion: 2 }, { protocolVersion: '1' }, { channelId: state.channelId.toUpperCase() },
    { publisherToken: `${publisherToken}=` }, { pairingToken: publisherToken }, { pairingToken: undefined },
    { pairingExpiresAt: 0 }, { pairingExpiresAt: '1900000600' }, { expiresAt: created.pairingExpiresAt },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { client, requests } = mocked([json({ ...created, ...changes }, 201)]);
    await assert.rejects(client.createChannel(), safeError('invalidResponse'));
    assert.equal(requests.length, 1);
  }
  for (const changes of [{ protocolVersion: 2 }, { readerToken: pairingToken }, { readerToken: 'bad' }, { expiresAt: null }]) {
    const { client } = mocked([json({ protocolVersion: 1, readerToken, expiresAt: created.expiresAt, ...changes }, 201)]);
    await assert.rejects(client.claim(state.channelId, pairingToken), safeError('invalidResponse'));
  }
  const limited = mocked([json({ error: { code: 'rateLimited', message: publisherToken } }, 429)]);
  await assert.rejects(limited.client.createChannel(), safeError('rateLimited', 429));
  assert.equal(limited.requests.length, 1);
});

test('health and metadata schemas reject malformed types and omit unrecognized response fields', async () => {
  for (const bad of [null, [], {}, { ...health, status: 'down' }, { ...health, protocolVersion: 2 },
    { ...health, capabilities: 'services-v1' }, { ...health, capabilities: null },
    { ...health, capabilities: ['services-v1', 'services-v1'] }, { ...health, capabilities: [1] },
    { ...health, capabilities: ['services-v1\n'] }]) {
    await assert.rejects(mocked([json(bad)]).client.health(), safeError('invalidResponse'));
  }
  assert.deepEqual(await mocked([json({ status: 'ok', protocolVersion: 1 })]).client.health(), { status: 'ok', protocolVersion: 1, capabilities: [] });
  assert.deepEqual(await mocked([json({ ...health, capabilities: ['future-v2', 'services-v1'], private: 'PRIVATE_DETAIL' })]).client.health(), health);
  for (const changes of [{ protocolVersion: 2 }, { readerClaimedAt: undefined }, { lastPublishedAt: '1900000000' },
    { servicesLastPublishedAt: 0 }, { expiresAt: null }, { pairingExpiresAt: -1 }, { capabilities: {} }]) {
    await assert.rejects(mocked([json({ ...meta, ...changes })]).client.metadata(state), safeError('invalidResponse'));
  }
  assert.deepEqual(await mocked([json({ ...meta, private: publisherToken })]).client.metadata(state), meta);
  assert.deepEqual(await mocked([json({ ...created, private: publisherToken }, 201)]).client.createChannel(), created);
});

test('read validates envelope framing, canonical encodings and bounds, with legacy fallback', async () => {
  assert.deepEqual(await mocked([json(wire(legacy))]).client.read(state.channelId, readerToken), wire(legacy));
  assert.deepEqual(await mocked([json(wire(vector), 200, { 'Content-Type': 'application/vnd.statusline.services-v1+json' })])
    .client.read(state.channelId, readerToken), wire(vector));
  for (const changes of [{ protocolVersion: 2 }, { protocolVersion: '1' }, { sequence: 0 }, { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }, { payloadKind: null }, { payloadKind: 'services-v2' },
    { nonce: `${vector.nonce}=` }, { nonce: 'A'.repeat(15) }, { ciphertext: 'A'.repeat(22) },
    { ciphertext: Buffer.alloc(4097).toString('base64url') }, { ciphertext: `${vector.ciphertextAndTag}=` }]) {
    await assert.rejects(mocked([json({ ...wire(vector), ...changes })]).client.read(state.channelId, readerToken), safeError('invalidResponse'));
  }
});

test('redirects, including already-followed and opaque redirects, are never accepted or retried', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { client, requests } = mocked([new Response(null, { status, headers: { Location: 'https://other.example' } })]);
    await assert.rejects(client.metadata(state), safeError('redirect'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].redirect, 'manual');
  }
  for (const properties of [{ redirected: true }, { type: 'opaqueredirect' },
    { url: 'https://other.example/health' }, { url: `${baseUrl}/other` }]) {
    const response = json(health);
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, { value });
    await assert.rejects(mocked([response]).client.health(), safeError('redirect'));
  }
});

test('responses are bounded with or without honest Content-Length, and oversized streams are cancelled', async () => {
  for (const status of [200, 429]) {
    const declared = json(status === 200 ? health : {}, status, { 'Content-Length': '16385' });
    await assert.rejects(mocked([declared]).client.health(), safeError('responseTooLarge'));
    for (const headers of [{}, { 'Content-Length': '2' }]) {
      let cancelled = false;
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(10000)); controller.enqueue(new Uint8Array(6385)); },
        cancel() { cancelled = true; },
      });
      const response = new Response(body, { status, headers: { 'Content-Type': 'application/json', ...headers } });
      await assert.rejects(mocked([response]).client.health(), safeError('responseTooLarge'));
      assert.equal(cancelled, true);
    }
  }
  const text = JSON.stringify(health);
  const exact = `${text}${' '.repeat(16384 - Buffer.byteLength(text))}`;
  assert.deepEqual(await mocked([new Response(exact, { headers: { 'Content-Type': 'application/json' } })]).client.health(), health);
});

test('invalid JSON, UTF-8, content types, Content-Length, and unexpected success statuses fail safely', async () => {
  for (const response of [new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(Buffer.from([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(health)), json(health, 202), json(health, 200, { 'Content-Length': 'invalid' }),
    json(health, 200, { 'Content-Type': 'text/html' }),
    json(health, 200, { 'Content-Type': 'application/vnd.statusline.services-v1+json' }),
  ]) await assert.rejects(mocked([response]).client.health(), safeError('invalidResponse'));
  await assert.rejects(mocked([json(meta), json({}, 201)]).client.publish(state, vector.plaintext, 42), safeError('invalidResponse'));
});

test('HTTP errors expose only allowlisted codes, fixed messages and bounded Retry-After values', async () => {
  const cases = [[400, 'invalidRequest'], [404, 'channelNotFound'], [404, 'snapshotNotFound'],
    [410, 'channelExpired'], [410, 'pairingExpired'], [409, 'staleSnapshot'], [429, 'rateLimited'], [500, 'internalError']];
  for (const [status, code] of cases) {
    const response = json({ error: { code, message: `${publisherToken} PRIVATE_DETAIL ${baseUrl}` } }, status);
    await assert.rejects(mocked([response]).client.health(), safeError(code, status));
  }
  const malicious = mocked([json({ error: { code: publisherToken, message: 'PRIVATE_DETAIL' } }, 400)]);
  await assert.rejects(malicious.client.health(), safeError('httpError', 400));
  await assert.rejects(mocked([new Response('PRIVATE_DETAIL', { status: 503 })]).client.health(), safeError('internalError', 503));
  for (const [header, expected] of [['60', 60000], ['0', 0], ['9999999999', 86400000], ['-1', undefined],
    ['1.5', undefined], ['PRIVATE_DETAIL', undefined], ['Wed, 01 Jan 2020 00:00:00 GMT', 0]]) {
    const response = json({ error: { code: 'rateLimited' } }, 429, { 'Retry-After': header });
    await assert.rejects(mocked([response]).client.health(), (error) => {
      safeError('rateLimited', 429)(error);
      assert.equal(error.retryAfterMs, expected);
      return true;
    });
  }
  const future = new Date(Date.now() + 120000).toUTCString();
  await assert.rejects(mocked([json({}, 503, { 'Retry-After': future })]).client.health(), (error) => {
    safeError('internalError', 503)(error);
    assert.ok(error.retryAfterMs > 118000 && error.retryAfterMs <= 120000);
    return true;
  });
  const unsafe = new RelayError(publisherToken, { status: 'PRIVATE_DETAIL', retryAfterMs: Infinity });
  assert.ok(safeError('httpError')(unsafe));
  assert.equal(unsafe.status, undefined);
  assert.ok(safeError('httpError')(new RelayError({ toString: () => 'timeout', detail: publisherToken })));
});

test('delete treats 404 as already gone but does not swallow expiry, timeout or redirects', async () => {
  assert.equal(await mocked([json({ error: { code: 'channelNotFound' } }, 404)]).client.deleteChannel(state), undefined);
  await assert.rejects(mocked([json({ error: { code: 'channelExpired' } }, 410)]).client.deleteChannel(state), safeError('channelExpired', 410));
  await assert.rejects(mocked([new Response(null, { status: 302 })]).client.deleteChannel(state), safeError('redirect'));
});

test('network exceptions are sanitized, not retried, and carry no original cause', async () => {
  const { client, requests } = mocked([() => { throw new Error(`${publisherToken} PRIVATE_DETAIL`); }]);
  await assert.rejects(client.createChannel(), safeError('networkError'));
  assert.equal(requests.length, 1);
});

test('timeout covers uncooperative fetches, aborts the request and cancels a late response', async () => {
  let resolveFetch;
  const { client, requests } = mocked([() => new Promise((resolve) => { resolveFetch = resolve; })], { timeoutMs: 15 });
  await assert.rejects(client.health(), safeError('timeout'));
  assert.equal(requests[0].signal.aborted, true);
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  resolveFetch(new Response(body));
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
  assert.equal(requests.length, 1);
});

test('timeout also bounds a stalled streaming body and releases its reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'application/json' } });
  const external = new AbortController();
  const { client } = mocked([response], { timeoutMs: 15, signal: external.signal });
  await assert.rejects(client.health(), safeError('timeout'));
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
  assert.equal(external.signal.aborted, false, 'request timeouts must not cancel the caller signal');
});

test('external unload signal prevents requests, interrupts fetch/body, and never leaks its abort reason', async () => {
  const stopped = new AbortController();
  stopped.abort(new Error(publisherToken));
  const inactive = mocked([], { signal: stopped.signal });
  await assert.rejects(inactive.client.metadata(state), safeError('aborted'));
  await assert.rejects(inactive.client.publish(state, vector.plaintext, 42), safeError('aborted'));
  assert.equal(inactive.requests.length, 0);

  const fetching = new AbortController();
  const pending = mocked([() => {
    queueMicrotask(() => fetching.abort(new Error('PRIVATE_DETAIL')));
    return new Promise(() => {});
  }], { signal: fetching.signal });
  await assert.rejects(pending.client.metadata(state), safeError('aborted'));
  assert.equal(pending.requests[0].signal.aborted, true);

  const streaming = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() { streaming.abort(new Error(publisherToken)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(mocked([response], { signal: streaming.signal }).client.health(), safeError('aborted'));
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
