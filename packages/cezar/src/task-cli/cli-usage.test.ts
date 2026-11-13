import { productIdentity } from '../home/identity.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { resolve } from 'node:path';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it, vi } from 'vitest';
import { runTaskCommand, taskHelp } from './cli.ts';
import { discoverCockpit } from './discovery.ts';
import { registerProject } from '../workspace/projects.ts';
import { taskCliFixture } from './cli.testkit.ts';

describe('cez task', () => {
  const ctx = taskCliFixture();
  const { io, run, last, start } = ctx;

  describe('shared flag positions (hearsay-tools/cezarion#554)', () => {
    const cases = ['list', 'status', 'stop'].flatMap((operation) =>
      ['url', 'repo'].flatMap((flag) => ['before', 'after'].flatMap((position) =>
        ['space', 'equals'].map((form) => ({ operation, flag, position, form })),
      )),
    );
    it.each(cases)('$operation with --$flag $position ($form) resolves and requests the same cockpit', async ({ operation, flag, position, form }) => {
      const project = await registerProject(ctx.harness.repoRoot, undefined, testHome());
      const api = `${ctx.cockpit.origin}/api/v1/p/${project.id}`;
      const id = await start();
      const value = flag === 'url' ? ctx.cockpit.origin : ctx.harness.repoRoot;
      const globals = form === 'space' ? [`--${flag}`, value] : [`--${flag}=${value}`];
      const command = operation === 'list' ? [operation] : [operation, id];
      const argv = position === 'before' ? [...globals, ...command] : [...command, ...globals];
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await runTaskCommand(argv, flag === 'url' ? { CEZ_URL: 'http://127.0.0.1:1' } : {}, {
          ...io(),
          discover: async (options) => {
            expect(options).toEqual({
              url: flag === 'url' ? ctx.cockpit.origin : undefined,
              repoDir: flag === 'repo' ? ctx.harness.repoRoot : resolve(process.cwd()),
            });
            const found = await discoverCockpit({ ...options, ports: [Number(new URL(ctx.cockpit.origin).port)] });
            expect(found.api).toBe(api);
            return found;
          },
        })).toBe(0);
        const requests = fetchSpy.mock.calls
          .filter(([url]) => String(url).startsWith(api + '/'))
          .map(([url, init]) => ({ url: String(url), method: init?.method ?? 'GET' }));
        expect(requests).toEqual([{
          url: operation === 'list' ? `${api}/run-summaries?archived=recent`
            : `${api}/runs/${id}${operation === 'stop' ? '/cancel' : ''}`,
          method: operation === 'stop' ? 'POST' : 'GET',
        }]);
        if (operation === 'list') expect(last().runs).toMatchObject([{ id }]);
        else if (operation === 'status') expect(last()).toMatchObject({ id, status: RUN_STATUS.queued });
        else {
          expect(last()).toEqual({ id, cancelled: true });
          expect(ctx.store.getRun(id)?.status).toBe('cancelled');
        }
      } finally { fetchSpy.mockRestore(); }
    });

    it.each(['--x', '--wait', '--full', '--timeout-seconds=1'])('rejects %s before the operation without discovery', async (flag) => {
      expect(await run([flag, 'start', 'x'])).toBe(64);
      expect(last()).toMatchObject({
        code: 'invalid_input',
        error: `unknown option '${flag.split('=')[0]}' before the operation; only --url, --repo and --help go there`,
        usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) },
      });
      expect(ctx.discoveries).toBe(0);
    });

    it.each([
      ['--url', 'http://127.0.0.1:1', 'list', '--url=http://127.0.0.1:2'],
      ['--repo=one', 'list', '--repo', 'two'],
      ['--help', 'list', '--help'],
      ['-h', 'list', '--help'],
      ['--url=one', '--url', 'two', 'list'],
      ['--repo', 'one', '--repo=two', 'list'],
      ['--help', '-h', 'list'],
    ].map((argv) => ({ argv })))('rejects duplicate shared flags in $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('duplicate option'), usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) } });
      expect(ctx.discoveries).toBe(0);
    });

    it.each(['url', 'repo'].flatMap((flag) => [
      [`--${flag}`], [`--${flag}`, '--help', 'list'], [`--${flag}=--help`, 'list'],
      [`--${flag}`, '', 'list'], [`--${flag}=`, 'list'],
    ]).map((argv) => ({ argv })))('rejects missing or option-shaped leading values in $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('requires a value'), usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) } });
      expect(ctx.discoveries).toBe(0);
    });

    it.each([['--url', 'http://127.0.0.1:1'], ['--repo=checkout']].map((argv) => ({ argv })))('reports missing operation after $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: 'missing operation', usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) } });
      expect(ctx.discoveries).toBe(0);
    });

    it.each(['--help', '-h'].flatMap((help) => ['start', 'list', 'status', 'stop'].map((operation) => ({ help, operation }))))(
      '$help $operation prints operation help without discovery', async ({ help, operation }) => {
        expect(await run([help, operation])).toBe(0);
        expect(ctx.out.at(-1)).toBe(taskHelp(operation));
        expect(ctx.discoveries).toBe(0);
      },
    );

    it('keeps parsing after the operation strict even with leading help', async () => {
      expect(await run(['--help', 'list', '--x'])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(ctx.discoveries).toBe(0);
    });
  });

  describe('usage', () => {
    it('prints help text without discovering a cockpit', async () => {
      expect(await run(['--help'])).toBe(0);
      expect(ctx.out.join('\n')).toContain(("cez task start").replace("cez", productIdentity().command));
      expect(ctx.out.at(-1)).toContain(("cez task archive <id>").replace("cez", productIdentity().command));
      expect(ctx.out.at(-1)).toContain(("cez task unarchive <id>").replace("cez", productIdentity().command));
      expect(ctx.out.at(-1)).toContain(("cez task archive-finished").replace("cez", productIdentity().command));
      expect(await run(['start', '--help'])).toBe(0);
      expect(ctx.out.at(-1)).toContain('--request-id');
      expect(ctx.out.at(-1)).toMatch(/--archive-when-done[^\n]*default off/);
      expect(ctx.out.at(-1)).toMatch(/--auto-merge-pr[^\n]*default off/);
      expect(ctx.out.at(-1)).toMatch(/--workflow[^\n]*\n  --skill /);
      expect(ctx.discoveries).toBe(0);
    });

    it.each([[['--help']], [['start', '--help']]])('documents safe task input in %j (#568)', async (argv) => {
      expect(await run(argv)).toBe(0);
      const help = ctx.out.at(-1)!;
      expect(help).toContain(`${productIdentity().command} task start --task-file <path|-> | '<task>'`);
      expect(help).toContain(("cez task start --task-file task.md").replace("cez", productIdentity().command));
      expect(help).toContain(("cez task start --task-file - <<'EOF'").replace("cez", productIdentity().command));
      expect(help).toContain('POSIX shells expand backticks and $() in double-quoted arguments');
      expect(help).toContain('before the CLI receives the text');
      expect(help).toContain('Do not put raw backticks in double-quoted task arguments');
      expect(ctx.discoveries).toBe(0);
    });

    // #553/#609: the help is where a bot learns the clear contract, so it is pinned.
    it.each([[['--help']], [['wait', '--help']], [['start', '--help']], [['status', '--help']], [['list', '--help']], [['log', '--help']]])(
      'states the attention contract and the wait default in %j (#553, #609)', async (argv) => {
        expect(await run(argv)).toBe(0);
        const help = ctx.out.at(-1)!;
        expect(help).toContain('attention (default)');
        expect(help).toContain('--until settled');
        expect(help).toMatch(/`waiting` is attention even when no question is pending/);
        expect(help).toMatch(/`waiting` on its own open PR or timer wait [^`]*"waiting for merge"[^`]* is neither settled nor attention/);
        expect(help).toContain(("cez task wait <id>                   # default: stops when the task needs you").replace("cez", productIdentity().command));
        expect(help).toContain(("cez task wait <id> --until settled   # terminal status only").replace("cez", productIdentity().command));
        expect(help).toContain(("cez task start '…' --wait --autonomous --until settled").replace("cez", productIdentity().command));
        expect(ctx.discoveries).toBe(0);
      });

    // #931: `log --follow` stops for attention too, so its help carries the same contract.
    it.each([[['--help']], [['log', '--help']]])('documents the log --follow default in %j (#931)', async (argv) => {
      expect(await run(argv)).toBe(0);
      const help = ctx.out.at(-1)!;
      expect(help).toContain(("cez task log <id> --follow             # default: stops when the task needs you").replace("cez", productIdentity().command));
      expect(help).toMatch(/--until <attention\|settled>/);
      expect(ctx.discoveries).toBe(0);
    });

    it('describes the webhook flags and the notify operation (#589)', async () => {
      expect(await run(['--help'])).toBe(0);
      const all = ctx.out.at(-1)!;
      expect(all).toContain(("cez task notify <id>").replace("cez", productIdentity().command));
      expect(all).toContain('--notify');
      expect(all).toContain('--no-notify');
      expect(all).toContain('--off');
      expect(await run(['start', '--help'])).toBe(0);
      expect(ctx.out.at(-1)).toMatch(/--notify .*webhook/);
      expect(ctx.out.at(-1)).toMatch(/--no-notify .*webhook/);
      expect(ctx.out.at(-1)).toContain('notify:');
    });

    it.each([[['frobnicate']], [['start', '--bogus', 'x']], [['status']], [[]]])(
      'answers %j with the JSON usage error and exit 64',
      async (argv) => {
        expect(await run(argv)).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input' });
        expect(last().usage).toBeDefined();
        expect(ctx.discoveries).toBe(0);
      },
    );

    it.each([[['list', '--limit', '0']], [['list', '--status', 'nope']], [['wait', 'x', '--mode', 'some']], [['log', 'x', '--since', '-1']], [['log', 'x', '--max-chars', '0']], [['start', 'x', '--wait', '--timeout-seconds', '0']], [['start', 'x', '--until', 'settled']], [['start', 'x', '--wait', '--until', 'later']], [['log', 'x', '--until', 'settled']], [['log', 'x', '--follow', '--until', 'later']]])(
      'judges %j as a usage error before looking for a cockpit', async (argv) => {
        expect(await run(argv)).toBe(64);
        expect(ctx.discoveries).toBe(0);
      },
    );

    it('never prints delegation credentials', async () => {
      const env = { CEZ_DELEGATION_TOKEN: 'secret-token-value', CEZ_DELEGATION_URL: 'http://127.0.0.1:9/api/v1/delegation' };
      await runTaskCommand(['start', 'x'], env, io());
      await runTaskCommand(['status', 'bogus'], env, io());
      expect(ctx.out.join('\n')).not.toContain('secret-token-value');
    });
  });
});
