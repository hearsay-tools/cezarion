import { productIdentity } from '../home/identity.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { apiRunSchema, runStatusSchema } from '@open-mercato/cezar-contract/runs';
import { describe, expect, it, vi } from 'vitest';
import { taskCliFixture } from './cli.testkit.ts';

/** The agent's open timer: the monitoring park since hearsay-tools/cezarion#1301. */
const openTimer = () => ({
  kind: WAIT_KIND.timer, id: randomUUID(), source: WAIT_SOURCE.agent, via: WAIT_VIA['monitoring-line'],
  registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), phase: WAIT_PHASE.open, turnId: 'turn-1', seconds: 600,
});

describe('cez task', () => {
  const ctx = taskCliFixture();
  const { run, last, start, worker } = ctx;

  describe('status', () => {
    it('prints the slim projection', async () => {
      const id = await start();
      expect(await run(['status', id])).toBe(0);
      const printed = last();
      expect(Object.keys(printed).sort()).toEqual(
        ['id', 'title', 'status', 'attention', 'attentionLabel', 'tokensUsed', 'url', 'handoffUrl'].sort(),
      );
      expect(printed).toMatchObject({ id, status: RUN_STATUS.queued, attention: 'none', attentionLabel: 'queued' });
    });

    // #609: the operator who cleared on a false pending-question flag read the wrong field. The
    // default projection now carries the cockpit's own answer, and `waiting` is attention with
    // or without a structured question; a run waiting on its own timer is neither settled nor
    // attention (the monitoring park is a timer wait since hearsay-tools/cezarion#1301).
    it('carries the cockpit attention bucket and label, from the shared function', async () => {
      const id = await start();
      setRunStatus(ctx.store, id, RUN_STATUS.waiting);
      expect(await run(['status', id])).toBe(0);
      expect(last()).toMatchObject({ status: RUN_STATUS.waiting, attention: 'waiting', attentionLabel: 'needs you' });
      ctx.store.commitWait(id, openTimer());
      expect(await run(['status', id])).toBe(0);
      expect(last()).toMatchObject({ status: RUN_STATUS.waiting, attention: 'running', attentionLabel: 'monitoring' });
    });

    it('prints the contract ApiRun with --full, without the derived attention fields', async () => {
      const id = await start();
      expect(await run(['status', '--full', id])).toBe(0);
      expect(apiRunSchema.safeParse(last()).success).toBe(true);
      expect(last()).not.toHaveProperty('attention');
      expect(last()).not.toHaveProperty('attentionLabel');
    });

    it('passes an unknown run id through as the cockpit refusal, exit 2', async () => {
      expect(await run(['status', 'bogus'])).toBe(2);
      expect(last()).toMatchObject({ code: 'refused', status: 404, error: 'not found' });
    });
  });

  describe('list', () => {
    it('lists and waits on a project history larger than the single-response byte cap', async () => {
      // Each task is valid at the API boundary; only the aggregate exceeds 3 MiB.
      const runs = Array.from({ length: 32 }, (_, index) => {
        const run = ctx.store.createRun({ title: `task ${index}`, workflow: 'quick-task', task: 'x'.repeat(100_000), steps: [] });
        setRunStatus(ctx.store, run.id, RUN_STATUS.done);
        return run;
      });
      expect(await run(['list', '--limit', '100'])).toBe(0);
      expect(last().runs).toHaveLength(32);
      expect(await run(['wait', runs[0]!.id, '--timeout-seconds', '10'])).toBe(0);
      expect(last()).toMatchObject({ timedOut: false, runs: [{ id: runs[0]!.id, status: RUN_STATUS.done }] });
    });

    it('reads the run summaries, and only --full reads every full record (#817)', async () => {
      await start('a');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['list'])).toBe(0);
        expect(await run(['list', '--all'])).toBe(0);
        expect(await run(['list', '--full'])).toBe(0);
        // #864: without --all the archived runs are filtered out anyway, so `list` reads the
        // windowed list; --all keeps every row.
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
          `${ctx.cockpit.api}/run-summaries?archived=recent`, `${ctx.cockpit.api}/run-summaries`, `${ctx.cockpit.api}/runs`,
        ]);
      } finally { fetchSpy.mockRestore(); }
    });

    it('lists slim rows newest first, hides archived unless --all, filters and limits', async () => {
      const a = await start('a');
      const b = await start('b');
      ctx.store.setArchived(a, true);
      expect(await run(['list'])).toBe(0);
      expect((last().runs as Array<{ id: string }>).map((row) => row.id)).toEqual([b]);
      expect(await run(['list', '--all'])).toBe(0);
      expect((last().runs as Array<{ id: string }>).map((row) => row.id).sort()).toEqual([a, b].sort());
      expect(await run(['list', '--all', '--limit', '1'])).toBe(0);
      expect(last().runs).toHaveLength(1);
      setRunStatus(ctx.store, b, RUN_STATUS.done);
      expect(await run(['list', '--status', 'done'])).toBe(0);
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.id)).toEqual([b]);
      expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'title', 'status', 'attention', 'attentionLabel', 'updatedAt'].sort());
      expect(rows[0]).toMatchObject({ attention: 'none', attentionLabel: 'done' });
    });

    it('carries attention + attentionLabel on default rows only, never on --full rows (#609)', async () => {
      const a = await start('a');
      const b = await start('b');
      setRunStatus(ctx.store, a, RUN_STATUS.waiting);
      setRunStatus(ctx.store, b, RUN_STATUS.waiting);
      ctx.store.commitWait(b, openTimer());
      expect(await run(['list'])).toBe(0);
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows.find((row) => row.id === a)).toMatchObject({ status: RUN_STATUS.waiting, attention: 'waiting', attentionLabel: 'needs you' });
      expect(rows.find((row) => row.id === b)).toMatchObject({ status: RUN_STATUS.waiting, attention: 'running', attentionLabel: 'monitoring' });
      expect(await run(['list', '--full'])).toBe(0);
      for (const row of last().runs as Array<Record<string, unknown>>) {
        expect(apiRunSchema.safeParse(row).success).toBe(true);
        expect(row).not.toHaveProperty('attention');
      }
    });

    it('leaves workers out of the list and its total, with or without --all (#635)', async () => {
      const parent = await start('parent');
      const child = worker(parent);
      for (const argv of [['list'], ['list', '--all'], ['list', '--full']]) {
        expect(await run(argv)).toBe(0);
        expect((last().runs as Array<{ id: string }>).map((row) => row.id)).toEqual([parent]);
        expect(last().total).toBe(1);
      }
      // Still id-addressed: the operator had to get the id from somewhere.
      expect(await run(['status', child])).toBe(0);
      expect(last()).toMatchObject({ id: child });
    });
  });

  describe('default output and help (#572, #573, #574)', () => {
    it.each(runStatusSchema.options)('prints only the next-action datum for %s rows', async (status) => {
      const id = await start();
      setRunStatus(ctx.store, id, status, { currentStepId: 'implement', pullRequestUrl: 'https://github.com/example/repo/pull/1', error: 'failed step\nstack trace', branch: 'cez/test', diffStat: { adds: 1, dels: 2, files: 1 }, tokensUsed: 123 });
      expect(await run(['list'])).toBe(0);
      const datum = status === 'running' ? { currentStepId: 'implement' }
        : status === 'done' || status === 'review' ? { pullRequestUrl: 'https://github.com/example/repo/pull/1' }
          : status === 'failed' ? { error: 'failed step…' } : {};
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id, title: 'do the thing', status, attention: expect.any(String), attentionLabel: expect.any(String),
        updatedAt: expect.any(String), ...datum,
      });
      const response = await fetch(`${ctx.cockpit.api}/runs`);
      expect(await run(['list', '--full'])).toBe(0);
      expect(last().runs).toEqual(await response.json());
    });

    it.each([
      ['199 characters', 'x'.repeat(199), 'x'.repeat(199)],
      ['200 characters', 'x'.repeat(200), 'x'.repeat(200)],
      ['201 characters', 'x'.repeat(201), `${'x'.repeat(199)}…`],
      ['multiple lines', 'first line\nsecond line', 'first line…'],
      ['CRLF', 'first line\r\nsecond line', 'first line…'],
      ['long first line', `${'x'.repeat(200)}\nsecond line`, `${'x'.repeat(199)}…`],
    ])('caps list errors: %s; keeps status and --full errors intact', async (_label, error, expected) => {
      const id = await start();
      setRunStatus(ctx.store, id, RUN_STATUS.failed, { error });
      expect(await run(['list'])).toBe(0);
      expect((last().runs as Array<Record<string, unknown>>)[0]?.error).toBe(expected);
      expect(await run(['status', id])).toBe(0);
      expect(last().error).toBe(error);
      const response = await fetch(`${ctx.cockpit.api}/runs/${id}`);
      expect(await run(['status', id, '--full'])).toBe(0);
      expect(last()).toEqual(await response.json());
    });

    it.each(['running', 'review', 'failed'] as const)('omits absent next-action fields for %s', async (status) => {
      const id = await start();
      setRunStatus(ctx.store, id, status);
      expect(await run(['list'])).toBe(0);
      const row = (last().runs as Array<Record<string, unknown>>)[0]!;
      for (const field of ['currentStepId', 'pullRequestUrl', 'error', 'branch', 'diffStat', 'tokensUsed']) {
        expect(row).not.toHaveProperty(field);
      }
    });

    it('always prints the existing handoff route on default status, including an unseeded run', async () => {
      const id = await start();
      expect(await run(['status', id])).toBe(0);
      expect(last().handoffUrl).toBe(`${ctx.cockpit.origin}/api/v1/p/default/runs/${id}/handoff`);
      const response = await fetch(last().handoffUrl as string);
      expect(response.status).toBe(200);
      expect(await run(['status', id, '--full'])).toBe(0);
      expect(last()).not.toHaveProperty('handoffUrl');
    });

    it.each([['list', '--help'], ['--help']])('enumerates exactly the contract statuses in %j', async (...args) => {
      expect(await run(args)).toBe(0);
      const line = ctx.out.at(-1)!.split('\n').find((line) => line.startsWith('  --status '));
      expect(line?.split('Only these statuses: ')[1]).toBe(`${runStatusSchema.options.join(', ')}.`);
      expect(ctx.discoveries).toBe(0);
    });

    it('repeats the contract statuses in invalid-value errors before discovery', async () => {
      expect(await run(['list', '--status', 'active'])).toBe(64);
      expect(last().error).toBe(`unknown status 'active'; one of ${runStatusSchema.options.join(', ')}`);
      expect(ctx.discoveries).toBe(0);
    });

    it.each([['send', '--help'], ['--help']])('teaches steer, answer and resume in %j', async (...args) => {
      expect(await run(args)).toBe(0);
      const help = ctx.out.at(-1)!;
      for (const text of [
        ("cez task send <id> 'Use the retry helper instead'").replace("cez", productIdentity().command),
        ("cez task send <id> 'Use option A'").replace("cez", productIdentity().command),
        ("cez task send <id> --resume '…'").replace("cez", productIdentity().command),
        'delivered', 'queued', 'resumed', 'attention: waiting', 'question',
        'Human input', 'delivery: not-delivered', 'next', '--text-file <path|->', '--text-file -', ("cez task start --help").replace("cez", productIdentity().command),
      ]) expect(help).toContain(text);
      expect(ctx.discoveries).toBe(0);
    });
  });
});
