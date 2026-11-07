import { REBRAND_SWITCH } from '../home/switch.ts';

/** Product settings accept the new name immediately, including an explicitly empty value.
 * HOME is special: resolution uses the two home accessors below, never ordinary fallback.
 * Generated child names remain controller-owned; reading a setting grants no child authority.
 */
export function productEnv(suffix: string, env: NodeJS.ProcessEnv = process.env, caseInsensitive = false): string | undefined {
  const read = (name: string) => {
    if (!caseInsensitive || env[name] !== undefined) return env[name];
    return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  };
  return read(`HSQ_${suffix}`) ?? read(`CEZ_${suffix}`);
}

/** The migration source and switch-off layout always select the legacy locator alone. */
export function legacyHomeEnv(env: NodeJS.ProcessEnv): string | undefined { return env.CEZ_HOME; }

/** Split layout handles empty locators and the legacy-default exception itself. */
export function preferredHomeEnv(env: NodeJS.ProcessEnv): string | undefined { return env.HSQ_HOME; }

/** Collect independently of reads: include shadowed, empty and no-longer-read names, never values. */
export function legacyEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(name => name.startsWith('CEZ_') && env[name] !== undefined).sort();
}

/** Controller-generated entries keep legacy children working during the rename window.
 * Both names carry the exact value, including intentional clears. */
export function productEnvEntries(suffix: string, value: string, rebrand = REBRAND_SWITCH): Record<string, string> {
  return rebrand ? { [`HSQ_${suffix}`]: value, [`CEZ_${suffix}`]: value } : { [`CEZ_${suffix}`]: value };
}

/** Hosted mode fails closed across old service files and inherited preferred names.
 * Neither an empty value nor 0 may disable a hosted-mode pin under the other prefix. */
export function remoteEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HSQ_REMOTE === '1' || env.CEZ_REMOTE === '1';
}
