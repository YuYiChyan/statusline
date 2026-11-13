# Bridge implementation contract — v0.1

This fork adds an independent, server-only OpenCode 2.2.7+ plugin. Its Git-install
entry is the root package.json. No desktop/mobile/relay changes are required.
Upstream protocol fixtures in protocol/ are authoritative. No personal data or
local state may be committed. Use native ES modules and Node built-ins; the only
runtime package is OpenCode's plugin SDK. Tests use node:test.

## Modules / ownership

- protocol.js, relay.js and their tests: protocol worker.
- normalize.js, quota-rpc.js and their tests: quota worker.
- store.js, bridge.js, index.js, cli.js, scripts, docs: orchestrator.

## Shared shapes and APIs

State (private local file): `{version:1, relayUrl, channelId, publisherToken, key,
sequence, lastHash?, lastPublishedAt?, sourceScope?}`. Tokens/key use canonical
unpadded base64url (32 bytes). No provider credentials are read or stored.
No pairing token is retained in state; the CLI may create a private pairing page
with its expiry. A lock serializes all CLI/plugin instances using the same state.

`protocol.js` exports:
- `DEFAULT_RELAY = 'https://statusline-relay.inmerzion.workers.dev'`
- `newKey(): string`, `validateChannel(state): void` (only channelId, publisherToken,
  key validated, ignore other fields)
- `pairingUri(channelId, pairingToken, key): string`
- `encryptEnvelope(payload, {channelId,key,sequence,kind?,nonce?}): Promise<object>`;
  kind is 'services-v1' or omitted for legacy; nonce optional Uint8Array for tests.
  Native node:crypto or WebCrypto, exact AAD/ciphertext from upstream fixtures.
- `decryptEnvelope(envelope,{channelId,key}): Promise<object>` for conformance/readback.
- `legacyProjection(inventory): object|null` uses only ready Codex weekly metadata.

`relay.js` exports `RelayClient` constructed with
`{baseUrl=DEFAULT_RELAY, fetchImpl=globalThis.fetch, timeoutMs=10000,
allowLoopback=false}`. Store normalized `.baseUrl`.
- `health(): Promise<object>`
- `createChannel(): Promise<object>` (validates complete response, no silent retry)
- `metadata(state): Promise<object>` (capabilities from authenticated metadata)
- `publish(state, inventory, sequence): Promise<{kind:'services-v1'|'legacy'}>`
  negotiates metadata each publication, encrypts services + optional legacy using
  different nonces but same sequence; exact upstream routes. No legacy data means
  a legacy-only relay returns a typed error instead of relabeling Gemini as Codex.
- `deleteChannel(state): Promise<void>` (404 is already gone).
- `claim(channelId,pairingToken): Promise<object>` and `read(channelId,readerToken):
  Promise<object>` for synthetic live conformance only, no logging sensitive values.
Reject redirects, non-origin URLs, embedded credentials, unbounded bodies, invalid
protocol/schema/types. Production HTTPS only; loopback HTTP opt-in for tests.
`RelayError` exposes `.code`, optional `.status`, `.retryAfterMs`; messages are fixed
safe strings, never include request URL/channel/token or upstream response prose.

`normalize.js` exports `normalizeQuota(envelope,{nowMs=Date.now(),maxAgeMs=900000,
accounts={}}={}): {inventory,diagnostics}`. Input is `{snapshot:{version:6,
providers:[{providerId,rows,okAtMs?,checkedAtMs?,error?,refreshing?}],...}}` from
opencode-quota 6.2.2. Inventory follows protocol/statusline-services-v1.md exactly.
Only map source-backed quota rows: OpenAI subscription -> codex; Google AGY Gemini
rows -> antigravity; native Anthropic general plan rows -> claude. Never map AGY's
Claude/GPT third-party pool or API/monthly balances. Investigate exact whitelisted
row IDs in upstream v6.2.2 source and document them in tests.
Retain actual okAtMs in provider updatedAt, never substitute current polling time
for a successful reading. Missing/expired/invalid windows are null; stale/errors
are unavailable. No made-up 0/100. Never pick arbitrary account on ambiguity;
accounts maps service IDs to exact local Quota account strings (never serialized).
Rebuild output from allowlisted fields only. Round finite [0,100] values; reject
outside ranges. Duplicate rows/accounts are treated as ambiguous. Malformed input
throws fixed safe Error; diagnostics contain only codes and canonical service IDs.
Inventory updatedAt is current observation time; payload deduplication must ignore
this timestamp when provider samples/data are unchanged. Support empty inventory.

`quota-rpc.js` exports `QuotaSnapshotRpc` via `Rpc.define` from @opencode/plugin/rpc:
mirror only `slkiser.opencode-quota.snapshot({})` and `changed` schema; never register
the mirrored contract and never force provider refresh. Client `ctx.rpc(def).snapshot`
uses existing cache. All errors should surface generic fixed messages.

## Runtime and scope

Default 60-second cache polling, changed-payload publishing; no model calls.
No networking before local CLI pairing. Relay errors/backoff leave prior published
state intact. Persist monotonic sequence before sending to survive crash/retry.
Multiple project runtimes coordinate using local lock + shared durable dedupe hash.
Unload aborts outstanding work and clears timers. State and pairing files must be
0600 in a 0700 directory outside Git; state writes are atomic. No key/token in
logs, diagnostics, issue, session messages or normal status output.
CLI: `pair`, `status`, `disconnect`, `smoke` (synthetic data + ephemeral channel
deleted in finally). Pair writes local HTML with private copyable URI; user pastes
it into official mobile app. Do not put the pairing URI into AI tool output.
Phone verification is separate from crypto + synthetic relay smoke.

## Verification

Protocol fixtures, wrong AAD/sequence rejection, bounded/redirect/timeout/error
handling, normalization/ambiguity/staleness/privacy, restart/dedupe/concurrent
writer behavior, unload lifecycle and native host load. Live smoke uses synthetic
data, creates its own channel and deletes it; no user pairing is claimed by tests.
Publishing issue must distinguish implemented integration from phone acceptance.
