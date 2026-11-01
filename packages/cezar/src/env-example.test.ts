import { describe, expect, it } from 'vitest';
import { envNames, undocumented } from './lint/undocumented-env-name.ts';

/**
 * The scanner behind `cez/undocumented-env-name`: `.env.example` documents every CEZ_* name a
 * shipped source or runner script uses. `npm run lint` applies it to the repository; these cases
 * pin what it finds.
 */
describe('.env.example contract', () => {
  it('finds process.env, env parameters and literal bracket access', () => {
    expect(envNames(`process.env.CEZ_ONE; env.CEZ_TWO; process.env['CEZ_THREE']; env["CEZ_FOUR"];`))
      .toEqual(['CEZ_FOUR', 'CEZ_ONE', 'CEZ_THREE', 'CEZ_TWO']);
  });

  it('ignores comments and examples inside strings, but scans template substitutions', () => {
    expect(envNames('// env.CEZ_COMMENT\n"process.env.CEZ_STRING"; `example ${env.CEZ_REAL}`;'))
      .toEqual(['CEZ_REAL']);
  });

  it('includes keys routed through constants and helpers', () => {
    expect(envNames("const prefix = 'CEZ_TOOL_'; const key = 'CEZ_KEY'; readEnv('CEZ_HELPER'); (opts.env ?? process.env).CEZ_FALLBACK;"))
      .toEqual(['CEZ_FALLBACK', 'CEZ_HELPER', 'CEZ_KEY']);
  });

  it('rejects an undocumented read and exempts every mock switch', () => {
    expect(undocumented('env.CEZ_NEW; env.CEZ_KNOWN; env.CEZ_MOCK_NEW;', new Set(['CEZ_KNOWN'])))
      .toEqual(['CEZ_NEW']);
  });
});
