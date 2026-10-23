import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestCockpit, type TestCockpit } from '../task-cli/cockpit.testkit.ts';
import { EXIT } from '../task-cli/cli.ts';
import { fetchJson, TaskCliError, type Cockpit, type HttpResult } from '../task-cli/http.ts';
import { automationPageUrl, bodyFromAddFlags, parseEvery, runAutomationCommand, type AutomationIo } from './automation-cli.ts';
import { AUTOMATION_SCHEMA_REFERENCE } from './prompts.ts';
import { resolveDelay } from '@open-mercato/cezar-contract/scheduled-tasks';

/**
 * `cez automation` (#774, port of upstream #985) against a real cockpit app on a real loopback
 * socket. What is pinned is the request the CLI builds, the one JSON object it prints, and its
 * exit code — never the routes, which have their own tests.
 */
describe('cez automation', () => {
  let harness: TestCockpit;
  let cockpit: Cockpit;
  let out: string[];
  let discoveries: number;
  let posted: Array<{ url: string; method: string; body: unknown }>;

  beforeEach(async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    harness = await startTestCockpit();
    cockpit = harness.cockpit;
    out = [];
    discoveries = 0;
    posted = [];
    // Record what reaches the wire, then let the real request through to the real app.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') posted.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return realFetch(input, init);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await harness.close();
  });

  const env = (): NodeJS.ProcessEnv => ({ CEZ_COCKPIT_URL: cockpit.origin, CEZ_PROJECT_ID: cockpit.projectId });
  const io = (extra: Partial<AutomationIo> = {}): AutomationIo => ({
    stdout: (line) => out.push(line),
    stdin: async () => '',
    discover: async () => { discoveries += 1; return cockpit; },
    sleep: async () => {},
    ...extra,
  });
  const run = (argv: string[], e: NodeJS.ProcessEnv = env(), extra?: Partial<AutomationIo>) => runAutomationCommand(argv, e, io(extra));
  const last = () => JSON.parse(out.at(-1) ?? 'null') as Record<string, unknown>;
  const strip = (body: unknown) => {
    const { id: _id, revision: _revision, createdAt: _c, updatedAt: _u, ...rest } = body as Record<string, unknown>;
    return rest;
  };

  it('list reads a catalog larger than the ordinary 3 MiB response cap', async () => {
    const prompt = 'x'.repeat(100_000);
    for (let index = 0; index < 32; index += 1) {
      expect(await run(['add', '--name', `big ${index}`, '--cron', '0 4 * * *', '--prompt', prompt])).toBe(EXIT.ok);
    }
    expect(await run(['list'])).toBe(EXIT.ok);
    expect((last().automations as unknown[]).length).toBe(32);
  }, 30_000);

  it('create fills the poll defaults the schema reference documents, so a minimal poll is accepted', async () => {
    // A poll is refused on a project without a github.com remote; give the test repo one.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: harness.repoRoot });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: harness.repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: harness.repoRoot });
    const minimal = { name: 'Review PRs', events: ['pull_request.opened'], task: { prompt: 'Review {{github.number}}' } };
    expect(await run(['create', '--json', JSON.stringify(minimal)]), out.join('\n')).toBe(EXIT.ok);
    expect(posted.at(-1)?.body).toEqual({ ...minimal, intervalSeconds: 300, filters: {} });
    expect(await run(['show', String(last().id)])).toBe(EXIT.ok);
    expect(last().automation).toMatchObject({ kind: 'github', enabled: false, intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 } });
  });

  describe('add', () => {
    it('builds exactly the body create --json sends, paused unless --enable', async () => {
      expect(await run(['add', '--name', 'N', '--cron', '0 7 * * 1-5', '--prompt', 'P'])).toBe(EXIT.ok);
      const expected = { name: 'N', kind: 'schedule', schedule: { type: 'weekdays', hour: 7, minute: 0 }, task: { prompt: 'P', worktree: true, autonomous: true } };
      expect(posted[0]?.body).toEqual(expected);
      expect(posted[0]?.body).not.toHaveProperty('enable');
      const added = last();
      expect(await run(['create', '--json', JSON.stringify(expected)])).toBe(EXIT.ok);
      expect(posted[1]?.body).toEqual(posted[0]?.body);
      const created = last();
      const read = async (id: string) => (await (await fetch(`${cockpit.api}/automations/${id}`)).json() as { automation: unknown }).automation;
      expect(strip(await read(String(created.id)))).toEqual(strip(await read(String(added.id))));
    });

    it('--enable adds enable: true and --no-autonomous turns autonomy off', async () => {
      expect(await run(['add', '--name', 'N', '--cron', '0 7 * * *', '--prompt', 'P', '--enable', '--no-autonomous'])).toBe(EXIT.ok);
      expect(posted[0]?.body).toMatchObject({ enable: true, task: { autonomous: false } });
      expect(last()).toMatchObject({ enabled: true });
    });

    it('opts a GitHub poll into existing matches without enabling it', () => {
      expect(bodyFromAddFlags({ name: 'History', on: 'issue.opened', 'include-existing': true }, 'Review')).toMatchObject({ filters: { includeExisting: true } });
      expect(bodyFromAddFlags({ name: 'History', on: 'issue.opened', 'include-existing': true }, 'Review')).not.toHaveProperty('enable');
      expect(() => bodyFromAddFlags({ name: 'Schedule', cron: '0 4 * * *', 'include-existing': true }, 'Go')).toThrow(/GitHub/);
    });

    it('--on/--every/--label define a GitHub poll', () => {
      expect(bodyFromAddFlags({ name: 'G', on: 'pull_request.opened', every: '5m', label: ['bug'] }, 'P')).toEqual({
        name: 'G', kind: 'github', events: ['pull_request.opened'], intervalSeconds: 300,
        filters: { lookbackDays: 7, maxRecords: 25, anyLabels: ['bug'] },
        task: { prompt: 'P', worktree: true, autonomous: true },
      });
      expect(bodyFromAddFlags({ name: 'G', on: 'issue.opened', author: ['alice'], workflow: 'w', runner: 'codex', model: 'm' }, 'P')).toMatchObject({
        intervalSeconds: 300, filters: { authors: ['alice'] }, task: { workflow: 'w', runner: 'codex', model: 'm' },
      });
    });

    // Review of #1018: a label event needs `filters.changedLabels`, which `--label` (anyLabels) cannot say.
    it('--changed-label defines a label event; a label event without it is a usage error', () => {
      expect(bodyFromAddFlags({ name: 'G', on: 'issue.labeled', 'changed-label': ['needs-agent'] }, 'P')).toMatchObject({
        events: ['issue.labeled'], filters: { changedLabels: ['needs-agent'] },
      });
      expect(() => bodyFromAddFlags({ name: 'G', on: 'issue.opened,issue.unlabeled' }, 'P')).toThrow(/--changed-label/);
    });

    it('add --on issue.labeled --changed-label creates a definition the cockpit accepts', async () => {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: harness.repoRoot });
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: harness.repoRoot });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: harness.repoRoot });
      expect(await run(['add', '--name', 'Triage', '--on', 'issue.labeled', '--changed-label', 'needs-agent', '--prompt', 'Triage {{github.number}}']), out.join('\n')).toBe(EXIT.ok);
      expect(posted.at(-1)?.body).toMatchObject({ filters: { changedLabels: ['needs-agent'] } });
    });

    it('parses --every', () => {
      expect(parseEvery('5m')).toBe(300);
      expect(parseEvery('2h')).toBe(7200);
      expect(parseEvery('90s')).toBe(90);
      expect(parseEvery('45')).toBe(45);
      expect(() => parseEvery('soon')).toThrow(TaskCliError);
    });
  });

  describe('usage (exit 64, before any address lookup)', () => {
    const usage = async (argv: string[]) => {
      out = [];
      // No address at all: a usage error must still be 64, not the no-cockpit 2.
      expect(await run(argv, {})).toBe(EXIT.usage);
      return last();
    };

    it('a cron shape add cannot express names the JSON form', async () => {
      const body = await usage(['add', '--name', 'x', '--cron', '*/15 * * * *', '--prompt', 'p']);
      expect(body.code).toBe('invalid_input');
      expect(String(body.error)).toContain('JSON form');
    });

    it('rejects --cron with --on, a missing name or prompt, an unknown command or flag, and a bad --every', async () => {
      await usage(['add', '--name', 'x', '--cron', '0 4 * * *', '--on', 'issue.opened', '--prompt', 'p']);
      await usage(['add', '--cron', '0 4 * * *', '--prompt', 'p']);
      await usage(['add', '--name', 'x', '--cron', '0 4 * * *']);
      await usage(['add', '--name', 'x', '--on', 'issue.opened', '--every', 'soon', '--prompt', 'p']);
      await usage(['add', '--name', 'x', '--cron', '0 4 * * *', '--prompt', 'p', '--dispatch']);
      await usage(['frobnicate']);
      await usage([]);
      await usage(['show']);
      await usage(['create', '--json', '{not json']);
      await usage(['create', '--json', '[1]']);
      await usage(['create']);
      expect(discoveries).toBe(0);
      expect(posted).toEqual([]);
    });
  });

  describe('address', () => {
    it('without CEZ_COCKPIT_URL or a flag exits 2 no-cockpit, never discovers and never suggests cez', async () => {
      expect(await run(['list'], {})).toBe(EXIT.refused);
      const body = last();
      expect(body.code).toBe('no-cockpit');
      expect(String(body.error)).toContain('automations are unavailable');
      expect(body).not.toHaveProperty('hint');
      expect(out.join('\n')).not.toMatch(/\bcez\b/);
      expect(discoveries).toBe(0);
    });

    it('--url, --repo or CEZ_URL runs discovery; its start-the-cockpit hint is dropped', async () => {
      expect(await run(['list', '--url', cockpit.origin], {})).toBe(EXIT.ok);
      expect(await run(['list', '--repo', harness.repoRoot], {})).toBe(EXIT.ok);
      expect(await run(['list'], { CEZ_URL: cockpit.origin })).toBe(EXIT.ok);
      expect(discoveries).toBe(3);
      const failing = async () => { throw new TaskCliError(2, { code: 'no-cockpit', error: 'no running cockpit serves /x', hint: 'start the cockpit in /x with: cez' }); };
      expect(await run(['list', '--url', 'http://127.0.0.1:1'], {}, { discover: failing })).toBe(EXIT.refused);
      expect(last()).toEqual({ code: 'no-cockpit', error: 'no running cockpit serves /x' });
    });

    // Review of #1018: a run recovery resumes can call the CLI before `startServer` replaces the
    // listener's plain-text "Cockpit is starting" 503, which never reached the API.
    it('retries the startup 503 and then serves the request; a JSON 503 is not retried', async () => {
      let starting = 2;
      const http: AutomationIo['http'] = async (url, init) => {
        if (starting > 0) { starting -= 1; return { status: 503, data: 'Cockpit is starting; retry shortly.\n' }; }
        return fetchJson(url, init);
      };
      expect(await run(['add', '--name', 'N', '--cron', '0 7 * * *', '--prompt', 'P'], env(), { http })).toBe(EXIT.ok);
      expect(posted).toHaveLength(1);
      const busy: AutomationIo['http'] = async () => ({ status: 503, data: { error: 'busy' } });
      expect(await run(['list'], env(), { http: busy })).toBe(EXIT.refused);
      expect(last()).toMatchObject({ status: 503, error: 'busy' });
    });

    it('every command retries the startup 503, delete included', async () => {
      expect(await run(['add', '--name', 'N', '--cron', '0 7 * * *', '--prompt', 'P'])).toBe(EXIT.ok);
      const id = String(last().id);
      const startingOnce = (): AutomationIo['http'] => {
        let starting = true;
        return async (url, init) => {
          if (starting) { starting = false; return { status: 503, data: 'Cockpit is starting; retry shortly.\n' }; }
          return fetchJson(url, init);
        };
      };
      for (const argv of [['list'], ['show', id], ['run', id], ['pause', id], ['enable', id], ['update', id, '--json', '{"name":"M"}'], ['delete', id]]) {
        expect(await run(argv, env(), { http: startingOnce() }), argv.join(' ')).toBe(EXIT.ok);
      }
    });

    // Review of #1465: `add --in` without --tz first reads the cockpit's zone; that read must
    // retry the startup 503 too, or a recovered agent's schedule is refused at once.
    it('add --in without --tz retries the startup 503 on its zone lookup', async () => {
      let starting = 1;
      const http: AutomationIo['http'] = async (url, init) => {
        if (starting > 0) { starting -= 1; return { status: 503, data: 'Cockpit is starting; retry shortly.\n' }; }
        return fetchJson(url, init);
      };
      expect(await run(['add', '--name', 'Later', '--in', '1h', '--prompt', 'Go'], env(), { http, now: () => Date.now(), sleep: async () => {} }), out.join('\n')).toBe(EXIT.ok);
      expect(posted).toHaveLength(1);
    });

    it('gives up on the startup 503 after a bounded wait', async () => {
      let calls = 0;
      const http: AutomationIo['http'] = async () => { calls += 1; return { status: 503, data: 'Cockpit is starting; retry shortly.\n' }; };
      expect(await run(['list'], env(), { http })).toBe(EXIT.refused);
      expect(calls).toBeGreaterThan(1);
      expect(calls).toBeLessThanOrEqual(61);
    });

    it('an unreachable origin exits 2', async () => {
      expect(await run(['list'], { CEZ_COCKPIT_URL: 'http://127.0.0.1:1', CEZ_PROJECT_ID: 'default' })).toBe(EXIT.refused);
      expect(last().code).toBe('unavailable');
    });

    it('automations off: the 409 is relayed verbatim with exit 2', async () => {
      vi.stubEnv('CEZ_AUTOMATIONS', '');
      expect(await run(['add', '--name', 'N', '--cron', '0 7 * * *', '--prompt', 'P'])).toBe(EXIT.refused);
      expect(last()).toEqual({ code: 'refused', status: 409, error: 'Automations are disabled — set CEZ_AUTOMATIONS=1 to enable them' });
    });
  });

  describe('create / update / lifecycle', () => {
    const definition = { name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps', worktree: true, autonomous: true } };

    it('create prints id, enabled: false and the cockpit page url; a stray enabled is lifted into enable', async () => {
      expect(await run(['create', '--json', JSON.stringify(definition)])).toBe(EXIT.ok);
      const created = last();
      expect(created).toMatchObject({ id: expect.any(String), enabled: false, kind: 'schedule', name: 'Nightly' });
      expect(created.url).toBe(`${cockpit.origin}/p/default/automations/${String(created.id)}`);
      expect(created.url).toBe(automationPageUrl(cockpit, String(created.id)));
      expect(await run(['create', '--json', JSON.stringify({ ...definition, enabled: true })])).toBe(EXIT.ok);
      expect(posted[1]?.body).toMatchObject({ enable: true });
      expect(posted[1]?.body).not.toHaveProperty('enabled');
      expect(last().enabled).toBe(true);
    });

    it('create reads --file and stdin', async () => {
      const files: Record<string, string> = { '/def.json': JSON.stringify(definition) };
      expect(await run(['create', '--file', '/def.json'], env(), { readFile: async (path) => files[path]! })).toBe(EXIT.ok);
      expect(await run(['create'], env(), { stdin: async () => JSON.stringify(definition) })).toBe(EXIT.ok);
      expect(posted.map((call) => call.body)).toEqual([definition, definition]);
    });

    it('update merges over the editable keys, restates enabled and echoes expectedRevision', async () => {
      expect(await run(['create', '--enable', '--json', JSON.stringify(definition)])).toBe(EXIT.ok);
      const id = String(last().id);
      expect(await run(['update', id, '--json', JSON.stringify({ task: { prompt: 'new prompt' } })])).toBe(EXIT.ok);
      expect(posted[1]).toMatchObject({ method: 'PUT' });
      // Review of #1018: a prompt-only update keeps every other task setting.
      expect(posted[1]?.body).toEqual({
        name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 },
        task: { prompt: 'new prompt', worktree: true, autonomous: true }, enabled: true, expectedRevision: 1,
      });
      expect(last()).toMatchObject({ id, enabled: true, revision: 2, url: automationPageUrl(cockpit, id) });
    });

    it('update merges task key by key, and null removes a task key', async () => {
      const withRunner = { ...definition, task: { ...definition.task, runner: 'codex', model: 'gpt-x' } };
      expect(await run(['create', '--json', JSON.stringify(withRunner)])).toBe(EXIT.ok);
      const id = String(last().id);
      expect(await run(['update', id, '--json', JSON.stringify({ task: { prompt: 'p2', model: null } })])).toBe(EXIT.ok);
      expect(posted[1]?.body).toMatchObject({ task: { prompt: 'p2', worktree: true, autonomous: true, runner: 'codex' } });
      expect((posted[1]?.body as { task: Record<string, unknown> }).task).not.toHaveProperty('model');
    });

    it('update against a stale revision exits 2 and overwrites nothing', async () => {
      expect(await run(['create', '--json', JSON.stringify(definition)])).toBe(EXIT.ok);
      const id = String(last().id);
      // The cockpit edits between the CLI's read and its write.
      const realFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      let cockpitEdited = false;
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        if (init?.method === 'PUT' && !cockpitEdited) {
          cockpitEdited = true;
          await realFetch(input, { ...init, body: JSON.stringify({ ...definition, name: 'Edited in the cockpit', expectedRevision: 1 }) });
        }
        return realFetch(input, init);
      });
      expect(await run(['update', id, '--json', JSON.stringify({ name: 'From the CLI' })])).toBe(EXIT.refused);
      expect(last()).toMatchObject({ code: 'refused', status: 409 });
      const stored = (await (await fetch(`${cockpit.api}/automations/${id}`)).json() as { automation: { name: string } }).automation;
      expect(stored.name).toBe('Edited in the cockpit');
    });

    it('run, list, show, enable, pause and delete', async () => {
      expect(await run(['create', '--json', JSON.stringify(definition)])).toBe(EXIT.ok);
      const id = String(last().id);
      const url = automationPageUrl(cockpit, id);
      expect(await run(['run', id])).toBe(EXIT.ok);
      expect(last()).toMatchObject({ id, runId: expect.any(String), url });
      expect(await run(['enable', id])).toBe(EXIT.ok);
      expect(last()).toMatchObject({ id, enabled: true, url });
      expect(await run(['list'])).toBe(EXIT.ok);
      expect(last().automations).toEqual([expect.objectContaining({ id, name: 'Nightly', enabled: true, kind: 'schedule', trigger: 'every day at 04:00', url })]);
      expect(await run(['pause', id])).toBe(EXIT.ok);
      expect(last()).toMatchObject({ id, enabled: false, url });
      expect(await run(['show', id])).toBe(EXIT.ok);
      expect(last()).toMatchObject({ automation: { id, enabled: false }, url });
      expect(await run(['delete', id])).toBe(EXIT.ok);
      expect(last()).toEqual({ id, deleted: true });
      expect(await run(['show', id])).toBe(EXIT.refused);
      expect(last()).toMatchObject({ status: 404 });
    });
  });

  describe('check', () => {
    /** The check needs a GitHub remote, which the test app lacks; its polling is pinned over a stubbed transport. */
    const checkIo = (statuses: Array<Record<string, unknown>>) => {
      const calls: string[] = [];
      let clock = 0;
      const http = async (url: string, init: { method?: string; body?: unknown } = {}): Promise<HttpResult> => {
        calls.push(`${init.method ?? 'GET'} ${url}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`);
        if (url.endsWith('/check')) return { status: 202, data: { checkId: 'chk-1' } };
        clock += 1_000;
        return { status: 200, data: statuses.shift() ?? { status: 'running' } };
      };
      return { calls, extra: { http, now: () => clock, timeoutMs: 10_000 } satisfies Partial<AutomationIo> };
    };

    it('polls the workspace-level check until complete and exits 0 with matches', async () => {
      const { calls, extra } = checkIo([{ status: 'running' }, { status: 'complete', matches: 2, truncated: false }]);
      expect(await run(['check', 'a1'], env(), extra)).toBe(EXIT.ok);
      expect(calls).toEqual([
        `POST ${cockpit.api}/automations/a1/check {"mode":"preview"}`,
        `GET ${cockpit.origin}/api/v1/automation-checks/chk-1`,
        `GET ${cockpit.origin}/api/v1/automation-checks/chk-1`,
      ]);
      expect(last()).toMatchObject({ id: 'a1', checkId: 'chk-1', mode: 'preview', matches: 2, url: automationPageUrl(cockpit, 'a1') });
    });

    it('--execute sends execute; a check that ends in error exits 1', async () => {
      const { calls, extra } = checkIo([{ status: 'error', error: 'No GitHub remote is configured' }]);
      expect(await run(['check', 'a1', '--execute'], env(), extra)).toBe(EXIT.failed);
      expect(calls[0]).toContain('{"mode":"execute"}');
      expect(last()).toMatchObject({ code: 'failed', error: 'No GitHub remote is configured' });
    });

    it('a check that outlives the deadline exits 3', async () => {
      const { extra } = checkIo([]);
      expect(await run(['check', 'a1'], env(), extra)).toBe(EXIT.timeout);
      expect(last()).toMatchObject({ code: 'timeout', checkId: 'chk-1' });
    });
  });

  // hearsay-tools/cezarion#1465: one-time schedules from flags, cancel and the archived list.
  describe('one-time schedules', () => {
    const NOW = Date.parse('2026-10-22T13:00:00Z');
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);

    it('add --at --tz builds a once body', async () => {
      expect(await run(['add', '--name', 'Check', '--at', later, '--tz', 'Europe/Warsaw', '--latest-start', '6h', '--prompt', 'Check it']), out.join('\n')).toBe(EXIT.ok);
      expect(posted.at(-1)?.body).toEqual({ name: 'Check', kind: 'schedule', schedule: { type: 'once', at: later, timeZone: 'Europe/Warsaw', latestStartMinutes: 360 }, task: { prompt: 'Check it', worktree: true, autonomous: true } });
      expect(last()).toMatchObject({ enabled: false, onceStatus: 'paused', timeZone: 'Europe/Warsaw', note: 'Cezarion must be running at the due time, or start again before the latest start, for this task to launch.' });
      expect(String(last().dueAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    });

    it('add --in 7d resolves at in the cockpit zone', async () => {
      const { timeZone } = (await fetchJson(`${cockpit.api}/automations`)).data as { timeZone: string };
      const at = resolveDelay('7d', Date.now(), timeZone);
      expect(await run(['add', '--name', 'Later', '--in', '7d', '--prompt', 'Go'], env(), { now: () => Date.now() }), out.join('\n')).toBe(EXIT.ok);
      const schedule = (posted.at(-1)?.body as { schedule: { at: string; timeZone: string } }).schedule;
      expect(schedule.timeZone).toBe(timeZone);
      // Within a minute of the resolution above: the CLI resolved it a moment later.
      expect(Math.abs(Date.parse(`${schedule.at}:00Z`) - Date.parse(`${at}:00Z`))).toBeLessThanOrEqual(60_000);
    });

    it('add --in resolves from io.now in the given zone', () => {
      expect(bodyFromAddFlags({ name: 'n', in: '7d', tz: 'Europe/Warsaw' }, 'p', { now: NOW })).toMatchObject({ schedule: { type: 'once', at: '2026-10-29T14:00', timeZone: 'Europe/Warsaw' } });
    });

    it('add --at with --cron exits 64', async () => {
      for (const argv of [
        ['--at', later, '--cron', '0 4 * * *'],
        ['--in', '1h', '--on', 'pull_request.opened'],
        ['--at', later, '--in', '1h'],
        ['--cron', '0 4 * * *', '--tz', 'UTC'],
        ['--cron', '0 4 * * *', '--latest-start', '1h'],
        ['--at', later, '--tz', 'Mars/Base'],
        ['--at', 'tomorrow'],
        ['--in', 'soon'],
      ]) {
        expect(await run(['add', '--name', 'n', '--prompt', 'p', ...argv], {}), argv.join(' ')).toBe(EXIT.usage);
      }
      expect(posted).toEqual([]);
    });

    it('--latest-start 5m exits 64 (below 10 minutes)', async () => {
      expect(await run(['add', '--name', 'n', '--prompt', 'p', '--in', '1h', '--tz', 'UTC', '--latest-start', '5m'], {})).toBe(EXIT.usage);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringMatching(/10 minutes/) });
      expect(await run(['add', '--name', 'n', '--prompt', 'p', '--in', '1h', '--tz', 'UTC', '--latest-start', '31d'], {})).toBe(EXIT.usage);
    });

    it('cancel posts to /cancel', async () => {
      expect(await run(['add', '--name', 'Cancel me', '--at', later, '--tz', 'UTC', '--prompt', 'p'])).toBe(EXIT.ok);
      const id = String(last().id);
      expect(await run(['cancel', id]), out.join('\n')).toBe(EXIT.ok);
      expect(posted.at(-1)).toMatchObject({ method: 'POST', url: expect.stringMatching(new RegExp(`/automations/${id}/cancel$`)) });
      expect(last()).toMatchObject({ id, onceStatus: 'archived', archived: { outcome: 'cancelled' } });
    });

    it('list --archived only passes the query', async () => {
      expect(await run(['add', '--name', 'Keep', '--at', later, '--tz', 'UTC', '--prompt', 'p'])).toBe(EXIT.ok);
      expect(await run(['add', '--name', 'Gone', '--at', later, '--tz', 'UTC', '--prompt', 'p'])).toBe(EXIT.ok);
      expect(await run(['cancel', String(last().id)])).toBe(EXIT.ok);
      const urls: string[] = [];
      const http = async (url: string, init?: Parameters<typeof fetchJson>[1]): Promise<HttpResult> => { urls.push(url); return fetchJson(url, init); };
      expect(await run(['list', '--archived', 'only'], env(), { http })).toBe(EXIT.ok);
      expect(urls.at(-1)).toMatch(/\/automations\?archived=only$/);
      expect((last().automations as Array<Record<string, unknown>>).map(item => item.name)).toEqual(['Gone']);
      expect(await run(['list'])).toBe(EXIT.ok);
      const [keep] = last().automations as Array<Record<string, unknown>>;
      expect(keep).toMatchObject({ name: 'Keep', onceStatus: 'paused', timeZone: 'UTC', dueAt: `${later}:00.000Z`, trigger: expect.stringMatching(/^once on /) });
      expect(await run(['list', '--archived', 'all'])).toBe(EXIT.usage);
    });

    it('show carries the due instant and zone of a once', async () => {
      expect(await run(['add', '--name', 'Show', '--at', later, '--tz', 'UTC', '--prompt', 'p'])).toBe(EXIT.ok);
      expect(await run(['show', String(last().id)])).toBe(EXIT.ok);
      expect(last()).toMatchObject({ onceStatus: 'paused', dueAt: `${later}:00.000Z`, timeZone: 'UTC' });
    });
  });

  it('schema prints the reference with no env at all', async () => {
    expect(await run(['schema'], {})).toBe(EXIT.ok);
    expect(out).toEqual([AUTOMATION_SCHEMA_REFERENCE]);
  });
});
