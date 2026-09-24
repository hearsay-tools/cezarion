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

/**
 * Review round 1 (#504): behaviour a real cockpit cannot be timed into reliably, so a fake one
 * scripts the exact wire — a slow `/runs`, and a live `run` frame landing mid-replay.
 */
describe('cez task watching against a scripted cockpit', () => {
  let server: import('node:http').Server;
  let origin: string;
  let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;
  const out: string[] = [];
  const apiRun = (status: string) => ({
    id: 'r1', title: 't', workflow: 'quick-task', task: 't', status, createdAt: '2026-01-01T00:00:00.000Z',
    tokensUsed: 0, archived: false, steps: [],
  });

  beforeEach(async () => {
    out.length = 0;
    const { createServer } = await import('node:http');
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const run = (argv: string[]) => runTaskCommand(argv, {}, {
    stdout: (line) => out.push(line),
    discover: async () => ({ origin, projectId: 'default', api: `${origin}/api/v1/p/default` }),
    pollMs: 20,
  });
  const json = (res: import('node:http').ServerResponse, body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  it('wait answers timeout (exit 3) on time even when a poll is slower than the budget', async () => {
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs') setTimeout(() => json(res, [apiRun('queued')]), 4_000);
      else { res.statusCode = 404; res.end(); }
    };
    const started = Date.now();
    expect(await run(['wait', 'r1', '--timeout-seconds', '1'])).toBe(3);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ timedOut: true, runs: [{ id: 'r1' }] });
  });

  /** Replay of seq 1..3 with a live `run` frame (already terminal) arriving after seq 1. */
  const replayWithEarlyRunFrame = () => {
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs/r1') return json(res, apiRun('done'));
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) {
        return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 3, hasOlder: false });
      }
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const text = (seq: number) => frame('run-event', { seq, ts: '2026-01-01T00:00:00.000Z', type: 'text', text: `t${seq}` });
        text(1);
        frame('run', apiRun('done'));
        text(2);
        text(3);
        frame('run', apiRun('done'));
        return;
      }
      res.statusCode = 404; res.end();
    };
  };

  it('log keeps replaying past a live run frame that lands mid-replay', async () => {
    replayWithEarlyRunFrame();
    expect(await run(['log', 'r1'])).toBe(0);
    expect(out.map((line) => JSON.parse(line).text)).toEqual(['t1', 't2', 't3']);
  });

  it('log --follow prints the whole replay before reporting the terminal status', async () => {
    replayWithEarlyRunFrame();
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(0);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.slice(0, 3).map((line) => line.text)).toEqual(['t1', 't2', 't3']);
    expect(lines.at(-1)).toMatchObject({ id: 'r1', status: 'done' });
  });
});
