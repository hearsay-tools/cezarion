import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ciPrIdentitySchema, ciWaitRequestSchema, type CiPrIdentity, type CiWaitErrorCode } from '@open-mercato/cezar-contract/ci-wait';

export const CI_QUERY_TIMEOUT_MS = 10_000;
/** `gh pr checks --watch --interval`, in seconds. Not the query timeout. */
export const CI_WATCH_INTERVAL_SECONDS = 30;
export const CI_QUERY_LIMIT = 4;
export const CI_OUTPUT_LIMIT = 64 * 1024;
export const CI_TERMINATE_MS = 2_000;

export class CiGithubError extends Error {
  constructor(readonly code: CiWaitErrorCode, message: string, readonly transient = false) { super(message); }
}

/** FIFO permits; aborted queued requests never consume a slot. */
export class CiSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const i = this.queue.indexOf(ready); if (i >= 0) this.queue.splice(i, 1); reject(signal.reason); };
      this.queue.push(ready); signal.addEventListener('abort', abort, { once: true });
    });
    else this.active++;
    // A slot is transferred to the oldest waiter, not released and raced for.
    if (signal.aborted) { this.release(); signal.throwIfAborted(); }
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  private release(): void { const next = this.queue.shift(); if (next) next(); else this.active--; }
}

// The helper owns gh's process group and observes the controller-owned stdin pipe.
// EOF (including controller SIGKILL) initiates termination without trusting persisted PIDs.
// Keep this inline so the installed JS artifact carries the helper without another asset.
export const CI_PROCESS_WRAPPER = String.raw`
const { spawn } = require('node:child_process');
const command = JSON.parse(process.argv[1]);
const child = spawn(command.file, command.args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stopping = false, escalation, spawnFailed = false;
function kill(force) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T']; if (force) args.push('/F');
    spawn('taskkill', args, {stdio:'ignore',windowsHide:true}).on('error',()=>{});
  } else { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
}
function stop() {
 if (stopping) return; stopping = true; kill(false);
 escalation = setTimeout(() => kill(true), ${CI_TERMINATE_MS});
}
process.stdin.resume(); process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdout.on('error', stop); process.stderr.on('error', stop);
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.on('error', () => { spawnFailed = true; });
// A grandchild can retain the leader's stdout after exit; close alone would wait forever.
child.on('exit', () => kill(true));
child.on('close', code => { clearTimeout(escalation); process.exit(spawnFailed ? 127 : code === null ? 143 : code); });
`;
const dryRunCommand = String.raw`
const args = process.argv.slice(1);
if (args[1] === 'view') {
 const url = args[2].startsWith('https:') ? args[2] : 'https://' + args[args.indexOf('--repo')+1] + '/pull/' + args[2];
 console.log(JSON.stringify({url, number:Number(url.split('/').pop()), headRefOid:'a'.repeat(40),mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',state:'MERGED',mergedAt:'2026-01-01T00:00:00Z',mergeCommit:{oid:'b'.repeat(40)}}));
} else if (args[0] === 'api') console.log(JSON.stringify({total_count:0,workflow_runs:[]}));
else if (!args.includes('--watch')) console.log(JSON.stringify([{name:'Dry-run checks',state:'SUCCESS',bucket:'pass',link:''}]));
`;
export type CiCommandResult = { code: number; stdout: string; stderr: string };
export type CiCommandOptions = { file: string; args: string[] };

/** Environment stays inherited, matching the existing forge gh resolver (including GH_TOKEN/GITHUB_TOKEN). */
export async function runCiCommand(command: CiCommandOptions, signal: AbortSignal, discardOutput = false, env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<CiCommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CI_PROCESS_WRAPPER, JSON.stringify(command)], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', bytes = 0;
    let failure: unknown;
    const abort = () => { failure ??= signal.reason; child.stdin.end(); };
    signal.addEventListener('abort', abort, { once: true });
    // Closing stdin asks the wrapper to terminate and await the owned process tree.
    const capture = (chunk: Buffer, error: boolean) => {
      if (!error && discardOutput) return;
      bytes += chunk.length;
      if (bytes > CI_OUTPUT_LIMIT) { failure ??= new CiGithubError('output_limit', 'GitHub output exceeded 64 KiB; narrow the PR check set and retry.'); child.stdin.end(); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, true));
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = new CiGithubError('gh_missing', 'Unable to launch GitHub CLI; install gh and retry.'); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? 143, stdout, stderr });
    });
    if (signal.aborted) abort();
  });
}

const metadataSchema = z.object({
  url: z.string(), number: z.number().int().positive(), headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
  mergeable: z.string().nullish().transform(value => value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN' as const),
  mergeStateStatus: z.string().nullish().transform(value => (value ?? 'UNKNOWN')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 64)),
});
export type GithubPrMetadata = Pick<z.infer<typeof metadataSchema>, 'mergeable' | 'mergeStateStatus'> & { headSha: string };
// hearsay-tools/cezarion#1425: what a merge wait reads. An unknown state reads as still open.
const mergeStateSchema = z.object({
  state: z.string().nullish().transform(value => value === 'MERGED' || value === 'CLOSED' ? value : 'OPEN' as const),
  mergedAt: z.iso.datetime({ offset: true }).nullish(),
  mergeCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/i) }).nullish(),
});
export type GithubPrMergeState = GithubPrMetadata & { state: 'OPEN' | 'CLOSED' | 'MERGED'; mergedAt?: string; mergeCommitSha?: string };
const METADATA_FIELDS = 'url,number,headRefOid,mergeable,mergeStateStatus';
export const githubChecksSchema = z.array(z.object({ name: z.string(), state: z.string(), link: z.string(), bucket: z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']) }));
export type GithubCheck = z.infer<typeof githubChecksSchema>[number];
const workflowPagesSchema = z.array(z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.tuple([z.number().int().positive(), z.string().min(1), z.boolean()])),
})).min(1);
function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(text)); } catch { throw new CiGithubError('malformed_data', 'GitHub returned malformed structured data; update gh and retry.'); }
}
function commandError(result: CiCommandResult): CiGithubError {
  // Only classify stderr: never forward potentially credential-bearing external diagnostics.
  if (result.code === 127) return new CiGithubError('gh_missing', 'GitHub CLI is unavailable; install gh and retry.');
  if (/rate limit|429/i.test(result.stderr)) return new CiGithubError('command_failed', 'GitHub query was rate limited; wait and retry.', true);
  if (/401|403|auth|log.?in|token/i.test(result.stderr)) return new CiGithubError('authentication', 'GitHub authentication failed; run gh auth login with access to this repository.');
  if (/404|not found|could not resolve|no pull requests/i.test(result.stderr)) return new CiGithubError('inaccessible_pr', 'PR is inaccessible; verify its URL and repository access.');
  return new CiGithubError('command_failed', 'GitHub query failed; check connectivity and GitHub availability, then retry.', true);
}
export class GithubCiClient {
  private readonly queries = new CiSemaphore(CI_QUERY_LIMIT);
  private readonly command: CiCommandOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd?: string;
  constructor(options: { command?: CiCommandOptions; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
    this.env = options.env ?? process.env;
    this.command = options.command ?? (this.env.CEZ_DRY_RUN === '1' ? { file: process.execPath, args: ['-e', dryRunCommand] } : { file: 'gh', args: [] });
    this.cwd = options.cwd;
  }
  private async query(args: string[], signal: AbortSignal): Promise<CiCommandResult> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(CI_QUERY_TIMEOUT_MS)]);
    let release: (() => void) | undefined;
    try {
      release = await this.queries.acquire(bounded);
      return await runCiCommand({ file: this.command.file, args: [...this.command.args, ...args] }, bounded, false, this.env, this.cwd); }
    catch (error) { if (!signal.aborted && bounded.aborted) throw new CiGithubError('query_timeout', 'GitHub query exceeded ten seconds; check connectivity and retry.', true); throw error; }
    finally { release?.(); }
  }
  private async readMetadata(pr: string, signal: AbortSignal, merge = false): Promise<CiPrIdentity & GithubPrMetadata & { raw: unknown }> {
    if (!ciWaitRequestSchema.safeParse({pr}).success) throw new CiGithubError('invalid_request', 'Provide an HTTPS GitHub pull request URL.');
    const supplied = new URL(pr);
    if (supplied.hostname !== 'github.com') throw new CiGithubError('unsupported_host', 'This GitHub Enterprise host is not recognized by the forge configuration; use github.com or configure supported forge authentication.');
    const response = await this.query(['pr', 'view', pr, '--json', merge ? `${METADATA_FIELDS},state,mergedAt,mergeCommit` : METADATA_FIELDS], signal);
    if (response.code !== 0) throw commandError(response);
    const metadata = parseJson(response.stdout, metadataSchema);
    const raw: unknown = merge ? JSON.parse(response.stdout) : undefined;
    const validUrl = ciWaitRequestSchema.safeParse({pr:metadata.url});
    if (!validUrl.success) throw new CiGithubError('malformed_data', 'GitHub returned an invalid canonical PR URL.');
    const url = new URL(metadata.url);
    const parts = url.pathname.split('/');
    if (url.hostname !== supplied.hostname || Number(parts[4]) !== metadata.number || metadata.number !== Number(supplied.pathname.split('/')[4])) throw new CiGithubError('malformed_data', 'GitHub returned inconsistent PR identity.');
    return { ...ciPrIdentitySchema.parse({ prUrl: metadata.url, repository: `${parts[1]}/${parts[2]}`, prNumber: metadata.number, headSha: metadata.headRefOid }),
      mergeable: metadata.mergeable, mergeStateStatus: metadata.mergeStateStatus, raw };
  }
  async resolve(pr: string, signal: AbortSignal): Promise<CiPrIdentity> {
    const { prUrl, repository, prNumber, headSha } = await this.readMetadata(pr, signal);
    return { prUrl, repository, prNumber, headSha };
  }
  async metadata(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubPrMetadata> {
    const { headSha, mergeable, mergeStateStatus } = await this.readMetadata(pr.prUrl, signal);
    return { headSha, mergeable, mergeStateStatus };
  }
  /** The PR's state for a merge wait, in one bounded query with its head and mergeability. */
  async mergeState(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubPrMergeState> {
    const { headSha, mergeable, mergeStateStatus, raw } = await this.readMetadata(pr.prUrl, signal, true);
    const parsed = mergeStateSchema.safeParse(raw);
    if (!parsed.success) throw new CiGithubError('malformed_data', 'GitHub returned malformed structured data; update gh and retry.');
    const { state, mergedAt, mergeCommit } = parsed.data;
    return { headSha, mergeable, mergeStateStatus, state, ...(mergedAt ? { mergedAt } : {}), ...(mergeCommit ? { mergeCommitSha: mergeCommit.oid.toLowerCase() } : {}) };
  }
  async head(pr: CiPrIdentity, signal: AbortSignal): Promise<string> { return (await this.metadata(pr, signal)).headSha; }
  async hasActiveRuns(pr: CiPrIdentity, signal: AbortSignal): Promise<boolean> {
    // gh follows every page in one bounded query. Keep counts so GitHub's filtered
    // search cap or a changing page set cannot turn incomplete data into success.
    const result = await this.query(['api', '--hostname', 'github.com',
      `repos/${pr.repository}/actions/runs?head_sha=${pr.headSha}&per_page=100`, '--paginate',
      '--jq', `{total_count, workflow_runs: [.workflow_runs[] | [.id, .status, (.head_sha | if type == "string" and test("^[0-9a-fA-F]{40}$") then ascii_downcase == ${JSON.stringify(pr.headSha.toLowerCase())} else null end)]]} | @json`], signal);
    if (result.code !== 0) throw commandError(result);
    // Compact tuples keep 1000 ordinary runs below the output cap while retaining
    // independent head matching. --jq emits one JSON line per page; --slurp cannot be combined with --jq.
    const pages = parseJson('[' + result.stdout.trim().split(/\r?\n/).filter(Boolean).join(',') + ']', workflowPagesSchema);
    const runs = pages.flatMap(page => page.workflow_runs);
    const unique = new Set(runs.map(run => run[0]));
    if (unique.size !== runs.length || unique.size < Math.max(...pages.map(page => page.total_count))) {
      throw new CiGithubError('malformed_data', 'GitHub returned an incomplete workflow run list; retry the CI wait.');
    }
    return runs.some(([, status, headMatches]) => headMatches && status !== 'completed');
  }
  async checks(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubCheck[]> {
    const result = await this.query(['pr', 'checks', String(pr.prNumber), '--repo', `github.com/${pr.repository}`, '--json', 'name,state,link,bucket'], signal);
    // gh documents 1 for failed checks and 8 for pending. Only validated JSON decides CI outcome.
    if (![0, 1, 8].includes(result.code) || !result.stdout.trim()) {
      // gh's empty-check path emits no JSON; pin the exact CLI diagnostic, never a generic exit 1.
      if (result.code === 1 && /^no checks reported on the ['"]?.+['"]? branch\s*$/i.test(result.stderr.trim())) return [];
      throw commandError(result);
    }
    return parseJson(result.stdout, githubChecksSchema);
  }
  async watch(pr: CiPrIdentity, signal: AbortSignal): Promise<void> {
    const result = await runCiCommand({file:this.command.file,args:[...this.command.args, 'pr', 'checks', String(pr.prNumber), '--repo', `github.com/${pr.repository}`, '--watch', '--interval', String(CI_WATCH_INTERVAL_SECONDS)]}, signal, true, this.env, this.cwd);
    if (![0,1,8].includes(result.code) || result.stderr.trim()) throw commandError(result);
  }
}
