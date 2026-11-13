import assert from 'node:assert/strict';
import type { createRunner as RunnerFactory } from '../../src/core/runner-factory.ts';
import type { AgentEvent } from '../../src/core/agent-runner.ts';

// Types resolve from source; the bootstrap passes the installed runner factory.
export async function probe({ createRunner }: { createRunner: typeof RunnerFactory }): Promise<void> {
  assert.deepEqual(process.execArgv, []);
  assert.equal(process.env.NODE_OPTIONS, '');
  process.env.CEZ_DRY_RUN = '1';
  delete process.env.CEZ_CURSOR_BIN;
  for (const transport of [undefined, 'cursor-acp'] as const) {
    const events: AgentEvent[] = [];
    const runner = createRunner('cursor', transport ? { sessionTransport: transport } : {});
    const result = await runner.run({ cwd: process.cwd(), userPrompt: 'mock:cezar-done', toolGrant: { kind: 'unset' }, timeoutMs: 10_000 }, event => events.push(event));
    assert.equal(events.find(event => event.type === 'session')?.sessionTransport, 'cursor-print');
    // mock:cezar-done answers 'Done.' after its cezar_done call; a bare runner has no tool controller,
    // so the turn text is the reply the print transport carried, not a completion.
    assert.match(result.text, /^Done\./);
    assert.equal(events.some(event => event.type === 'error'), false);
  }
}
