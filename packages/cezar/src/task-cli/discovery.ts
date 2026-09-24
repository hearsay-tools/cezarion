import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { healthResponseSchema, projectsResponseSchema } from '@open-mercato/cezar-contract';
import { fetchJson, TaskCliError, type Cockpit } from './http.ts';

/**
 * Which cockpit serves this checkout (#504, spec 2026-09-24-cez-task-cli). Zero config: probe the
 * range `pickPort` can land on and match the registry's project roots against this repo. Never
 * starts a server and never writes anything — a missing cockpit is an answer, not a fallback.
 */

/** The ports `cez` can bind: 4321 plus the 49 `pickPort` tries after it. */
export const COCKPIT_PORTS: readonly number[] = Array.from({ length: 50 }, (_, index) => 4321 + index);
const PROBE_TIMEOUT_MS = 1_500;

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5_000 }, (error, stdout) => done(error ? undefined : stdout.trim()));
  });
}

async function realpathOr(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}

/**
 * The main checkout that owns `dir`. A task worktree's common git dir is the parent repo's
 * `.git`, so this is what maps `.ai/cezar/worktrees/<id>` back to the project that ran it.
 * Submodules instead keep their git dir under `.git/modules/` and record `core.worktree`.
 */
export async function checkoutRoot(dir: string): Promise<string> {
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common && basename(common) === '.git') return realpathOr(dirname(common));
  if (common) {
    // Read the main worktree's config, not a linked worktree override. Git resolves a relative
    // core.worktree against this shared git dir, even when the caller is in a task worktree.
    const main = await git(dir, ['--git-dir', common, 'config', '--path', '--get', 'core.worktree']);
    if (main) return realpathOr(resolve(common, main));
  }
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  return realpathOr(top ?? dir);
}

interface Candidate { origin: string; projects: Array<{ id: string; root: string }>; bootProject: string }

/** Health first (cheap, and it proves this is a cezar), then the registry with its roots. */
async function probe(origin: string, timeoutMs: number): Promise<Candidate | undefined> {
  try {
    const health = await fetchJson(`${origin}/api/v1/health`, { timeoutMs });
    if (health.status !== 200 || !healthResponseSchema.safeParse(health.data).success) return undefined;
    const registry = await fetchJson(`${origin}/api/v1/projects`, { timeoutMs });
    const parsed = projectsResponseSchema.safeParse(registry.data);
    if (registry.status !== 200 || !parsed.success) return undefined;
    const projects = await Promise.all(parsed.data.projects.map(async (entry) => ({ id: entry.id, root: await realpathOr(entry.root) })));
    return { origin, projects, bootProject: parsed.data.bootProject };
  } catch {
    return undefined;
  }
}

function cockpitFor(origin: string, projectId: string): Cockpit {
  return { origin, projectId, api: `${origin}/api/v1/p/${encodeURIComponent(projectId)}` };
}

export interface DiscoverOptions {
  /** `--url` / `CEZ_URL`: skip the probe. */
  url?: string;
  repoDir: string;
  ports?: readonly number[];
  timeoutMs?: number;
}

export async function discoverCockpit(options: DiscoverOptions): Promise<Cockpit> {
  const root = await checkoutRoot(options.repoDir);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const hint = `start the cockpit in ${root} with: cez`;
  if (options.url) {
    let origin: string;
    try { origin = new URL(options.url).origin; } catch {
      throw new TaskCliError(64, { code: 'invalid_input', error: `invalid cockpit url: ${options.url}` });
    }
    const found = await probe(origin, Math.max(timeoutMs, 5_000));
    if (!found) throw new TaskCliError(2, { code: 'no-cockpit', error: `no cezar cockpit answered at ${origin}`, hint });
    // A remote cockpit's roots are its own paths, so no match is the ordinary case there.
    const match = found.projects.find((entry) => entry.root === root);
    return cockpitFor(origin, match?.id ?? found.bootProject);
  }
  const ports = options.ports ?? COCKPIT_PORTS;
  const candidates = await Promise.all(ports.map((port) => probe(`http://127.0.0.1:${port}`, timeoutMs)));
  // `ports` is ascending, so the first match is the lowest port serving this checkout.
  for (const candidate of candidates) {
    const match = candidate?.projects.find((entry) => entry.root === root);
    if (candidate && match) return cockpitFor(candidate.origin, match.id);
  }
  throw new TaskCliError(2, { code: 'no-cockpit', error: `no running cockpit serves ${root}`, hint });
}
