import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type Step = { reason: string; activeBefore?: string[] };
type Outcome = { flags: Array<[string, unknown]>; events: string[]; calls: string[][]; active: string[] };

/**
 * Loads the extension in a child node, the way pi loads it, against a fake pi API. Each step
 * fires one session_start; `activeBefore` stands for pi (or its MCP extension) having set the
 * active tools since the previous step.
 */
function drive(flag: unknown, initial: string[], steps: Step[]): Outcome {
  const extensionUrl = new URL('../../scripts/pi-default-tools.mjs', import.meta.url);
  const source = `
    import register from ${JSON.stringify(extensionUrl.href)};
    const flags = new Map();
    const handlers = new Map();
    const calls = [];
    let active = ${JSON.stringify(initial)};
    register({
      registerFlag(name, options) { flags.set(name, options); },
      getFlag(name) { return flags.has(name) ? ${JSON.stringify(flag)} ?? undefined : undefined; },
      on(type, callback) { handlers.set(type, [...(handlers.get(type) ?? []), callback]); },
      getActiveTools() { return [...active]; },
      setActiveTools(names) { calls.push([...names]); active = [...names]; },
    });
    for (const step of ${JSON.stringify(steps)}) {
      if (step.activeBefore) active = step.activeBefore;
      for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start', reason: step.reason }, {});
    }
    process.stdout.write(JSON.stringify({ flags: [...flags], events: [...handlers.keys()], calls, active }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' }));
}

const BUILTINS = 'read,edit,write,grep,find,bash';

describe('pi default-tools extension (hearsay-tools/cezarion#1305)', () => {
  it('registers the cezar-builtin-tools string flag and listens to session_start only', () => {
    const outcome = drive(BUILTINS, [], []);
    expect(outcome.flags).toEqual([['cezar-builtin-tools', expect.objectContaining({ type: 'string' })]]);
    expect(outcome.events).toEqual(['session_start']);
  });

  it('adds the named built-ins to the active tools, keeping what is already active', () => {
    const outcome = drive(BUILTINS, ['codemode', 'cezar_wait', 'read'], [{ reason: 'startup' }]);
    expect(outcome.active).toEqual(['codemode', 'cezar_wait', 'read', 'edit', 'write', 'grep', 'find', 'bash']);
  });

  it('runs on every session_start, so a resumed or new session gets the built-ins again', () => {
    const outcome = drive(BUILTINS, [], [
      { reason: 'startup' },
      { reason: 'resume', activeBefore: ['tool_search'] },
      { reason: 'new', activeBefore: [] },
      { reason: 'reload', activeBefore: ['codemode'] },
    ]);
    expect(outcome.calls).toEqual([
      ['read', 'edit', 'write', 'grep', 'find', 'bash'],
      ['tool_search', 'read', 'edit', 'write', 'grep', 'find', 'bash'],
      ['read', 'edit', 'write', 'grep', 'find', 'bash'],
      ['codemode', 'read', 'edit', 'write', 'grep', 'find', 'bash'],
    ]);
  });

  it('ignores blank entries in the flag', () => {
    expect(drive(' read, ,bash,', ['codemode'], [{ reason: 'startup' }]).active).toEqual(['codemode', 'read', 'bash']);
  });

  it.each([
    ['an empty flag', ''],
    ['an absent flag', null],
    ['a flag given without a value', true],
  ])('does nothing for %s', (_label, flag) => {
    const outcome = drive(flag, ['codemode'], [{ reason: 'startup' }]);
    expect(outcome.calls).toEqual([]);
    expect(outcome.active).toEqual(['codemode']);
  });
});
