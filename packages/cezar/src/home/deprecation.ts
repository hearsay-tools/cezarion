import type { HomeLayout } from './kind-roots.ts';
import { REBRAND_SWITCH } from './switch.ts';

/** Called once at CLI boot. Keep the disabled release path silent. */
export function warnLegacyHome(env: NodeJS.ProcessEnv, {
  layout = REBRAND_SWITCH ? 'split' : 'legacy', warn = console.warn,
}: { layout?: HomeLayout; warn?: (message: string) => void } = {}): void {
  if (layout === 'split' && env.CEZ_HOME !== undefined) {
    warn('[hsq] CEZ_HOME is deprecated. Rename it to HSQ_HOME.');
  }
}
