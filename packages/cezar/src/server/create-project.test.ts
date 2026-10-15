import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckoutProgressEvent } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  dryRunCommandRunner,
  listGithubOwners,
  spawnCommandRunner,
  type CommandResult,
  type CommandRunner,
} from './create-project.ts';

/**
 * New project (spec 2026-10-15-create-new-project, port of open-mercato/cezar#1402). Real temp
 * dirs; the `git`/`gh` commands are faked unless a case needs a real repository, and every argv
 * is recorded so "always private" and "nothing before the pre-checks" are asserted on what would
 * actually run.
 */

type Call = { cmd: 'git' | 'gh'; args: string[]; cwd: string; signal: AbortSignal | undefined };

/** A runner that answers like a signed-in `gh` with a free name and a valid template. */
function recordingRunner(overrides: (call: Call) => CommandResult | undefined = () => undefined) {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    const call = { cmd, args, cwd: opts.cwd, signal: opts.signal };
    calls.push(call);
    const override = overrides(call);
    if (override) return override;
    if (cmd === 'git' && args[0] === 'init') await mkdir(join(opts.cwd, '.git'), { recursive: true });
    if (cmd === 'gh' && args[1] === 'clone') await mkdir(join(args[3] ?? opts.cwd, '.git'), { recursive: true });
    if (cmd === 'gh' && args[0] === 'api') {
      const path = args[1] ?? '';
      if (path === 'user') return { ok: true, stdout: 'octo\n' };
      if (path.endsWith('/commits?per_page=1')) return { ok: true, stdout: '1\n' };
      if (args.includes('[.is_template, .archived] | @json')) return { ok: true, stdout: '[true,false]\n' };
      return { ok: false, error: 'gh: Not Found (HTTP 404)' };
    }
    return { ok: true, stdout: '' };
  };
  const argv = () => calls.map((c) => [c.cmd, ...c.args]);
  return { run, calls, argv };
}

const fail = (error: string): CommandResult => ({ ok: false, error });
const isCall = (call: Call, cmd: 'git' | 'gh', ...prefix: string[]) =>
  call.cmd === cmd && prefix.every((part, i) => call.args[i] === part);

/** Real git, with an identity and no signing lent for the commit — the host's config must not
 *  decide whether these tests pass. */
const realGit: CommandRunner = (cmd, args, opts) =>
  spawnCommandRunner(
    cmd,
    cmd === 'git' && args[0] === 'commit'
      ? ['-c', 'user.name=cezar test', '-c', 'user.email=test@cezar.invalid', '-c', 'commit.gpgsign=false', ...args]
      : args,
    opts,
  );

describe('createProject', () => {
  let base: string;
  let root: string;
  let events: CheckoutProgressEvent[];
  const onProgress = (e: CheckoutProgressEvent) => events.push(e);
  beforeEach(() => {
    base = mkdtempSync(join(realpathSync(tmpdir()), 'cez-create-'));
    root = join(base, 'projects');
    events = [];
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('local: creates a missing checkout root and a main branch with one empty commit', async () => {
    const result = await createProject({ name: 'fresh', projectsDir: root, onProgress, run: realGit });
    const target = join(root, 'fresh');
    expect(result).toEqual({ ok: true, target, name: 'fresh', kind: 'local' });
    expect(execFileSync('git', ['-C', target, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()).toBe('1');
    expect(readdirSync(target)).toEqual(['.git']);
    expect(events.at(-1)).toEqual({ name: 'fresh', phase: 'done' });
  });

  it('local: runs no gh at all', async () => {
    const { run, argv } = recordingRunner();
    await createProject({ name: 'fresh', projectsDir: root, onProgress, run });
    expect(argv()).toEqual([
      ['git', 'init', '-b', 'main'],
      ['git', 'commit', '--allow-empty', '-m', 'Initial commit'],
    ]);
  });

  it('local: no git identity → 400 with the identity hint, folder removed', async () => {
    const { run } = recordingRunner((c) =>
      isCall(c, 'git', 'commit') ? fail('Author identity unknown\n*** Please tell me who you are.') : undefined,
    );
    const result = await createProject({ name: 'fresh', projectsDir: root, onProgress, run });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(!result.ok && result.error).toContain('git config --global user.name');
    expect(!result.ok && result.error).toContain('Author identity unknown');
    expect(existsSync(join(root, 'fresh'))).toBe(false);
  });

  it('an existing folder → 409 and its contents untouched', async () => {
    mkdirSync(join(root, 'taken'), { recursive: true });
    writeFileSync(join(root, 'taken', 'keep.txt'), 'mine');
    const { run, calls } = recordingRunner();
    const result = await createProject({ name: 'taken', projectsDir: root, onProgress, run });
    expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('folder already exists') });
    expect(readdirSync(join(root, 'taken'))).toEqual(['keep.txt']);
    expect(calls).toEqual([]);
  });

  it('refuses bad names, owners and templates before touching the disk or running anything', async () => {
    const { run, calls } = recordingRunner();
    for (const opts of [
      { name: 'my project' },
      { name: '..' },
      { name: 'a/b' },
      { name: 'ok', github: { owner: '-x' } },
      { name: 'ok', github: { owner: 'acme', template: 'not a repo' } },
    ]) {
      expect(await createProject({ ...opts, projectsDir: root, onProgress, run })).toMatchObject({ ok: false, status: 400 });
    }
    expect(calls).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('gh missing → 503 with a reason, before any folder exists', async () => {
    const { run } = recordingRunner((c) => (c.cmd === 'gh' ? { ok: false, error: 'spawn gh ENOENT', notFound: true } : undefined));
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run });
    expect(result).toMatchObject({ ok: false, status: 503, reason: expect.stringContaining('gh CLI not found') });
    expect(existsSync(join(root, 'fresh'))).toBe(false);
  });

  it('gh unauthenticated → 503 pointing at gh auth login, before any folder exists', async () => {
    const { run } = recordingRunner((c) => (isCall(c, 'gh', 'api', 'user') ? fail('HTTP 401: Bad credentials') : undefined));
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run });
    expect(result).toMatchObject({ ok: false, status: 503, reason: expect.stringContaining('gh auth login') });
    expect(existsSync(join(root, 'fresh'))).toBe(false);
  });

  it('a name already taken on GitHub → 409 before any folder exists', async () => {
    const { run, calls } = recordingRunner((c) =>
      isCall(c, 'gh', 'api', 'repos/acme/fresh') ? { ok: true, stdout: 'acme/fresh\n' } : undefined,
    );
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run });
    expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('acme/fresh already exists on GitHub') });
    expect(existsSync(join(root, 'fresh'))).toBe(false);
    expect(calls.some((c) => isCall(c, 'gh', 'repo', 'create'))).toBe(false);
  });

  it('an unexpected name-check failure is reported, not assumed free', async () => {
    const { run, calls } = recordingRunner((c) => (isCall(c, 'gh', 'api', 'repos/acme/fresh') ? fail('HTTP 502: Bad Gateway') : undefined));
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run });
    expect(result).toMatchObject({ ok: false, status: 500, error: expect.stringContaining('HTTP 502') });
    expect(calls.some((c) => isCall(c, 'gh', 'repo', 'create'))).toBe(false);
  });

  it('a template that is not a template, or is archived → 400 before any folder exists', async () => {
    for (const [stdout, message] of [
      ['[false,false]', 'is not a GitHub template repository'],
      ['[true,true]', 'is archived'],
    ] as const) {
      const { run } = recordingRunner((c) => (isCall(c, 'gh', 'api', 'repos/tmpl/x') ? { ok: true, stdout } : undefined));
      const result = await createProject({
        name: 'fresh',
        github: { owner: 'acme', template: 'https://github.com/tmpl/x' },
        projectsDir: root,
        onProgress,
        run,
      });
      expect(result).toMatchObject({ ok: false, status: 400, error: `tmpl/x ${message}` });
      expect(existsSync(join(root, 'fresh'))).toBe(false);
    }
  });

  it('GitHub empty: a PRIVATE repo, an HTTPS origin with the gh credential helper, then a push (#968)', async () => {
    const { run, argv } = recordingRunner();
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run });
    expect(result).toEqual({ ok: true, target: join(root, 'fresh'), name: 'fresh', slug: 'acme/fresh', kind: 'github' });
    expect(argv()).toEqual([
      ['gh', 'api', 'user', '--jq', '.login'],
      ['gh', 'api', 'repos/acme/fresh', '--jq', '.full_name'],
      ['git', 'init', '-b', 'main'],
      ['git', 'commit', '--allow-empty', '-m', 'Initial commit'],
      ['gh', 'repo', 'create', 'acme/fresh', '--private'],
      ['git', 'remote', 'add', 'origin', 'https://github.com/acme/fresh.git'],
      ['git', 'config', '--local', '--replace-all', 'credential.https://github.com.helper', ''],
      ['git', 'config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'],
      ['git', 'push', '-u', 'origin', 'main'],
    ]);
  });

  it('never passes a visibility other than --private, on either GitHub path', async () => {
    for (const github of [{ owner: 'acme' }, { owner: 'acme', template: 'tmpl/x' }]) {
      const { run, calls } = recordingRunner();
      await createProject({ name: github.template ? 'from-template' : 'empty', github, projectsDir: root, onProgress, run, sleep: async () => {} });
      const creates = calls.filter((c) => isCall(c, 'gh', 'repo', 'create'));
      expect(creates).toHaveLength(1);
      expect(creates[0]?.args).toContain('--private');
      expect(creates[0]?.args.some((a) => /^--(public|internal|visibility)/.test(a))).toBe(false);
    }
  });

  it('a failed gh repo create cleans up the local folder, names no remote and registers nothing', async () => {
    const { run } = recordingRunner((c) => (isCall(c, 'gh', 'repo', 'create') ? fail('GraphQL: Name already exists on this account') : undefined));
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run });
    expect(result).toMatchObject({ ok: false, status: 500, error: 'GraphQL: Name already exists on this account' });
    expect(existsSync(join(root, 'fresh'))).toBe(false);
    expect(events.at(-1)?.phase).toBe('error');
  });

  for (const [step, failing, finish] of [
    ['adding the origin remote', ['git', 'remote'], "git remote add origin https://github.com/acme/fresh.git && git config --local credential.https://github.com.helper '!gh auth git-credential' && git push -u origin main"],
    ['configuring GitHub credentials', ['git', 'config'], "git config --local credential.https://github.com.helper '!gh auth git-credential' && git push -u origin main"],
    ['pushing main', ['git', 'push'], 'git push -u origin main'],
  ] as const) {
    it(`${step} fails after the remote exists → kept, registered-ready, with a warning`, async () => {
      const { run } = recordingRunner((c) => (isCall(c, failing[0], failing[1]) ? fail('fatal: something broke\nmore detail') : undefined));
      const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run });
      const target = join(root, 'fresh');
      expect(result).toEqual({
        ok: true,
        target,
        name: 'fresh',
        slug: 'acme/fresh',
        kind: 'github',
        warning: `The private repository https://github.com/acme/fresh was created, but ${step} failed: fatal: something broke. Finish in ${target} with: ${finish}`,
      });
      expect(existsSync(join(target, '.git'))).toBe(true);
      expect(events.at(-1)).toMatchObject({ phase: 'done', warning: result.ok ? result.warning : '' });
    });
  }

  it('template: a private repo from the template, waits for its first commit, clones the HTTPS URL, sets the helper', async () => {
    let probes = 0;
    const { run, argv } = recordingRunner((c) =>
      isCall(c, 'gh', 'api', 'repos/acme/fresh/commits?per_page=1') ? { ok: true, stdout: probes++ === 0 ? '0\n' : '1\n' } : undefined,
    );
    const slept: number[] = [];
    const target = join(root, 'fresh');
    const result = await createProject({
      name: 'fresh',
      github: { owner: 'acme', template: 'tmpl/x' },
      projectsDir: root,
      onProgress,
      run,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(result).toEqual({ ok: true, target, name: 'fresh', slug: 'acme/fresh', kind: 'template' });
    expect(slept).toEqual([2000]);
    expect(argv()).toEqual([
      ['gh', 'api', 'user', '--jq', '.login'],
      ['gh', 'api', 'repos/acme/fresh', '--jq', '.full_name'],
      ['gh', 'api', 'repos/tmpl/x', '--jq', '[.is_template, .archived] | @json'],
      ['gh', 'repo', 'create', 'acme/fresh', '--private', '--template', 'tmpl/x'],
      ['gh', 'api', 'repos/acme/fresh/commits?per_page=1', '--jq', 'length'],
      ['gh', 'api', 'repos/acme/fresh/commits?per_page=1', '--jq', 'length'],
      ['gh', 'repo', 'clone', 'https://github.com/acme/fresh.git', target, '--', '--progress'],
      ['git', 'config', '--local', '--replace-all', 'credential.https://github.com.helper', ''],
      ['git', 'config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'],
    ]);
  });

  it('template: a failed clone cleans up locally and names the created repository and Clone from GitHub', async () => {
    const { run } = recordingRunner((c) => (isCall(c, 'gh', 'repo', 'clone') ? fail('fatal: could not read from remote') : undefined));
    const result = await createProject({
      name: 'fresh',
      github: { owner: 'acme', template: 'tmpl/x' },
      projectsDir: root,
      onProgress,
      run,
      sleep: async () => {},
    });
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      error:
        'fatal: could not read from remote\nThe private repository https://github.com/acme/fresh was created on GitHub — add it with Add project → Clone from GitHub (acme/fresh).',
    });
    expect(existsSync(join(root, 'fresh'))).toBe(false);
  });

  it('template: a failed credential helper after the clone keeps the project with a warning', async () => {
    const { run } = recordingRunner((c) => (isCall(c, 'git', 'config') ? fail('error: could not lock config file') : undefined));
    const result = await createProject({
      name: 'fresh',
      github: { owner: 'acme', template: 'tmpl/x' },
      projectsDir: root,
      onProgress,
      run,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: true, kind: 'template', warning: expect.stringContaining('configuring GitHub credentials failed') });
    expect(existsSync(join(root, 'fresh', '.git'))).toBe(true);
  });

  it('an abort before gh repo create cleans up the local folder', async () => {
    const controller = new AbortController();
    const { run } = recordingRunner((c) => {
      if (!isCall(c, 'git', 'commit')) return undefined;
      controller.abort();
      return fail('project creation cancelled');
    });
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, 'fresh'))).toBe(false);
  });

  it('an abort after gh repo create starts does not stop the run: the signal never reaches it or later steps', async () => {
    const controller = new AbortController();
    const { run, calls } = recordingRunner((c) => {
      if (isCall(c, 'gh', 'repo', 'create')) controller.abort();
      return undefined;
    });
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run, signal: controller.signal });
    expect(result).toMatchObject({ ok: true, kind: 'github' });
    const createAt = calls.findIndex((c) => isCall(c, 'gh', 'repo', 'create'));
    expect(calls.slice(0, createAt).every((c) => c.signal === controller.signal)).toBe(true);
    expect(calls.slice(createAt).every((c) => c.signal === undefined)).toBe(true);
    expect(calls.at(-1)?.args).toEqual(['push', '-u', 'origin', 'main']);
  });

  it('dry run: real git, fake gh — a GitHub project is a real repo with an HTTPS origin and the helper', async () => {
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress, run: dryRunCommandRunner });
    const target = join(root, 'fresh');
    expect(result).toMatchObject({ ok: true, kind: 'github' });
    expect(execFileSync('git', ['-C', target, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()).toBe('1');
    expect(execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe('https://github.com/acme/fresh.git');
  });

  it('dry run: a template project is a real repo with a file in it', async () => {
    const result = await createProject({
      name: 'fresh',
      github: { owner: 'acme', template: 'tmpl/x' },
      projectsDir: root,
      onProgress,
      run: dryRunCommandRunner,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: true, kind: 'template' });
    expect(readdirSync(join(root, 'fresh')).sort()).toEqual(['.git', 'README.md']);
  });
});

describe('listGithubOwners', () => {
  it('lists the user first, then orgs sorted and deduped, with avatars and descriptions', async () => {
    const run: CommandRunner = async (_cmd, args) =>
      args[1] === 'user'
        ? { ok: true, stdout: 'octo\thttps://avatars.githubusercontent.com/u/1\n' }
        : {
            ok: true,
            stdout:
              'zeta\thttps://avatars.githubusercontent.com/u/3\t\n' +
              'acme\thttps://avatars.githubusercontent.com/u/2\tBuilds\\nrockets\n' +
              'acme\thttps://avatars.githubusercontent.com/u/2\tBuilds\\nrockets\n' +
              'octo\thttps://avatars.githubusercontent.com/u/1\t\n',
          };
    expect(await listGithubOwners(run)).toEqual({
      available: true,
      owners: [
        { login: 'octo', personal: true, avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
        { login: 'acme', personal: false, avatarUrl: 'https://avatars.githubusercontent.com/u/2', description: 'Builds rockets' },
        { login: 'zeta', personal: false, avatarUrl: 'https://avatars.githubusercontent.com/u/3' },
      ],
    });
  });

  it('drops a non-https avatar and keeps the personal account when the org listing fails', async () => {
    const run: CommandRunner = async (_cmd, args) =>
      args[1] === 'user' ? { ok: true, stdout: 'octo\tjavascript:alert(1)\n' } : { ok: false, error: 'missing read:org' };
    expect(await listGithubOwners(run)).toEqual({ available: true, owners: [{ login: 'octo', personal: true }] });
  });

  it('degrades when gh is missing or unauthenticated', async () => {
    expect(await listGithubOwners(async () => ({ ok: false, error: 'ENOENT', notFound: true }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('gh CLI not found'),
    });
    expect(await listGithubOwners(async () => ({ ok: false, error: 'HTTP 401' }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('gh auth login'),
    });
  });
});
