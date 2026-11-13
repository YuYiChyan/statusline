// Deliberately independent of OpenCode's SDK: this module only projects cached
// v6 rows, never discovers credentials, queries providers or serializes a source.
const INVALID_SNAPSHOT = 'Invalid quota snapshot';
const MAX_UNIX_SECONDS = 253_402_300_799;
const SOURCES = [
  { providerId: 'openai', id: 'codex', prefix: 'openai', methods: ['remote_api'] },
  {
    providerId: 'google-agy', id: 'antigravity', prefix: 'google-agy.gemini',
    methods: ['remote_api'],
  },
  {
    providerId: 'anthropic', id: 'claude', prefix: 'anthropic',
    methods: ['remote_api', 'local_cli'],
  },
];
const WINDOWS = [
  { field: 'weekly', key: 'weekly', window: 'week', minutes: 10_080 },
  { field: 'shortWindow', key: 'five_hour', window: 'five_hour', minutes: 300 },
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireShape(condition) {
  if (!condition) throw new Error(INVALID_SNAPSHOT);
}

function unixSeconds(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return null;
  const seconds = Math.floor(milliseconds / 1000);
  return seconds > 0 && seconds <= MAX_UNIX_SECONDS ? seconds : null;
}

function validSample(milliseconds, nowMs) {
  return unixSeconds(milliseconds) !== null && milliseconds <= nowMs;
}

// Date.parse alone accepts local dates, numeric strings and even February 30.
// Quota's resetsAt is ISO with a timezone; retain its instant, not the local TZ.
function resetSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) {
    return null;
  }
  return unixSeconds(Date.parse(value));
}

function validateEnvelope(envelope) {
  requireShape(isRecord(envelope) && isRecord(envelope.snapshot));
  const snapshot = envelope.snapshot;
  requireShape(snapshot.version === 6 && Array.isArray(snapshot.providers));
  for (const provider of snapshot.providers) {
    requireShape(isRecord(provider) && typeof provider.providerId === 'string'
      && provider.providerId.length > 0 && Array.isArray(provider.rows));
    requireShape(provider.refreshing === undefined || typeof provider.refreshing === 'boolean');
    requireShape(provider.error === undefined || (isRecord(provider.error)
      && typeof provider.error.code === 'string'));
    for (const row of provider.rows) {
      requireShape(isRecord(row) && typeof row.id === 'string' && row.id.length > 0
        && row.providerId === provider.providerId
        && (row.account === undefined || typeof row.account === 'string'));
    }
  }
  return snapshot;
}

// On failures, retain the last actual success. A never-successful source may
// instead show its attempt time (or observation time), but is never ready.
// Duplicate snapshots use the oldest actual sample, never a chosen account.
function providerTimestamp(providers, snapshot, nowMs) {
  for (const field of ['okAtMs', 'checkedAtMs']) {
    let earliest;
    for (const provider of providers) {
      const timestamp = provider[field];
      if (validSample(timestamp, nowMs)) earliest = Math.min(earliest ?? timestamp, timestamp);
    }
    if (earliest !== undefined) return unixSeconds(earliest);
  }
  return validSample(snapshot.generatedAtMs, nowMs)
    ? unixSeconds(snapshot.generatedAtMs) : unixSeconds(nowMs);
}

function projectWindow(row, source, window, nowSeconds, diagnose) {
  if (!row) return null;
  if (row.type !== 'quota' || row.authority !== 'provider_reported'
    || !source.methods.includes(row.method) || row.window !== window.window) {
    diagnose('invalid_window');
    return null;
  }
  if (row.percentRemaining === undefined || row.resetsAt === undefined) {
    diagnose('missing_window');
    return null;
  }
  const percentage = row.percentRemaining;
  const resetAt = resetSeconds(row.resetsAt);
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)
    || percentage < 0 || percentage > 100 || resetAt === null) {
    diagnose('invalid_window');
    return null;
  }
  if (resetAt <= nowSeconds) {
    diagnose('expired_window');
    return null;
  }
  return {
    remainingPercentage: Math.round(percentage) || 0,
    resetAt,
    windowMinutes: window.minutes,
  };
}

function normalize(envelope, options) {
  requireShape(isRecord(options));
  const { nowMs = Date.now(), maxAgeMs = 900_000, accounts = {} } = options;
  requireShape(unixSeconds(nowMs) !== null && typeof maxAgeMs === 'number'
    && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && isRecord(accounts));
  for (const { id } of SOURCES) {
    requireShape(!Object.hasOwn(accounts, id) || typeof accounts[id] === 'string');
  }
  const snapshot = validateEnvelope(envelope);
  const inventory = { schemaVersion: 1, updatedAt: unixSeconds(nowMs), providers: [] };
  const diagnostics = [];

  for (const source of SOURCES) {
    const providers = snapshot.providers.filter((provider) => provider.providerId === source.providerId);
    if (providers.length === 0) continue;
    const rowIds = WINDOWS.map((window) => `${source.prefix}.${window.key}`);
    const candidates = providers.flatMap((provider) => provider.rows.filter((row) => rowIds.includes(row.id)));
    // A third-party AGY pool, API balance or model-specific quota is not this
    // service. Empty known sources remain unavailable while checking/failing;
    // unsupported-only sources do not create misleading static service cards.
    if (candidates.length === 0 && providers.every((provider) => provider.rows.length > 0)) continue;

    const codes = new Set();
    const diagnose = (code) => {
      if (codes.has(code)) return;
      codes.add(code);
      diagnostics.push({ code, serviceId: source.id });
    };
    const reading = {
      id: source.id,
      status: 'unavailable',
      updatedAt: providerTimestamp(providers, snapshot, nowMs),
      weekly: null,
      shortWindow: null,
    };
    inventory.providers.push(reading);
    if (providers.length !== 1) {
      diagnose('ambiguous_provider');
      continue;
    }
    const provider = providers[0];
    if (provider.error !== undefined) {
      diagnose('source_error');
      continue;
    }
    if (!validSample(provider.okAtMs, nowMs)) {
      diagnose(provider.okAtMs === undefined ? 'missing_sample' : 'invalid_sample');
      continue;
    }
    // maxAgeMs is inclusive: a sample is stale once it is older than the limit.
    if (nowMs - provider.okAtMs > maxAgeMs) {
      diagnose('stale');
      continue;
    }

    const byAccount = new Map();
    for (const row of candidates) {
      if (!byAccount.has(row.account)) byAccount.set(row.account, []);
      byAccount.get(row.account).push(row);
    }
    let selected;
    if (Object.hasOwn(accounts, source.id)) {
      selected = byAccount.get(accounts[source.id]);
      if (!selected) {
        diagnose('account_not_found');
        continue;
      }
    } else {
      if (byAccount.size === 0) {
        diagnose('missing_window');
        continue;
      }
      if (byAccount.size !== 1) {
        diagnose('ambiguous_account');
        continue;
      }
      selected = byAccount.values().next().value;
    }
    // A repeated id for the same display account can hide distinct credentials.
    // Do not merge its other window with an arbitrarily chosen duplicate.
    if (rowIds.some((id) => selected.filter((row) => row.id === id).length > 1)) {
      diagnose('ambiguous_row');
      continue;
    }
    for (const window of WINDOWS) {
      reading[window.field] = projectWindow(
        selected.find((row) => row.id === `${source.prefix}.${window.key}`),
        source, window, inventory.updatedAt, diagnose,
      );
    }
    if (reading.weekly !== null || reading.shortWindow !== null) reading.status = 'ready';
  }
  return { inventory, diagnostics };
}

/**
 * Only allowlisted, source-backed values leave this boundary. Account selectors
 * are exact local Quota strings, not labels or credentials to publish. Diagnostics
 * contain only fixed codes and canonical serviceId values, never upstream prose.
 */
export function normalizeQuota(envelope, options = {}) {
  try {
    return normalize(envelope, options);
  } catch {
    // Do not propagate parser, getter or provider errors containing private data.
    throw new Error(INVALID_SNAPSHOT);
  }
}
