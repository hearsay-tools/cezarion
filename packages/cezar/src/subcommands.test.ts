import { describe, expect, it } from 'vitest';
import { loadSubcommand, runSubcommand, SUBCOMMAND_NAMES } from './subcommands.ts';

describe('CLI subcommands', () => {
  it('loads a runner for every subcommand', async () => {
    for (const name of SUBCOMMAND_NAMES) expect(typeof (await loadSubcommand(name))).toBe('function');
  });

  it('leaves the cockpit commands and flags to index.ts', async () => {
    expect(await runSubcommand([], {})).toBeUndefined();
    expect(await runSubcommand(['run', 'do it'], {})).toBeUndefined();
    expect(await runSubcommand(['--port', '4321'], {})).toBeUndefined();
    expect(await runSubcommand(['toString'], {})).toBeUndefined();
  });

  it('runs a subcommand with the rest of argv and answers its exit code (#1576)', async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      expect(await runSubcommand(['webhook', 'list'], {})).toBe(2);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ code: 'no-cockpit' });
  });
});
