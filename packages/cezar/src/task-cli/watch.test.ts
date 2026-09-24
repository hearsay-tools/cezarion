import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTaskCommand, type TaskIo } from './cli.ts';
import { startTestCockpit, type TestCockpit } from './cockpit.testkit.ts';

/** `cez task wait` / `log` / `log --follow` / `start --wait` (#504). */
describe('cez task watching', () => {
  let harness: TestCockpit;
  let out: string[];

  beforeEach(async () => { harness = await startTestCockpit(); out = []; });
  afterEach(() => harness.close());

  const io: () => TaskIo = () => ({ stdout: (line) => out.push(line), discover: async () => harness.cockpit, pollMs: 20 });
  const run = (argv: string[]) => runTaskCommand(argv, {}, io());
  const last = () => JSON.parse(out.at(-1) ?? 'null') as Record<string, unknown>;
  const lines = () => out.map((line) => JSON.parse(line) as Record<string, unknown>);
  const create = (task = 't') => harness.store.createRun({ title: task, workflow: 'quick-task', task, steps: [] }).id;
  const later = (ms: number, action: () => void) => setTimeout(action, ms);

  describe('wait', () => {
    it('exits 0 once the run reaches review', async () => {
      const id = create();
      later(60, () => harness.store.updateRun(id, { status: 'review' }));
      expect(await run(['wait', id, '--timeout-seconds', '10'])).toBe(0);
      expect(last()).toMatchObject({ timedOut: false, runs: [{ id, status: 'review' }] });
    });

    it('exits 1 when the run fails', async () => {
      const id = create();
      later(60, () => harness.store.updateRun(id, { status: 'failed' }));
      expect(await run(['wait', id, '--timeout-seconds', '10'])).toBe(1);
      expect(last()).toMatchObject({ runs: [{ id, status: 'failed' }] });
    });

    it('exits 3 on timeout and still prints the statuses', async () => {
      const id = create();
      expect(await run(['wait', id, '--timeout-seconds', '1'])).toBe(3);
      expect(last()).toMatchObject({ timedOut: true, runs: [{ id, status: 'queued' }] });
    });

    it('--mode any returns on the first settled run, --mode all waits for every run', async () => {
      const a = create('a');
      const b = create('b');
      later(40, () => harness.store.updateRun(a, { status: 'done' }));
      expect(await run(['wait', a, b, '--mode', 'any', '--timeout-seconds', '10'])).toBe(0);
      expect(last()).toMatchObject({ timedOut: false });
      later(40, () => harness.store.updateRun(b, { status: 'cancelled' }));
      expect(await run(['wait', a, b, '--mode', 'all', '--timeout-seconds', '10'])).toBe(1);
      expect((last().runs as Array<{ status: string }>).map((entry) => entry.status)).toEqual(['done', 'cancelled']);
    });

    it('--until attention also stops on waiting', async () => {
      const id = create();
      later(40, () => harness.store.updateRun(id, { status: 'waiting' }));
      expect(await run(['wait', id, '--until', 'attention', '--timeout-seconds', '10'])).toBe(0);
      expect(last()).toMatchObject({ runs: [{ id, status: 'waiting' }] });
    });

    it('reports a run that disappears as missing, exit 1, without waiting for the timeout', async () => {
      const id = create();
      later(40, () => { harness.store.deleteRun(id); });
      const started = Date.now();
      expect(await run(['wait', id, '--timeout-seconds', '30'])).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(last()).toMatchObject({ runs: [{ id, status: 'missing' }] });
    });

    it.each([[['wait']], [['wait', 'x', '--timeout-seconds', '0']], [['wait', 'x', '--timeout-seconds', '1801']], [['wait', 'x', '--mode', 'some']], [['wait', 'x', '--until', 'later']]])(
      'rejects %j as a usage error', async (argv) => {
        expect(await run(argv)).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input' });
      });
  });

  describe('start --wait', () => {
    it('chains into wait and prints the final status in one object', async () => {
      const waiting = run(['start', 'go', '--wait', '--timeout-seconds', '10']);
      const poll = setInterval(() => {
        const created = harness.store.listRuns()[0];
        if (created) { harness.store.updateRun(created.id, { status: 'done' }); clearInterval(poll); }
      }, 20);
      expect(await waiting).toBe(0);
      expect(out).toHaveLength(1);
      expect(last()).toMatchObject({ created: true, status: 'done', timedOut: false });
    });
  });

  describe('log', () => {
    it('prints the six kinds as one JSON line each, oldest first, with their seq', async () => {
      const id = create();
      harness.store.appendEvent(id, { type: 'step-start', stepId: 'work', name: 'Work', iteration: 1 });
      harness.store.appendEvent(id, { type: 'text', stepId: 'work', text: 'hello' });
      harness.store.appendEvent(id, { type: 'note', message: 'ignored' });
      harness.store.appendEvent(id, { type: 'tool-call', tool: 'Bash', input: { command: 'ls' } });
      harness.store.appendEvent(id, { type: 'tool-result', result: 'a\nb' });
      harness.store.appendEvent(id, { type: 'user-message', text: 'steer' });
      harness.store.appendEvent(id, { type: 'error', message: 'boom' });
      expect(await run(['log', id])).toBe(0);
      const printed = lines();
      expect(printed.map((line) => line.type)).toEqual(['step-start', 'text', 'tool-call', 'tool-result', 'user-message', 'error']);
      expect(printed.map((line) => line.seq)).toEqual([...printed.map((line) => line.seq as number)].sort((a, b) => a - b));
      expect(printed[1]).toMatchObject({ text: 'hello' });
    });

    it('keeps only the newest lines within --max-chars and honours --since', async () => {
      const id = create();
      for (let index = 0; index < 20; index += 1) harness.store.appendEvent(id, { type: 'text', text: `line ${index} ${'x'.repeat(50)}` });
      expect(await run(['log', id, '--max-chars', '300'])).toBe(0);
      const tail = lines();
      expect(out.join('\n').length).toBeLessThanOrEqual(300);
      expect(String(tail.at(-1)?.text)).toContain('line 19');
      out = [];
      const cut = tail[0]!.seq as number;
      expect(await run(['log', id, '--since', String(cut)])).toBe(0);
      expect(lines().every((line) => (line.seq as number) > cut)).toBe(true);
    });

    it('--follow streams new events and exits on a terminal status', async () => {
      const id = create();
      harness.store.appendEvent(id, { type: 'text', text: 'before' });
      later(100, () => harness.store.appendEvent(id, { type: 'text', text: 'during' }));
      later(200, () => harness.store.updateRun(id, { status: 'done' }));
      expect(await run(['log', id, '--follow', '--timeout-seconds', '10'])).toBe(0);
      const texts = lines().filter((line) => line.type === 'text').map((line) => line.text);
      expect(texts).toEqual(['before', 'during']);
      expect(last()).toMatchObject({ id, status: 'done' });
    });

    it('--follow exits 3 at the timeout', async () => {
      const id = create();
      expect(await run(['log', id, '--follow', '--timeout-seconds', '1'])).toBe(3);
      expect(last()).toMatchObject({ id, status: 'queued', timedOut: true });
    });

    it('passes an unknown run through as exit 2', async () => {
      expect(await run(['log', 'bogus'])).toBe(2);
    });
  });
});
