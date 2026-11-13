import { Plugin } from '@opencode/plugin';
import { createBridge } from './bridge.js';
import { StateStore } from './store.js';
import { QuotaSnapshotRpc } from './quota-rpc.js';

export default Plugin.define({
  id: 'statusline-bridge',
  async setup(ctx) {
    const options = ctx.options ?? {};
    const numberOption = (name, fallback, min, max) => {
      const value = options[name] ?? fallback;
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid bridge option: ${name}`);
      return value;
    };
    const accounts = options.accounts ?? {};
    const services = options.services ?? ['codex', 'antigravity', 'claude'];
    if (!Array.isArray(services) || new Set(services).size !== services.length || services.some(id => !['codex', 'antigravity', 'claude'].includes(id))) throw new Error('Invalid bridge option: services');
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts) || Object.entries(accounts).some(([id, value]) => !['codex', 'antigravity', 'claude'].includes(id) || typeof value !== 'string' || !value.length || value.length > 512)) {
      throw new Error('Invalid bridge option: accounts');
    }
    if (options.stateDirectory !== undefined && (typeof options.stateDirectory !== 'string' || !options.stateDirectory.length)) throw new Error('Invalid bridge option: stateDirectory');
    const quota = ctx.rpc(QuotaSnapshotRpc);
    const bridge = createBridge({
      readQuota: signal => quota.snapshot({}, { signal }),
      store: new StateStore(options.stateDirectory), accounts, services,
      pollMs: numberOption('pollMs', 60000, 15000, 3600000),
      maxAgeMs: numberOption('maxAgeMs', 900000, 60000, 86400000),
    });
    // Fixed, non-sensitive diagnostics; pairing credentials are handled only by CLI.
    await ctx.tool.transform(editor => {
      editor.add({
        name: 'statusline_bridge_status',
        description: 'Read local Statusline bridge health, without keys, pairing links or quota values.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify(bridge.status()) }),
      });
    });
    bridge.start();
    return () => bridge.dispose();
  },
});
