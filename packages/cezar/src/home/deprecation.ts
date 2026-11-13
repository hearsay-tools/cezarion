import { legacyEnvNames } from '../core/product-env.ts';

/** One collector per boot. Reading settings does not determine which old names are reported. */
export function createLegacyEnvWarning() {
  let warned = false;
  return (env: NodeJS.ProcessEnv, { warn = console.warn }: { warn?: (message: string) => void } = {}): void => {
    if (warned) return;
    const names = legacyEnvNames(env);
    if (names.length === 0) return;
    warned = true;
    warn(`[hsq] Legacy environment names are set: ${names.join(', ')}. Use the matching HSQ_* names. CEZ_HOME remains supported.`);
  };
}

export const warnLegacyEnv = createLegacyEnvWarning();
