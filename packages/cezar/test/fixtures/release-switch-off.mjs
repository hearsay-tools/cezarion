// Fake-name release fixtures assert the shipped publication graph.
// scripts/release-identity.test.mjs covers real identities and order in both states.
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/home/switch.js')) {
      return { format: 'module', source: 'export const REBRAND_SWITCH = false;\n', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
