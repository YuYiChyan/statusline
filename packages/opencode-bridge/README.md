# OpenCode → Statusline bridge

[中文](README.zh.md) · Community integration, version 0.1.0

A small **server-only OpenCode plugin** that sends quota from an existing
`@slkiser/opencode-quota` installation to Statusline's encrypted relay. Use the
official mobile app and widgets without installing Statusline Desktop Companion.
No extra daemon, model calls, provider sign-in, or UI bundle.

## Requirements and installation

- OpenCode **2.2.7** (tested); other versions need their own compatibility check.
- `@slkiser/opencode-quota` **6.2.2**, configured and working in OpenCode.
- Node.js **22.13+** for installation and the pairing CLI.
- The official Statusline mobile app, with services-v1 support for multiple services.
  Claude display depends on the installed mobile release, not just this publisher.

```sh
git clone --branch feat/opencode-bridge --single-branch https://github.com/YuYiChyan/statusline.git
cd statusline
npm ci --ignore-scripts
npm test
npm run check
```

Append the checkout's **absolute directory** to `plugins` in your global
`~/.config/opencode/opencode.json(c)`, preserving your existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@slkiser/opencode-quota@6.2.2",
    {
      "package": "/absolute/path/to/statusline",
      "options": { "pollMs": 60000, "maxAgeMs": 900000 }
    }
  ]
}
```

OpenCode reloads changed configuration automatically. Ask OpenCode to run
`statusline_bridge_status` to check the loaded runtime. It starts unpaired.

The root package is also installable from an npm-generated tarball (`npm pack`);
its allowlist contains bridge source, documentation, and the MIT license. The
only direct runtime dependency is OpenCode's SDK. There is no npm registry release.

## Pair your phone

Run from the checkout or extracted package:

```sh
node packages/opencode-bridge/src/cli.js pair
```

Open the **local HTML file** named in the result. Copy its private link, open
Statusline's device-pairing screen on your phone, paste the link, and connect.
On macOS/iPhone, Universal Clipboard can transfer it. The page uses no remote
resources. It contains the encryption key: keep it private. The CLI does not
print the link or key into terminal/agent logs.

Pairing expires after **10 minutes** and is single-use. To replace an expired
unclaimed pairing or change phones, disconnect and pair again:

```sh
node packages/opencode-bridge/src/cli.js status
node packages/opencode-bridge/src/cli.js disconnect
node packages/opencode-bridge/src/cli.js pair
```

`disconnect` deletes the relay channel before clearing local credentials and the
pairing page. A cleanup failure retains saved state for another disconnect
attempt. If both the initial state write and remote cleanup fail, the empty
channel can only expire remotely; the CLI reports `pairing_cleanup_failed`.

## Mapping and freshness

| Quota provider | Exact accepted row IDs | Statusline service |
| --- | --- | --- |
| OpenAI subscription | `openai.weekly`, `openai.five_hour` | Codex |
| Google AGY Gemini | `google-agy.gemini.weekly`, `google-agy.gemini.five_hour` | Antigravity |
| Native Anthropic general plan | `anthropic.weekly`, `anthropic.five_hour` | Claude |

Only provider-reported quota percentages and matching windows are accepted.
API balances, monthly rows, model-specific quotas and AGY's shared Claude/GPT
pool are excluded. Unsupported providers need corresponding mobile app support.

The bridge polls Quota's `snapshot({})` RPC every **60 seconds** and publishes
only changed provider samples. In Quota 6.2.2 this returns the cache **and may
schedule Quota's normally due background checks**. Those checks retain Quota's
own minimum interval and single-flight behavior. The bridge never calls
`refresh()`, bypasses its throttling, or calls provider endpoints itself.

Original `okAtMs` timestamps are preserved. Failed or >15-minute-old samples
become unavailable; missing or expired windows become null. Temporarily missing
previously published services stay unavailable rather than being removed. To
remove a service explicitly, set `services` to the IDs you want to retain.
An empty array removes all services on a services-v1 relay.

Multiple accounts are **not merged or arbitrarily selected**. If a provider
contains several accounts, set its exact local Quota account string:

```jsonc
"options": {
  "accounts": { "codex": "EXACT_LOCAL_QUOTA_ACCOUNT" },
  "services": ["codex", "antigravity", "claude"],
  "pollMs": 60000,
  "maxAgeMs": 900000
}
```

Account selectors stay local. Use consistent global options across projects.
The first publishing source scope binds the channel; another credential scope
reports `source_scope_changed`. Disconnect/re-pair to deliberately rebind it.

## Storage and protocol

Local state defaults to `$STATUSLINE_BRIDGE_HOME`, else
`$XDG_DATA_HOME/opencode/statusline-bridge`, else
`~/.local/share/opencode/statusline-bridge`. Directories are 0700 and files 0600
on POSIX. For another path, set plugin option `stateDirectory` and CLI
`--state-dir` to the same absolute directory. Keys are private files, not OS
keychain entries. Windows permissions require platform-appropriate protection.

The state lock coordinates project instances; atomic writes persist sequence
reservation, deduplication and relay backoff across restarts. Unload cancels work.
AES-256-GCM matches upstream fixtures, with fresh independent nonces for the
services inventory and legacy Codex projection. The key never goes to the relay.
Authenticated channel metadata negotiates services-v1 each publication; an older
relay supports only a ready weekly Codex projection. It cannot clear unavailable
legacy data, whose original timestamp remains unchanged.

The default relay is `https://statusline-relay.inmerzion.workers.dev`.
`--relay HTTPS_ORIGIN` supports development/custom builds, but production phone
apps trust their built-in relay origin; the pairing URI cannot override it.

## Verification and limitations

```sh
npm test
npm run check
node packages/opencode-bridge/src/cli.js smoke
```

`smoke` creates its own temporary channel, publishes **synthetic data**, claims
that test pairing, decrypts the readback, then deletes the channel. It never
claims your phone's pairing. Tests cover crypto fixtures, normalization/privacy,
relay bounds/cancellation, locking, restart, backoff and pairing cleanup.

Protocol/relay round trips and OpenCode host loading are distinct from actual
phone/widget acceptance. Mobile hardware acceptance is still pending. OpenCode
must keep the plugin's project runtime active to publish; quitting or unloading
it stops updates. iOS controls widget refresh timing, so widgets are not a
real-time stream. No reset push or background wake service is installed.
