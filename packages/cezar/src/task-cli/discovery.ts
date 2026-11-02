import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { capabilitiesSchema, healthResponseSchema } from '@open-mercato/cezar-contract/health';

/** Health from any cockpit version: a running cockpit can predate capabilities added since its build,
 *  and discovery reads none of them. Same tolerance as the cockpit's `healthPayloadSchema`. */
const cockpitHealthSchema = healthResponseSchema.extend({ capabilities: capabilitiesSchema.partial() });
import { projectsResponseSchema } from '@open-mercato/cezar-contract/projects';
import { fetchJson, TaskCliError, type Cockpit } from './http.ts';

/**
 * Which cockpit serves this checkout (#504, spec 2026-09-24-cez-task-cli). Zero config: probe the
 * historical auto-port range (also covering deliberately selected ports) and match the
 * registry's project roots against this repo. Never starts a server and never writes anything
 * — a missing cockpit is an answer, not a fallback.
 */

/** Retain discovery of older auto-port cockpits and explicitly selected nearby ports. */
export const COCKPIT_PORTS: readonly number[] = Array.from({ length: 50 }, (_, index) => 4321 + index);
const PROBE_TIMEOUT_MS = 1_500;

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5_000, ...(signal ? { signal } : {}) }, (error, stdout) => done(error ? undefined : stdout.trim()));
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
export async function checkoutRoot(dir: string, signal?: AbortSignal): Promise<string> {
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal);
  if (common && basename(common) === '.git') return realpathOr(dirname(common));
  if (common) {
    // Read the main worktree's config, not a linked worktree override. Git resolves a relative
    // core.worktree against this shared git dir, even when the caller is in a task worktree.
    const main = await git(dir, ['--git-dir', common, 'config', '--path', '--get', 'core.worktree'], signal);
    if (main) return realpathOr(resolve(common, main));
  }
  const top = await git(dir, ['rev-parse', '--show-toplevel'], signal);
  return realpathOr(top ?? dir);
}

interface Candidate { origin: string; projects: Array<{ id: string; root: string; hasWebhook: boolean }>; bootProject: string }

/** Health first (cheap, and it proves this is a cezar), then the registry with its roots. */
async function probe(origin: string, timeoutMs: number, signal?: AbortSignal): Promise<Candidate | undefined> {
  try {
    const health = await fetchJson(`${origin}/api/v1/health`, { timeoutMs, ...(signal ? { signal } : {}) });
    if (health.status !== 200 || !cockpitHealthSchema.safeParse(health.data).success) return undefined;
    const registry = await fetchJson(`${origin}/api/v1/projects`, { timeoutMs, ...(signal ? { signal } : {}) });
    const parsed = projectsResponseSchema.safeParse(registry.data);
    if (registry.status !== 200 || !parsed.success) return undefined;
    const projects = await Promise.all(parsed.data.projects.map(async (entry) => ({ id: entry.id, root: await realpathOr(entry.root), hasWebhook: entry.webhook !== undefined })));
    return { origin, projects, bootProject: parsed.data.bootProject };
  } catch {
    return undefined;
  }
}

function cockpitFor(origin: string, projectId: string, hasWebhook: boolean): Cockpit {
  return { origin, projectId, api: `${origin}/api/v1/p/${encodeURIComponent(projectId)}`, hasWebhook };
}

export interface DiscoverOptions {
  /** `--url` / `CEZ_URL`: skip the probe. */
  url?: string | undefined;
  repoDir: string;
  ports?: readonly number[];
  timeoutMs?: number;
  /** Abandons discovery: in-flight probes and git children end, and the call rejects. */
  signal?: AbortSignal;
}

export async function discoverCockpit(options: DiscoverOptions): Promise<Cockpit> {
  const root = await checkoutRoot(options.repoDir, options.signal);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const hint = `start the cockpit in ${root} with: cez`;
  if (options.url) {
    let origin: string;
    try { origin = new URL(options.url).origin; } catch {
      throw new TaskCliError(64, { code: 'invalid_input', error: `invalid cockpit url: ${options.url}` });
    }
    const found = await probe(origin, Math.max(timeoutMs, 5_000), options.signal);
    if (!found) throw new TaskCliError(2, { code: 'no-cockpit', error: `no cezar cockpit answered at ${origin}`, hint });
    // A remote cockpit's roots are its own paths, so no match is the ordinary case there.
    const match = found.projects.find((entry) => entry.root === root);
    const id = match?.id ?? found.bootProject;
    return cockpitFor(origin, id, found.projects.some((entry) => entry.id === id && entry.hasWebhook));
  }
  const ports = options.ports ?? COCKPIT_PORTS;
  const candidates = await Promise.all(ports.map((port) => probe(`http://127.0.0.1:${port}`, timeoutMs, options.signal)));
  // `ports` is ascending, so the first match is the lowest port serving this checkout.
  for (const candidate of candidates) {
    const match = candidate?.projects.find((entry) => entry.root === root);
    if (candidate && match) return cockpitFor(candidate.origin, match.id, match.hasWebhook);
  }
  throw new TaskCliError(2, { code: 'no-cockpit', error: `no running cockpit serves ${root}`, hint });
}

/** The env address first; discovery only when the caller named a cockpit or a checkout. */
export async function resolveCockpit(
  env: NodeJS.ProcessEnv,
  values: { url?: string; repo?: string },
  discover: ((options: DiscoverOptions) => Promise<Cockpit>) | undefined,
  noCockpit: string,
  options: { removeDiscoveryHint?: boolean } = {},
): Promise<Cockpit> {
  const address = env.CEZ_COCKPIT_URL?.trim();
  const projectId = env.CEZ_PROJECT_ID?.trim();
  if (address && projectId) {
    let origin: string;
    try { origin = new URL(address).origin; } catch {
      throw new TaskCliError(2, { code: 'no-cockpit', error: `CEZ_COCKPIT_URL is not a URL: ${address}` });
    }
    return { origin, projectId, api: `${origin}/api/v1/p/${encodeURIComponent(projectId)}` };
  }
  const url = values.url ?? (env.CEZ_URL?.trim() || undefined);
  if (url === undefined && values.repo === undefined) throw new TaskCliError(2, { code: 'no-cockpit', error: noCockpit });
  try {
    return await (discover ?? discoverCockpit)({ url, repoDir: resolve(values.repo ?? process.cwd()) });
  } catch (error) {
    // Discovery's hint says to start a cockpit; this command never suggests that.
    if (options.removeDiscoveryHint && error instanceof TaskCliError) {
      const { hint: _hint, ...body } = error.body;
      throw new TaskCliError(error.exitCode, body);
    }
    throw error;
  }
}
