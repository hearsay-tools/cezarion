import { legacyEnvNames } from '../core/product-env.ts';
import { REBRAND_SWITCH } from './switch.ts';

/** One collector per boot. Reading settings does not determine which old names are reported. */
export function createLegacyEnvWarning() {
  let warned = false;
  return (env: NodeJS.ProcessEnv, {
    enabled = REBRAND_SWITCH, warn = console.warn,
  }: { enabled?: boolean; warn?: (message: string) => void } = {}): void => {
    if (!enabled || warned) return;
    const names = legacyEnvNames(env);
    if (names.length === 0) return;
    warned = true;
    warn(`[hsq] Legacy environment names are set: ${names.join(', ')}. Use the matching HSQ_* names. CEZ_HOME remains supported.`);
  };
}

export const warnLegacyEnv = createLegacyEnvWarning();
