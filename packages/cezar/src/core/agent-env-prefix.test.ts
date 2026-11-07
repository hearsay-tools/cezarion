import { expect, it } from 'vitest';
import { buildChildEnv, buildCommandEnv } from './agent-env.ts';
import { RUNNER_IDS } from './agent-runner.ts';

const authority = ['TOOL_TOKEN', 'TOOL_SOCKET', 'DELEGATION_TOKEN', 'DELEGATION_URL', 'COCKPIT_URL', 'PROJECT_ID', 'PREVIEW_CDP_URL'];
const builders = [
  ...RUNNER_IDS.map(backend => ({ name: backend, build: (source: NodeJS.ProcessEnv, extraEnv?: Record<string, string>) => buildChildEnv({ backend, source, extraEnv }) })),
  { name: 'command', build: (source: NodeJS.ProcessEnv, extraEnv?: Record<string, string>) => buildCommandEnv({ source, ...(extraEnv ? { extraEnv } : {}) }) },
];

for (const { name, build } of builders) {
  for (const prefix of ['CEZ', 'HSQ']) {
    it.each(['0', '1'])(`${name}: strips both authority prefixes before ${prefix} full-env=%s and passthrough`, full => {
      const names = ['CEZ', 'HSQ'].flatMap(p => [...authority, 'HOME'].flatMap(suffix => {
        const key = `${p}_${suffix}`;
        return [key, key.toLowerCase(), `${p[0]}${p.slice(1).toLowerCase()}_${suffix}`];
      }));
      const source = { ...Object.fromEntries(names.map(key => [key, 'parent'])),
        [`${prefix}_AGENT_ENV_FULL`]: full, [`${prefix}_ENV_PASSTHROUGH`]: names.join(','), PATH: '/bin' };
      const child = build(source);
      expect(Object.keys(child).filter(key => /^(CEZ|HSQ)_(HOME|TOOL_TOKEN|TOOL_SOCKET|DELEGATION_TOKEN|DELEGATION_URL|COCKPIT_URL|PROJECT_ID|PREVIEW_CDP_URL)$/i.test(key))).toEqual([]);
      const extra = Object.fromEntries(authority.map(suffix => [`${prefix}_${suffix}`, 'child']));
      const controlled = build(source, { ...extra, CEZ_HOME: '/forbidden', hsq_home: '/forbidden' });
      for (const suffix of authority) {
        expect(Object.keys(controlled).filter(key => key.toUpperCase().endsWith(`_${suffix}`))).toEqual([`${prefix}_${suffix}`]);
        expect(controlled[`${prefix}_${suffix}`]).toBe('child');
      }
      expect(controlled.CEZ_HOME).toBeUndefined();
      expect(controlled.hsq_home).toBeUndefined();
      expect(build(controlled)).toEqual(child);
    });
  }
  it(`${name}: product overrides remove inherited aliases under either prefix`, () => {
    expect(build({ HSQ_DRY_RUN: 'parent', cez_dry_run: 'parent', CEZ_AGENT_ENV_FULL: '1' }, { CEZ_DRY_RUN: 'child' }))
      .toEqual({ CEZ_AGENT_ENV_FULL: '1', CEZ_DRY_RUN: 'child' });
    expect(build({ CEZ_DRY_RUN: 'parent', hsq_dry_run: 'parent' }, { HSQ_DRY_RUN: 'child' })).toEqual({ HSQ_DRY_RUN: 'child' });
  });
  it(`${name}: empty new toggles override legacy opt-ins`, () => {
    expect(build({ HSQ_AGENT_ENV_FULL: '', CEZ_AGENT_ENV_FULL: '1', HSQ_ENV_PASSTHROUGH: '', CEZ_ENV_PASSTHROUGH: 'CUSTOM', CUSTOM: 'private' }).CUSTOM).toBeUndefined();
  });
}
