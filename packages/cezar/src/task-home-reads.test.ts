import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runSubcommand } from './subcommands.ts';
import { artifactDirectory } from './artifacts/store.ts';

const reads = vi.hoisted(() => ({ home: '', paths: [] as string[],
  observe(path: unknown) {
    const value = String(path);
    if (this.home && (value === this.home || value.startsWith(`${this.home}${sep}`))) this.paths.push(value);
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key,
    typeof value === 'function' && /^(read|open|access|stat|lstat|realpath)/.test(key)
      ? new Proxy(value, { apply(target, receiver, args) { reads.observe(args[0]); return Reflect.apply(target, receiver, args); } }) : value]));
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key,
    typeof value === 'function' && /^(read|open|access|stat|lstat|realpath|exists|createReadStream)/.test(key)
      ? new Proxy(value, { apply(target, receiver, args) { reads.observe(args[0]); return Reflect.apply(target, receiver, args); } }) : value]));
});
afterEach(() => { reads.home = ''; reads.paths = []; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ['artifact', 'publish', 'present'], ['artifact', 'publish', 'absent'], ['message', 'inbox'], ['worker', 'list'], ['task', 'list'],
  ['automation', 'list'], ['webhook', 'list'], ['discover', 'runners'],
])('%s uses task context without reading the cockpit home', async (command, action, projectContext?: string) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-task-home-'));
  try {
    const source = join(root, 'report.md');
    await writeFile(source, 'report');
    reads.home = join(root, 'home');
    reads.paths = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (command === 'task' && url.endsWith('/api/v1/health')) return Response.json({
        version: 'test', repoRoot: root, repo: null, checks: [], defaultRunner: 'claude', forge: null,
        capabilities: {}, projects: [], bootProject: 'project',
      });
      if (command === 'task' && url.endsWith('/api/v1/projects')) return Response.json({
        projects: [{ id: 'project', name: 'project', root, addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' }],
        bootProject: 'project', projectsDir: root,
      });
      return Response.json({ code: 'forbidden', error: 'test refusal' }, { status: 403 });
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runId = randomUUID();
    const env = { CEZ_HOME: reads.home, CEZ_PROJECT_ID: projectContext === 'absent' ? undefined : 'project', CEZ_TASK_ID: runId,
      CEZ_URL: 'http://127.0.0.1:4321', CEZ_ARTIFACTS_DIR: artifactDirectory(root, runId), CEZ_COCKPIT_URL: 'http://127.0.0.1:4321',
      CEZ_DELEGATION_URL: 'http://127.0.0.1:4321/api/v1/delegation', CEZ_DELEGATION_TOKEN: 'a'.repeat(43) };
    const result = await runSubcommand([command!, action!, ...(command === 'artifact' ? [source] : [])], env);
    expect(result).toBe(command === 'artifact' ? 0 : ['message', 'worker'].includes(command!) ? 1 : 2);
    if (command !== 'artifact') expect(fetch).toHaveBeenCalled();
    if (command === 'task') expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/run-summaries?archived=recent'))).toBe(true);
    expect(reads.paths).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('records a home-file read as a positive control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-home-observer-'));
  try {
    const path = join(root, 'config.json');
    await writeFile(path, '{}');
    reads.home = root;
    await readFile(path, 'utf8');
    expect(reads.paths).toContain(path);
  } finally { reads.home = ''; await rm(root, { recursive: true, force: true }); }
});
