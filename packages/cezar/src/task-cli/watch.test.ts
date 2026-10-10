import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTaskCommand, type TaskIo } from './cli.ts';
import { pollHitDeadline, abortedPoll, TIMEOUT_GRACE_MS } from './watch.ts';
import { TaskCliError } from './http.ts';
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
      expect(last()).toMatchObject({ until: 'attention', runs: [{ id, status: 'waiting', attention: 'waiting', attentionLabel: 'needs you' }] });
    });

    /**
     * #553/#609: the CLI judges "does this run want me" with the cockpit's own attention
     * function, and `attention` is the default `--until`. A parked interactive task ends the
     * wait promptly; a root parked on its own workers and a monitoring run do not.
     */
    describe('attention is the default, derived from the shared function', () => {
      const parkedOnWorkers = (id: string) => harness.store.updateRun(id, {
        status: 'waiting',
        delegation: { role: 'root', permissions: [], receipts: [], wait: { id: '00000000-0000-4000-8000-0000000000aa', workerIds: ['00000000-0000-4000-8000-000000000001'], deadline: '2026-09-06T00:00:00.000Z', phase: 'parked', outcomes: [] } },
      } as never);

      it('ends the default wait as soon as an interactive task parks, exit 0, with "needs you"', async () => {
        const id = create();
        later(40, () => harness.store.updateRun(id, { status: 'waiting', hasPendingHumanAsk: false }));
        const started = Date.now();
        expect(await run(['wait', id, '--timeout-seconds', '10'])).toBe(0);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(last()).toMatchObject({
          until: 'attention', timedOut: false,
          runs: [{ id, status: 'waiting', hasPendingHumanAsk: false, attention: 'waiting', attentionLabel: 'needs you' }],
        });
      });

      it('does not end an attention wait on a root parked on its own workers', async () => {
        const id = create();
        later(40, () => parkedOnWorkers(id));
        expect(await run(['wait', id, '--timeout-seconds', '1'])).toBe(3);
        expect(last()).toMatchObject({ until: 'attention', timedOut: true, runs: [{ id, status: 'waiting', attention: 'none', attentionLabel: 'waiting on 1 worker' }] });
      });

      it('does not end an attention wait on a running or monitoring run', async () => {
        const id = create();
        later(40, () => harness.store.updateRun(id, { status: 'running', activity: 'monitoring' }));
        expect(await run(['wait', id, '--timeout-seconds', '1'])).toBe(3);
        expect(last()).toMatchObject({ timedOut: true, runs: [{ id, status: 'running', activity: 'monitoring', attention: 'running', attentionLabel: 'monitoring' }] });
        harness.store.updateRun(id, { status: 'running', activity: undefined });
        expect(await run(['wait', id, '--timeout-seconds', '1'])).toBe(3);
        expect(last()).toMatchObject({ timedOut: true, runs: [{ id, status: 'running', attention: 'running', attentionLabel: 'running' }] });
      });

      it('--until settled is unchanged: it waits through a waiting park and stops on a terminal status', async () => {
        const id = create();
        later(40, () => harness.store.updateRun(id, { status: 'waiting' }));
        expect(await run(['wait', id, '--until', 'settled', '--timeout-seconds', '1'])).toBe(3);
        expect(last()).toMatchObject({ until: 'settled', timedOut: true, runs: [{ id, status: 'waiting', attention: 'waiting', attentionLabel: 'needs you' }] });
        later(40, () => harness.store.updateRun(id, { status: 'done' }));
        expect(await run(['wait', id, '--until', 'settled', '--timeout-seconds', '10'])).toBe(0);
        expect(last()).toMatchObject({ until: 'settled', timedOut: false, runs: [{ id, status: 'done', attention: 'none', attentionLabel: 'done' }] });
      });

      it('stops on a failed run under either until, exit 1, with the error bucket', async () => {
        const id = create();
        later(40, () => harness.store.updateRun(id, { status: 'failed' }));
        expect(await run(['wait', id, '--timeout-seconds', '10'])).toBe(1);
        expect(last()).toMatchObject({ runs: [{ id, status: 'failed', attention: 'error', attentionLabel: 'failed' }] });
      });
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
      expect(last()).toMatchObject({ created: true, status: 'done', timedOut: false, until: 'attention', attention: 'none', attentionLabel: 'done' });
    });

    it('returns promptly, exit 0, once an interactive task parks for follow-up (#553)', async () => {
      const waiting = run(['start', 'go', '--wait', '--timeout-seconds', '10']);
      const poll = setInterval(() => {
        const created = harness.store.listRuns()[0];
        if (created) { harness.store.updateRun(created.id, { status: 'waiting' }); clearInterval(poll); }
      }, 20);
      const started = Date.now();
      expect(await waiting).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(last()).toMatchObject({ created: true, status: 'waiting', timedOut: false, until: 'attention', attention: 'waiting', attentionLabel: 'needs you' });
    });

    it('--until settled keeps waiting through the park', async () => {
      const waiting = run(['start', 'go', '--wait', '--until', 'settled', '--timeout-seconds', '1']);
      const poll = setInterval(() => {
        const created = harness.store.listRuns()[0];
        if (created) { harness.store.updateRun(created.id, { status: 'waiting' }); clearInterval(poll); }
      }, 20);
      expect(await waiting).toBe(3);
      expect(last()).toMatchObject({ created: true, status: 'waiting', timedOut: true, until: 'settled' });
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

    /**
     * #931: `log --follow` ends the way `wait` does. A parked interactive task ends a default
     * follow promptly; a root parked on its own workers and a monitoring run keep it streaming;
     * `--until settled` keeps the terminal-only behaviour.
     */
    describe('--follow until attention (#931)', () => {
      const parkedOnWorkers = (id: string, hasPendingHumanAsk = false) => harness.store.updateRun(id, {
        status: 'waiting',
        hasPendingHumanAsk,
        delegation: { role: 'root', permissions: [], receipts: [], wait: { id: '00000000-0000-4000-8000-0000000000aa', workerIds: ['00000000-0000-4000-8000-000000000001'], deadline: '2026-09-06T00:00:00.000Z', phase: 'parked', outcomes: [] } },
      } as never);

      it('ends a default follow once an interactive task parks, exit 0, after every event', async () => {
        const id = create();
        harness.store.appendEvent(id, { type: 'text', text: 'before' });
        later(100, () => harness.store.appendEvent(id, { type: 'text', text: 'during' }));
        later(200, () => harness.store.updateRun(id, { status: 'waiting', hasPendingHumanAsk: false }));
        const started = Date.now();
        expect(await run(['log', id, '--follow', '--timeout-seconds', '10'])).toBe(0);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(lines().filter((line) => line.type === 'text').map((line) => line.text)).toEqual(['before', 'during']);
        expect(last()).toEqual({ id, status: 'waiting', attention: 'waiting', attentionLabel: 'needs you', until: 'attention', timedOut: false });
      });

      it('ends at the replay boundary when the task is already parked', async () => {
        const id = create();
        harness.store.appendEvent(id, { type: 'text', text: 'turn' });
        harness.store.updateRun(id, { status: 'waiting' });
        expect(await run(['log', id, '--follow', '--timeout-seconds', '10'])).toBe(0);
        expect(lines().map((line) => line.text ?? line.status)).toEqual(['turn', 'waiting']);
        expect(last()).toMatchObject({ attention: 'waiting', until: 'attention', timedOut: false });
      });

      it('does not end on a root parked on its own workers, until a human question arrives', async () => {
        const id = create();
        later(40, () => parkedOnWorkers(id));
        expect(await run(['log', id, '--follow', '--timeout-seconds', '1'])).toBe(3);
        expect(last()).toMatchObject({ id, status: 'waiting', attention: 'none', attentionLabel: 'waiting on 1 worker', until: 'attention', timedOut: true });
        // Same status and activity: only the question changes, and the follow still notices.
        later(300, () => parkedOnWorkers(id, true));
        expect(await run(['log', id, '--follow', '--timeout-seconds', '10'])).toBe(0);
        expect(last()).toMatchObject({ id, status: 'waiting', attention: 'waiting', attentionLabel: 'needs you', timedOut: false });
      });

      it('does not end on a running or monitoring run', async () => {
        const id = create();
        later(40, () => harness.store.updateRun(id, { status: 'running', activity: 'monitoring' }));
        expect(await run(['log', id, '--follow', '--timeout-seconds', '1'])).toBe(3);
        expect(last()).toMatchObject({ id, status: 'running', attention: 'running', attentionLabel: 'monitoring', until: 'attention', timedOut: true });
      });

      it.each(['attention', 'settled'])('reports a run deleted mid-follow as missing, exit 1, under --until %s', async (until) => {
        const id = create();
        harness.store.updateRun(id, { status: 'running' });
        harness.store.appendEvent(id, { type: 'text', text: 'before' });
        later(200, () => { harness.store.deleteRun(id); });
        expect(await run(['log', id, '--follow', '--until', until, '--timeout-seconds', '10'])).toBe(1);
        expect(lines().filter((line) => line.type === 'text').map((line) => line.text)).toEqual(['before']);
        expect(last()).toEqual({ id, status: 'missing', until, timedOut: false });
      });

      it('--until settled waits through a park and ends on a terminal status', async () => {
        const id = create();
        later(40, () => harness.store.updateRun(id, { status: 'waiting' }));
        expect(await run(['log', id, '--follow', '--until', 'settled', '--timeout-seconds', '1'])).toBe(3);
        expect(last()).toMatchObject({ id, status: 'waiting', attention: 'waiting', until: 'settled', timedOut: true });
        later(200, () => harness.store.updateRun(id, { status: 'cancelled' }));
        expect(await run(['log', id, '--follow', '--until', 'settled', '--timeout-seconds', '10'])).toBe(1);
        expect(last()).toEqual({ id, status: 'cancelled', attention: 'none', attentionLabel: 'cancelled', until: 'settled', timedOut: false });
      });
    });
  });
});

/**
 * Review round 1 (#504): behaviour a real cockpit cannot be timed into reliably, so a fake one
 * scripts the exact wire — a slow `/run-summaries`, and a live `run` frame landing mid-replay.
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
      if (req.url === '/api/v1/p/default/run-summaries') setTimeout(() => json(res, [apiRun('queued')]), 4_000);
      else { res.statusCode = 404; res.end(); }
    };
    const started = Date.now();
    expect(await run(['wait', 'r1', '--timeout-seconds', '1'])).toBe(3);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ timedOut: true, runs: [{ id: 'r1' }] });
  });

  it('wait reports a connection lost mid-budget as unavailable (exit 2), not a timeout', async () => {
    // The socket dies 750ms into a 1s budget — inside the abort grace window,
    // but not an abort, so the exact deadline check still applies.
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/run-summaries') setTimeout(() => res.destroy(), 750);
      else { res.statusCode = 404; res.end(); }
    };
    expect(await run(['wait', 'r1', '--timeout-seconds', '1'])).toBe(2);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ code: 'unavailable' });
  });

  it('falls back to GET /runs when an older cockpit has no summary route (#817)', async () => {
    const seen: string[] = [];
    handler = (req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/api/v1/p/default/runs') return json(res, [{ ...apiRun('done'), id: 'r1' }]);
      res.statusCode = 404;
      json(res, { error: 'not found' });
    };
    expect(await run(['wait', 'r1', '--timeout-seconds', '5'])).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ timedOut: false, runs: [{ id: 'r1', status: 'done' }] });
    expect(await run(['list'])).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ total: 1, runs: [{ id: 'r1', status: 'done' }] });
    expect(seen.slice(0, 2)).toEqual(['/api/v1/p/default/run-summaries', '/api/v1/p/default/runs']);
  });

  it('passes a non-404 summary refusal through without the fallback', async () => {
    const seen: string[] = [];
    handler = (req, res) => {
      seen.push(req.url ?? '');
      res.statusCode = 409;
      json(res, { error: 'project root is gone' });
    };
    expect(await run(['list'])).toBe(2);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ code: 'refused', status: 409, error: 'project root is gone' });
    expect(seen).toEqual(['/api/v1/p/default/run-summaries?archived=recent']);
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

  it('log --follow drains events written before a terminal run frame that overtook them', async () => {
    let historyCalls = 0;
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs/r1') return json(res, apiRun('done'));
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) {
        historyCalls += 1;
        // The snapshot before connecting saw only seq 1; by the time the run is terminal, 3.
        return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: historyCalls === 1 ? 1 : 3, hasOlder: false });
      }
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const text = (seq: number) => frame('run-event', { seq, ts: '2026-01-01T00:00:00.000Z', type: 'text', text: `t${seq}` });
        text(1);
        frame('run', apiRun('done'));
        setTimeout(() => { text(2); text(3); }, 50);
        return;
      }
      res.statusCode = 404; res.end();
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(0);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.type === 'text').map((line) => line.text)).toEqual(['t1', 't2', 't3']);
    expect(lines.at(-1)).toMatchObject({ id: 'r1', status: 'done' });
  });

  it('log --follow drains events written before a parked run frame that overtook them (#931)', async () => {
    let historyCalls = 0;
    const seen: string[] = [];
    handler = (req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/api/v1/p/default/runs/r1') return json(res, { ...apiRun('waiting'), hasPendingHumanAsk: false });
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) {
        historyCalls += 1;
        return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: historyCalls === 1 ? 1 : 3, hasOlder: false });
      }
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const text = (seq: number) => frame('run-event', { seq, ts: '2026-01-01T00:00:00.000Z', type: 'text', text: `t${seq}` });
        text(1);
        frame('run', apiRun('waiting'));
        setTimeout(() => { text(2); text(3); }, 50);
        return;
      }
      res.statusCode = 404; res.end();
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(0);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.type === 'text').map((line) => line.text)).toEqual(['t1', 't2', 't3']);
    expect(lines.at(-1)).toEqual({ id: 'r1', status: 'waiting', attention: 'waiting', attentionLabel: 'needs you', until: 'attention', timedOut: false });
    // The attention judgement is the run read, not the frame.
    expect(seen).toContain('/api/v1/p/default/runs/r1');
  });

  it('log --follow reports a run deleted under it as missing, exit 1, without a history read (#931)', async () => {
    // Deleting a run 404s both its record and its history; the follow must not need the second.
    let deleted = false;
    let historyCalls = 0;
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs/r1') {
        if (deleted) { res.statusCode = 404; return json(res, { error: 'not found' }); }
        return json(res, apiRun('running'));
      }
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) {
        historyCalls += 1;
        if (deleted) { res.statusCode = 404; return json(res, { error: 'not found' }); }
        return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 0, hasOlder: false });
      }
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: run\ndata: ${JSON.stringify(apiRun('running'))}\n\n`);
        // A last frame for a record that is gone by the time the CLI reads it.
        setTimeout(() => { deleted = true; res.write(`event: run\ndata: ${JSON.stringify({ ...apiRun('running'), activity: 'monitoring' })}\n\n`); }, 50);
        return;
      }
      res.statusCode = 404; res.end();
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toEqual({ id: 'r1', status: 'missing', until: 'attention', timedOut: false });
    expect(historyCalls).toBe(1);
  });

  it('log --follow reports a run whose event stream closed because it was deleted as missing, exit 1 (#931)', async () => {
    let deleted = false;
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs/r1') {
        if (deleted) { res.statusCode = 404; return json(res, { error: 'not found' }); }
        return json(res, apiRun('running'));
      }
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 1, hasOlder: false });
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: run-event\ndata: ${JSON.stringify({ seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'text', text: 't1' })}\n\n`);
        res.write(`event: run\ndata: ${JSON.stringify(apiRun('running'))}\n\n`);
        // The server resets a deleted run's feed and closes the stream without a run frame.
        setTimeout(() => { deleted = true; res.end(); }, 50);
        return;
      }
      res.statusCode = 404; res.end();
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(1);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.text ?? line.status)).toEqual(['t1', 'missing']);
    expect(lines.at(-1)).toEqual({ id: 'r1', status: 'missing', until: 'attention', timedOut: false });
  });

  it('log --follow rejudges a run that resumes while the drain catches up, instead of ending stale (#931)', async () => {
    let resumed = false;
    let historyCalls = 0;
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs/r1') return json(res, apiRun(resumed ? 'running' : 'waiting'));
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) {
        historyCalls += 1;
        return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: historyCalls === 1 ? 1 : 3, hasOlder: false });
      }
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const text = (seq: number) => frame('run-event', { seq, ts: '2026-01-01T00:00:00.000Z', type: 'text', text: `t${seq}` });
        text(1);
        frame('run', apiRun('waiting'));
        // The caller answers before the drain catches up: the task is running again.
        setTimeout(() => { resumed = true; frame('run', apiRun('running')); }, 50);
        setTimeout(() => { text(2); text(3); }, 100);
        return;
      }
      res.statusCode = 404; res.end();
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '1'])).toBe(3);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.type === 'text').map((line) => line.text)).toEqual(['t1', 't2', 't3']);
    expect(lines.at(-1)).toEqual({ id: 'r1', status: 'running', attention: 'running', attentionLabel: 'running', until: 'attention', timedOut: true });
  });

  it('log --follow keeps the attention a run frame carried when it times out before the first run read (#931)', async () => {
    handler = (req, res) => {
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 5, hasOlder: false });
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // The replay never reaches seq 5, so the boundary (and its run read) never comes.
        res.write(`event: run-event\ndata: ${JSON.stringify({ seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'text', text: 't1' })}\n\n`);
        res.write(`event: run\ndata: ${JSON.stringify(apiRun('waiting'))}\n\n`);
        return;
      }
      res.statusCode = 404; res.end();
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '1'])).toBe(3);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.text ?? line.status)).toEqual(['t1', 'waiting']);
    expect(lines.at(-1)).toEqual({ id: 'r1', status: 'waiting', attention: 'waiting', attentionLabel: 'needs you', until: 'attention', timedOut: true });
  });

  it('log --follow reports a run deleted before its event stream connects as missing, exit 1 (#931)', async () => {
    // History answered, then the run was deleted: the events route and the run read both 404.
    handler = (req, res) => {
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 0, hasOlder: false });
      res.statusCode = 404;
      json(res, { error: 'not found' });
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toEqual({ id: 'r1', status: 'missing', until: 'attention', timedOut: false });
  });

  it('log --follow passes a non-404 events refusal through as exit 2', async () => {
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs/r1') return json(res, apiRun('running'));
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 0, hasOlder: false });
      res.statusCode = 409;
      json(res, { error: 'project root is gone' });
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(2);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ code: 'refused', status: 409, error: 'project root is gone' });
  });

  it('log --follow still reports a stream closed under a live run as unavailable (exit 2)', async () => {
    handler = (req, res) => {
      if (req.url === '/api/v1/p/default/runs/r1') return json(res, apiRun('running'));
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) return json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 0, hasOlder: false });
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: run\ndata: ${JSON.stringify(apiRun('running'))}\n\n`);
        setTimeout(() => res.end(), 50);
        return;
      }
      res.statusCode = 404; res.end();
    };
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(2);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ code: 'unavailable', error: 'the cockpit closed the event stream' });
  });

  it('log --follow counts loading history against --timeout-seconds', async () => {
    handler = (req, res) => {
      if (req.url?.startsWith('/api/v1/p/default/runs/r1/history')) {
        setTimeout(() => json(res, { events: [], itemCount: 0, liveCursor: 'c', asOfSeq: 0, hasOlder: false }), 4_000);
        return;
      }
      res.statusCode = 404; res.end();
    };
    const started = Date.now();
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '1'])).toBe(3);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ id: 'r1', timedOut: true });
  });

  it('log --follow prints the whole replay before reporting the terminal status', async () => {
    replayWithEarlyRunFrame();
    expect(await run(['log', 'r1', '--follow', '--timeout-seconds', '5'])).toBe(0);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.slice(0, 3).map((line) => line.text)).toEqual(['t1', 't2', 't3']);
    expect(lines.at(-1)).toMatchObject({ id: 'r1', status: 'done' });
  });
});

/**
 * The deadline boundary (#538): a budget-bounded poll whose abort lands a
 * millisecond short of the deadline still failed *at* the deadline, so `wait`
 * answers timeout (exit 3), not unavailable (exit 2).
 */
describe('pollHitDeadline', () => {
  const start = 1_000_000;
  const budget = 1_000;

  it('holds at and just before the deadline', () => {
    expect(pollHitDeadline(start, budget, start + budget)).toBe(true);
    expect(pollHitDeadline(start, budget, start + budget - 1)).toBe(true);
    expect(pollHitDeadline(start, budget, start + budget - TIMEOUT_GRACE_MS)).toBe(true);
  });

  it('lets a fast failure through as a genuine cockpit error', () => {
    expect(pollHitDeadline(start, budget, start + 5)).toBe(false);
    expect(pollHitDeadline(start, budget, start + budget - TIMEOUT_GRACE_MS - 1)).toBe(false);
  });
});

describe('abortedPoll', () => {
  it('recognises the budget abort fetchJson folds into unavailable', () => {
    const abort = new TaskCliError(2, { code: 'unavailable', error: 'cockpit request failed: The operation was aborted due to timeout' });
    expect(abortedPoll(abort)).toBe(true);
  });

  it('rejects genuine failures and non-CLI errors', () => {
    const refused = new TaskCliError(2, { code: 'unavailable', error: 'cockpit request failed: fetch failed' });
    expect(abortedPoll(refused)).toBe(false);
    expect(abortedPoll(new Error('boom'))).toBe(false);
  });
});
