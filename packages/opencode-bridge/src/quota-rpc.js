import { Rpc } from '@opencode/plugin/rpc';

// Read-only mirror of opencode-quota v6.2.2 src/rpc.ts. Never register this
// definition: Quota owns it. snapshot({}) reads its cache, unlike refresh().
// The upstream wire checks only the envelope; normalizeQuota validates v6 rows.
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schema(check, message) {
  return {
    '~standard': {
      version: 1,
      vendor: 'statusline-bridge',
      validate(value) {
        try {
          if (check(value)) return { value };
        } catch {
          // A malformed response must not expose remote errors or private fields.
        }
        return { issues: [{ message }] };
      },
    },
  };
}

const snapshotEnvelope = schema(
  (value) => isRecord(value) && isRecord(value.snapshot),
  'Invalid quota RPC response',
);

export const QuotaSnapshotRpc = Rpc.define({
  id: 'slkiser.opencode-quota',
  methods: {
    snapshot: {
      input: schema(
        (value) => isRecord(value)
          && (value.sessionID === undefined || typeof value.sessionID === 'string'),
        'Invalid quota RPC input',
      ),
      output: snapshotEnvelope,
    },
  },
  events: { changed: { schema: snapshotEnvelope } },
});
