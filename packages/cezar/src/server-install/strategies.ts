import { macosxNgrok } from './platforms/macosx-ngrok.ts';
import { ubuntuVps } from './platforms/ubuntu-vps.ts';
import { PLATFORM_IDS, type PlatformId, type PlatformStrategy } from './types.ts';

/**
 * Platform registry. `--platform <id>` is validated against these keys; an
 * unknown id lists the valid ones and exits 1. Add a strategy here to teach the
 * wizard a new platform — the engine and helpers are untouched.
 */
const REGISTRY: Partial<Record<PlatformId, PlatformStrategy>> = {
  'ubuntu-vps': ubuntuVps,
  'macosx-ngrok': macosxNgrok,
};

export function getStrategy(id: string): PlatformStrategy | undefined {
  return REGISTRY[id as PlatformId];
}

/** Ids that actually have a registered strategy (a subset of PLATFORM_IDS while phased). */
export function availablePlatformIds(): PlatformId[] {
  return PLATFORM_IDS.filter((id) => REGISTRY[id] !== undefined);
}

/** Group migration requires reversible resource moves and control of every service. */
export function supportsServerMigration(strategy: PlatformStrategy | undefined): strategy is PlatformStrategy &
  Required<Pick<PlatformStrategy, 'migrate' | 'rollbackMigration' | 'stopService' | 'startService'>> {
  return !!(strategy?.migrate && strategy.rollbackMigration && strategy.stopService && strategy.startService);
}
