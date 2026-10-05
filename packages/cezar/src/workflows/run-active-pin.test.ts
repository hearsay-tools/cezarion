import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * #779: the store keeps a run in memory while this manager executes it because every `ActiveRun`
 * enters `active` through `activate`, which pins it. A construction site that set `active` itself
 * would execute a run the store may evict between two writes — the #811 shape, where one of two
 * construction sites missed a field. Harness parity R48 drives both sites on every runner; this
 * pins the shape so a third site cannot appear without the pin.
 */
describe('RunManager pins every executing run through one helper', () => {
  const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');

  it('sets `active` in exactly one place, which also pins', () => {
    expect(source.match(/this\.active\.set\(/g)).toHaveLength(1);
    const activate = source.slice(source.indexOf('  private activate(runId: string, state: ActiveRun): void {'));
    expect(activate.slice(0, activate.indexOf('\n  }\n'))).toMatch(/this\.active\.set\(runId, state\);\s+this\.store\.pin\(runId, 'active'\);/);
  });

  it('builds an ActiveRun in execute and in runContinuation, and both go through activate', () => {
    const constructions = [...source.matchAll(/const state: ActiveRun = \{/g)].map((match) => match.index!);
    expect(constructions).toHaveLength(2);
    for (const [name, start] of [['runContinuation', source.indexOf('  private async runContinuation(')], ['execute', source.indexOf('  private async execute(')]] as const) {
      expect(start, name).toBeGreaterThan(0);
      const body = source.slice(start, source.indexOf('\n  }\n', start));
      expect(body, name).toContain('const state: ActiveRun = {');
      expect(body, name).toContain('this.activate(runId, state);');
    }
  });

  it('releases the pin where the run leaves `active`', () => {
    expect(source.match(/this\.active\.delete\(/g)).toHaveLength(1);
    expect(source).toMatch(/this\.active\.delete\(runId\);\s+this\.store\.unpin\(runId, 'active'\);/);
  });
});
