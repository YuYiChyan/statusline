import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQuota } from '../src/normalize.js';

// All fixtures below are invented, contain no credentials, and require no SDK or
// provider requests. Whitelist verified against the pinned v6.2.2 source:
// https://raw.githubusercontent.com/slkiser/opencode-quota/v6.2.2/src/core/types.ts
// https://raw.githubusercontent.com/slkiser/opencode-quota/v6.2.2/src/core/rows.ts
//   rowsFromProviderResult: id = `${providerId}.${key}`, account is local text.
// https://raw.githubusercontent.com/slkiser/opencode-quota/v6.2.2/src/providers/contract.ts
//   WEEKLY = {key:'weekly', window:'week'}, FIVE_HOUR = {key:'five_hour', window:'five_hour'}.
// https://raw.githubusercontent.com/slkiser/opencode-quota/v6.2.2/src/providers/openai.ts
//   openai.weekly / openai.five_hour; exclude monthly, code_review, API status.
// https://raw.githubusercontent.com/slkiser/opencode-quota/v6.2.2/src/providers/google-agy.ts
//   google-agy.gemini.weekly / .five_hour; NEVER google-agy.claude_gpt.*.
// https://raw.githubusercontent.com/slkiser/opencode-quota/v6.2.2/src/providers/anthropic.ts
//   anthropic.weekly / anthropic.five_hour (general plan, API or Claude CLI);
//   NOT weekly_fable (model-specific), extra_usage (monthly), seven_day or 5h.
// https://raw.githubusercontent.com/slkiser/opencode-quota/v6.2.2/src/rpc.ts
//   snapshot({sessionID?}) and changed both carry {snapshot: QuotaSnapshot}.

const NOW = 1_900_000_000_500;
const SAMPLE = NOW - 60_123;
const RESET = NOW + 3_600_000;
const seconds = (milliseconds) => Math.floor(milliseconds / 1000);
const iso = (milliseconds) => new Date(milliseconds).toISOString();

function row(providerId, key, changes = {}) {
  return {
    id: `${providerId}.${key}`,
    providerId,
    account: 'Fixture account',
    label: 'Synthetic quota',
    type: 'quota',
    method: 'remote_api',
    authority: 'provider_reported',
    prominence: 'primary',
    window: key.endsWith('weekly') ? 'week' : 'five_hour',
    percentRemaining: 73.4,
    resetsAt: iso(RESET),
    ...changes,
  };
}

function provider(providerId, rows = [], changes = {}) {
  return { providerId, label: 'Synthetic provider', rows, okAtMs: SAMPLE, checkedAtMs: SAMPLE,
    refreshing: false, ...changes };
}

function envelope(providers = [], changes = {}) {
  return { snapshot: { version: 6, providers, generatedAtMs: NOW, serverId: 'fixture-server',
    revision: 1, resetNotices: [], ...changes } };
}

function normalize(providers, options = {}) {
  return normalizeQuota(envelope(providers), { nowMs: NOW, ...options });
}

function quotaWindow(percentage = 73, minutes = 300, reset = RESET) {
  return { remainingPercentage: percentage, resetAt: seconds(reset), windowMinutes: minutes };
}

function reading(id, changes = {}) {
  return { id, status: 'unavailable', updatedAt: seconds(SAMPLE), weekly: null,
    shortWindow: null, ...changes };
}

test('projects the six exact general-plan ids into separate source-backed windows', () => {
  const result = normalize([
    provider('anthropic', [row('anthropic', 'weekly', { percentRemaining: 12.5 }),
      row('anthropic', 'five_hour', { method: 'local_cli', percentRemaining: 64.49 })]),
    provider('google-agy', [row('google-agy', 'gemini.weekly', { percentRemaining: 48.1 }),
      row('google-agy', 'gemini.five_hour')]),
    provider('openai', [row('openai', 'weekly', { percentRemaining: 25.7 }),
      row('openai', 'five_hour', { percentRemaining: 91.2 })]),
  ]);
  assert.deepEqual(result, {
    inventory: { schemaVersion: 1, updatedAt: seconds(NOW), providers: [
      reading('codex', { status: 'ready', weekly: quotaWindow(26, 10_080), shortWindow: quotaWindow(91) }),
      reading('antigravity', { status: 'ready', weekly: quotaWindow(48, 10_080), shortWindow: quotaWindow() }),
      reading('claude', { status: 'ready', weekly: quotaWindow(13, 10_080), shortWindow: quotaWindow(64) }),
    ] },
    diagnostics: [],
  });
});

test('empty inventory and unsupported sources are omitted, never defaulted to static services', () => {
  const empty = { inventory: { schemaVersion: 1, updatedAt: seconds(NOW), providers: [] }, diagnostics: [] };
  assert.deepEqual(normalize([]), empty);
  assert.deepEqual(normalize([
    provider('google-gemini-cli', [row('google-gemini-cli', 'weekly')]),
    provider('quota-providers', [row('quota-providers', 'openai.weekly')]),
    provider('openai', [row('openai', 'monthly', { window: 'month' }),
      row('openai', 'code_review', { window: 'code_review' }), row('openai', 'status', { type: 'status' })]),
    provider('anthropic', [row('anthropic', 'weekly_fable', { window: 'week' }),
      row('anthropic', 'extra_usage', { window: 'month' })]),
    provider('google-agy', [row('google-agy', 'claude_gpt.weekly'), row('google-agy', 'claude_gpt.five_hour')]),
  ]), empty);
});

test('AGY Claude/GPT is neither native Claude nor Gemini, even beside genuine Claude rows', () => {
  const result = normalize([
    provider('google-agy', [row('google-agy', 'claude_gpt.weekly', { percentRemaining: 0 }),
      row('google-agy', 'claude_gpt.five_hour', { percentRemaining: 100 }),
      row('google-agy', 'gemini.five_hour', { percentRemaining: 27 })]),
    provider('anthropic', [row('anthropic', 'five_hour', { percentRemaining: 62 })]),
  ]);
  assert.deepEqual(result.inventory.providers, [
    reading('antigravity', { status: 'ready', shortWindow: quotaWindow(27) }),
    reading('claude', { status: 'ready', shortWindow: quotaWindow(62) }),
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('a five-hour row is never promoted to a week and a weekly id with month is not trusted', () => {
  const result = normalize([provider('openai', [
    row('openai', 'weekly', { window: 'month' }), row('openai', 'five_hour'),
  ])]);
  assert.deepEqual(result.inventory.providers, [reading('codex', { status: 'ready', shortWindow: quotaWindow() })]);
  assert.deepEqual(result.diagnostics, [{ code: 'invalid_window', serviceId: 'codex' }]);
});

test('sample timestamp is the success, not the poll, snapshot generation, check or refreshing flag', () => {
  const input = envelope([provider('openai', [row('openai', 'weekly')], {
    checkedAtMs: NOW, refreshing: true,
  })], { generatedAtMs: NOW + 5_000 });
  const first = normalizeQuota(input, { nowMs: NOW });
  const next = normalizeQuota(input, { nowMs: NOW + 5_000 });
  assert.equal(first.inventory.providers[0].updatedAt, seconds(SAMPLE));
  assert.equal(first.inventory.providers[0].status, 'ready');
  assert.deepEqual(first.inventory.providers, next.inventory.providers);
  assert.notEqual(first.inventory.updatedAt, next.inventory.updatedAt);
});

test('stale and failed cache rows become unavailable without advancing their success timestamp', () => {
  for (const code of ['not_configured', 'login_expired', 'no_plan', 'rate_limited', 'timeout',
    'network', 'provider_error', 'bad_response', 'no_data', 'local_tool', 'internal']) {
    const result = normalize([provider('anthropic', [row('anthropic', 'weekly')], {
      error: { code, status: 401, detail: 'synthetic-private-detail', tool: '/fixture/private/tool' },
      checkedAtMs: NOW,
    })]);
    assert.deepEqual(result.inventory.providers, [reading('claude')]);
    assert.deepEqual(result.diagnostics, [{ code: 'source_error', serviceId: 'claude' }]);
  }
  const stale = normalize([provider('openai', [row('openai', 'weekly')], {
    okAtMs: NOW - 900_001, checkedAtMs: NOW,
  })]);
  assert.deepEqual(stale.inventory.providers, [reading('codex', { updatedAt: seconds(NOW - 900_001) })]);
  assert.deepEqual(stale.diagnostics, [{ code: 'stale', serviceId: 'codex' }]);
  assert.equal(normalize([provider('openai', [row('openai', 'weekly')], {
    okAtMs: NOW - 900_000,
  })]).inventory.providers[0].status, 'ready');
});

test('maxAgeMs is configurable and a zero-age policy accepts only an exactly current sample', () => {
  const providers = [provider('openai', [row('openai', 'weekly')])];
  assert.equal(normalize(providers, { maxAgeMs: 60_122 }).inventory.providers[0].status, 'unavailable');
  assert.equal(normalize(providers, { maxAgeMs: 60_123 }).inventory.providers[0].status, 'ready');
  assert.equal(normalize([provider('openai', [row('openai', 'weekly')], { okAtMs: NOW })], {
    maxAgeMs: 0,
  }).inventory.providers[0].status, 'ready');
});

test('missing, invalid and future successful timestamps cannot be made fresh by checkedAtMs', () => {
  for (const okAtMs of [undefined, null, NaN, Infinity, -1, 0, 999, '1900000000000', NOW + 1]) {
    const result = normalize([provider('openai', [row('openai', 'weekly')], { okAtMs, checkedAtMs: NOW })]);
    assert.deepEqual(result.inventory.providers, [reading('codex', { updatedAt: seconds(NOW) })]);
    assert.deepEqual(result.diagnostics, [{ code: okAtMs === undefined ? 'missing_sample' : 'invalid_sample',
      serviceId: 'codex' }]);
  }
});

test('known but empty sources remain unavailable with a real attempt time when available', () => {
  const result = normalize([provider('anthropic', [], { okAtMs: undefined, checkedAtMs: SAMPLE })]);
  assert.deepEqual(result.inventory.providers, [reading('claude')]);
  const initial = normalize([provider('openai', [], { okAtMs: undefined, checkedAtMs: undefined })]);
  assert.deepEqual(initial.inventory.providers, [reading('codex', { updatedAt: seconds(NOW) })]);
  const noWindows = normalize([provider('google-agy')]);
  assert.deepEqual(noWindows.inventory.providers, [reading('antigravity')]);
  assert.deepEqual(noWindows.diagnostics, [{ code: 'missing_window', serviceId: 'antigravity' }]);
});

test('finite in-range source percentages are rounded, never clamped or derived from amounts', () => {
  for (const [percentRemaining, expected] of [[0, 0], [-0, 0], [0.49, 0], [0.5, 1], [99.5, 100], [100, 100]]) {
    const result = normalize([provider('openai', [row('openai', 'five_hour', { percentRemaining })])]);
    assert.equal(result.inventory.providers[0].shortWindow.remainingPercentage, expected);
  }
  for (const percentRemaining of [undefined, null, '', '50', false, NaN, Infinity, -Infinity, -0.001, 100.001]) {
    const result = normalize([provider('openai', [row('openai', 'weekly', {
      percentRemaining, remaining: { decimal: '100', unit: { kind: 'count', unit: 'request' } },
      limit: { decimal: '100', unit: { kind: 'count', unit: 'request' } }, usedPercent: 0,
    })])]);
    assert.deepEqual(result.inventory.providers, [reading('codex')]);
  }
});

test('missing/expired/invalid reset windows are null without losing an independent valid window', () => {
  for (const resetsAt of [undefined, null, '', 'nonsense', '2036', '2036-02-30T12:00:00Z',
    '2036-13-01T00:00:00Z', '2036-12-01T24:00:00Z', '2036-12-01T00:00:60Z',
    '2036-12-01T00:00:00+24:00', '2036-12-01T00:00:00', '2036-12-01',
    iso(NOW), iso(NOW - 1_000), iso(NOW + 1), 2_100_000_000]) {
    const result = normalize([provider('openai', [row('openai', 'weekly', { resetsAt }), row('openai', 'five_hour')])]);
    assert.deepEqual(result.inventory.providers, [reading('codex', { status: 'ready', shortWindow: quotaWindow() })]);
  }
  const expired = normalize([provider('anthropic', [row('anthropic', 'five_hour', { resetsAt: iso(NOW - 1_000) })])]);
  assert.deepEqual(expired.inventory.providers, [reading('claude')]);
  assert.deepEqual(expired.diagnostics, [{ code: 'expired_window', serviceId: 'claude' }]);
});

test('ISO timezone offsets and submillisecond fractions preserve the reported reset instant', () => {
  const resetsAt = '2032-02-29T12:00:00.123456+02:00';
  const result = normalize([provider('anthropic', [row('anthropic', 'weekly', { resetsAt })])]);
  assert.equal(result.inventory.providers[0].weekly.resetAt, Date.parse('2032-02-29T10:00:00Z') / 1000);
});

test('unreported percentages, balances, local estimates and mismatched window kinds are not quotas', () => {
  for (const changes of [{ type: 'budget' }, { type: 'usage' }, { type: 'balance' }, { type: 'status' },
    { type: undefined }, { authority: 'locally_derived' }, { authority: undefined },
    { method: 'local_estimation' }, { method: 'dashboard_scrape' }, { method: 'local_cli' },
    { method: undefined }, { window: 'month' }, { window: 'day' }, { window: undefined }]) {
    const result = normalize([provider('openai', [row('openai', 'weekly', changes)])]);
    assert.deepEqual(result.inventory.providers, [reading('codex')]);
    assert.deepEqual(result.diagnostics, [{ code: 'invalid_window', serviceId: 'codex' }]);
  }
});

test('multiple accounts are ambiguous irrespective of row order, available windows or apparent active labels', () => {
  const rows = [row('openai', 'weekly', { account: 'A (active)', percentRemaining: 12 }),
    row('openai', 'five_hour', { account: 'B', percentRemaining: 98 })];
  for (const order of [rows, [...rows].reverse()]) {
    const result = normalize([provider('openai', order)]);
    assert.deepEqual(result.inventory.providers, [reading('codex')]);
    assert.deepEqual(result.diagnostics, [{ code: 'ambiguous_account', serviceId: 'codex' }]);
  }
});

test('exact service-keyed selectors choose one account without serializing it or mixing its windows', () => {
  const sources = [['openai', 'codex', ''], ['google-agy', 'antigravity', 'gemini.'], ['anthropic', 'claude', '']];
  for (const [providerId, serviceId, prefix] of sources) {
    const rows = [row(providerId, `${prefix}weekly`, { account: 'A', percentRemaining: 12 }),
      row(providerId, `${prefix}five_hour`, { account: 'B', percentRemaining: 98 })];
    const result = normalize([provider(providerId, rows)], { accounts: { [serviceId]: 'B' } });
    assert.deepEqual(result.inventory.providers, [reading(serviceId, { status: 'ready', shortWindow: quotaWindow(98) })]);
    assert.deepEqual(result.diagnostics, []);
    for (const selector of ['b', ' B', 'B ', '[B]', 'missing', '']) {
      const absent = normalize([provider(providerId, rows)], { accounts: { [serviceId]: selector } });
      assert.deepEqual(absent.inventory.providers, [reading(serviceId)]);
      assert.deepEqual(absent.diagnostics, [{ code: 'account_not_found', serviceId }]);
    }
  }
});

test('absent, empty, case-different and prototype-looking account strings remain distinct', () => {
  for (const account of [undefined, '', '__proto__', 'constructor']) {
    const rows = [row('openai', 'weekly', { account })];
    assert.equal(normalize([provider('openai', rows)]).inventory.providers[0].status, 'ready');
    if (account !== undefined) {
      assert.equal(normalize([provider('openai', rows)], { accounts: { codex: account } }).inventory.providers[0].status, 'ready');
    } else {
      assert.equal(normalize([provider('openai', rows)], { accounts: { codex: '' } }).inventory.providers[0].status, 'unavailable');
    }
  }
  const rows = [row('openai', 'weekly', { account: undefined }), row('openai', 'five_hour', { account: '' })];
  assert.equal(normalize([provider('openai', rows)]).inventory.providers[0].status, 'unavailable');
  const inherited = Object.create({ codex: 'not-an-own-selector' });
  assert.equal(normalize([provider('openai', [row('openai', 'weekly')])], { accounts: inherited }).inventory.providers[0].status, 'ready');
});

test('excluded families/accounts cannot contaminate a valid Gemini or native plan account', () => {
  const result = normalize([provider('google-agy', [
    row('google-agy', 'gemini.five_hour', { account: 'Gemini fixture' }),
    row('google-agy', 'claude_gpt.weekly', { account: 'Other fixture' }),
  ]), provider('anthropic', [row('anthropic', 'weekly', { account: 'General fixture' }),
    row('anthropic', 'weekly_fable', { account: 'Model fixture', window: 'week' })])]);
  assert.deepEqual(result.inventory.providers.map(({ status }) => status), ['ready', 'ready']);
  assert.deepEqual(result.diagnostics, []);
});

test('duplicate rows, even identical ones, make a selected account unavailable rather than choosing one', () => {
  const weekly = row('anthropic', 'weekly');
  const rows = [weekly, { ...weekly }, row('anthropic', 'five_hour')];
  for (const accounts of [{}, { claude: 'Fixture account' }]) {
    const result = normalize([provider('anthropic', rows)], { accounts });
    assert.deepEqual(result.inventory.providers, [reading('claude')]);
    assert.deepEqual(result.diagnostics, [{ code: 'ambiguous_row', serviceId: 'claude' }]);
  }
  const selected = normalize([provider('anthropic', [...rows,
    row('anthropic', 'weekly', { account: 'Unique fixture', percentRemaining: 47 })])], {
    accounts: { claude: 'Unique fixture' },
  });
  assert.deepEqual(selected.inventory.providers, [reading('claude', { status: 'ready', weekly: quotaWindow(47, 10_080) })]);
});

test('duplicate provider snapshots cannot be merged or chosen using first/last entry', () => {
  const providers = [provider('openai', [row('openai', 'weekly')]),
    provider('openai', [row('openai', 'five_hour')], { okAtMs: SAMPLE + 10_000 })];
  for (const order of [providers, [...providers].reverse()]) {
    const result = normalize(order);
    assert.deepEqual(result.inventory.providers, [reading('codex')]);
    assert.deepEqual(result.diagnostics, [{ code: 'ambiguous_provider', serviceId: 'codex' }]);
  }
});

test('malformed envelopes and options throw only a fixed safe error', () => {
  const malformed = [undefined, null, [], '', {}, { snapshot: null }, { snapshot: [] },
    { snapshot: { version: 5, providers: [] } }, { snapshot: { version: '6', providers: [] } },
    { snapshot: { version: 6 } }, { snapshot: { version: 6, providers: {} } },
    envelope([null]), envelope([{}]), envelope([provider('', [])]),
    envelope([provider('openai', null)]), envelope([provider('openai', [null])]),
    envelope([provider('openai', [{}])]), envelope([provider('openai', [row('openai', 'weekly', { account: 42 })])]),
    envelope([provider('openai', [row('anthropic', 'weekly')])]),
    envelope([provider('openai', [], { error: 'synthetic-private-error' })]),
    envelope([provider('openai', [], { refreshing: 'yes' })]),
    { get snapshot() { throw new Error('synthetic-private-getter'); } },
  ];
  const safeError = (error) => error instanceof Error && error.message === 'Invalid quota snapshot'
    && !Object.hasOwn(error, 'cause');
  for (const input of malformed) assert.throws(() => normalizeQuota(input, { nowMs: NOW }), safeError);
  for (const options of [null, [], { nowMs: NaN }, { nowMs: Infinity }, { nowMs: 0 }, { nowMs: '1900000000000' },
    { maxAgeMs: -1 }, { maxAgeMs: NaN }, { maxAgeMs: Infinity }, { maxAgeMs: '1000' },
    { accounts: null }, { accounts: [] }, { accounts: { codex: 12 } }, { accounts: { claude: null } }]) {
    if (options === null || Array.isArray(options)) {
      assert.throws(() => normalizeQuota(envelope(), options), safeError);
    } else {
      assert.throws(() => normalizeQuota(envelope(), { nowMs: NOW, ...options }), safeError);
    }
  }
});

test('projection rebuilds only public fields, does not mutate input, and never reads unknown private data', () => {
  const privateData = 'fixture-private@example.invalid';
  const quota = row('openai', 'weekly', { account: privateData, label: privateData,
    accessToken: privateData, text: privateData, sessionID: privateData, debug: privateData,
    used: { decimal: '123', unit: { kind: 'currency', code: 'USD' } },
    toJSON() { throw new Error('must not serialize source row'); },
  });
  const source = provider('openai', [quota], { label: privateData, exportPart: privateData });
  Object.defineProperty(source, 'debug', { get() { throw new Error('must not read debug'); } });
  const input = envelope([source], { sourceScope: privateData, sessionID: privateData, settings: { secret: privateData } });
  for (const object of [quota, source.rows, source, input.snapshot.providers, input.snapshot, input]) Object.freeze(object);
  const result = normalizeQuota(input, { nowMs: NOW, accounts: { codex: privateData } });
  assert.deepEqual(result, {
    inventory: { schemaVersion: 1, updatedAt: seconds(NOW), providers: [
      reading('codex', { status: 'ready', weekly: quotaWindow(73, 10_080) }),
    ] }, diagnostics: [],
  });
  assert.equal(JSON.stringify(result).includes(privateData), false);
  assert.equal(quota.account, privateData);
});

test('diagnostics are deduplicated codes and canonical service IDs, never raw row IDs or accounts', () => {
  const result = normalize([provider('google-agy', [row('google-agy', 'gemini.weekly', { percentRemaining: NaN }),
    row('google-agy', 'gemini.five_hour', { percentRemaining: 101 })])]);
  assert.deepEqual(result.diagnostics, [{ code: 'invalid_window', serviceId: 'antigravity' }]);
  assert.deepEqual(Object.keys(result.inventory.providers[0]), ['id', 'status', 'updatedAt', 'weekly', 'shortWindow']);
});
