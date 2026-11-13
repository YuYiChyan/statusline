# 0.1.0 verification

Verified on 2026-11-13 against OpenCode 2.2.7, Quota 6.2.2 and Statusline source
baseline `268433dfbeef6d302805a68dfe4450afa42999d6`.

- **67/67 Node tests passed.** Both upstream AES-GCM fixtures match exactly;
  negative cases cover authentication/AAD, schema/size/origin/redirect checks,
  relay cancellation and timeout, provider mapping, account ambiguity, stale
  data, safe output, private state, locking, restart, uncertain acknowledgements,
  shared retry backoff, disappeared providers and pairing cleanup.
- `npm run check`: syntax checks and real OpenCode SDK entry import passed.
- `npm pack`: inspected the actual allowlisted package (14 files, approximately
  41 KB compressed including upstream READMEs); no configuration, state,
  credentials, logs, dependencies, desktop binaries or native app projects.
- **Installed the packed artifact** in an existing OpenCode 2.2.7 host. Native
  `plugin.list` reports `statusline-bridge` active, server-only. Its registered
  status tool executes and initially reports unpaired without private values.
- A live Quota RPC returned a v6 snapshot accepted by the adapter. Inspection
  output contained only canonical provider IDs, method kinds and status flags.
- **Official production relay synthetic smoke passed**: create temporary
  channel → negotiate services-v1 → dual encrypted publish → claim test reader
  → read/decrypt matching inventory → delete temporary channel. No user pairing
  was claimed by the smoke test; no key or bearer token was logged.

Review findings addressed: missing providers no longer imply service removal;
uncertain sends disable old-hash deduplication until a confirmed publish;
expired channels can be disconnected. Snapshot documentation was corrected:
Quota 6.2.2 can schedule its normally due background check from `snapshot({})`.

This is **not a claim of phone/widget hardware acceptance**. That remains
pending, along with mobile-release-specific Claude display and OS widget timing.
GitHub CI is provided separately; local results above are not a claim that a
remote workflow has completed. No npm registry publication is claimed.
