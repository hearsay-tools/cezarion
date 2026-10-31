import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_NAME_PATTERN } from '@open-mercato/cezar-contract/project-limits';
import type { GithubOwner, GithubOwnersResponse } from '@open-mercato/cezar-contract';
import { ERROR_TAIL_LINES, GH_CREDENTIAL_HELPER_CONFIG, createProgressLineSplitter, checkoutTarget, cleanupCheckout, isValidCheckoutName, parseRepoRef, type CheckoutProgressEvent } from './checkout.ts';

/**
 * Create a local Git project, optionally with an explicitly requested private GitHub repository
 * or template. Share checkout target and cleanup rules. After remote creation, preserve useful
 * local work and return recovery warnings.
 */

const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** How long to wait for GitHub to generate a repo from a template before
 *  cloning anyway. Generation is asynchronous and usually takes a few seconds. */
const TEMPLATE_WAIT_ATTEMPTS = 15;
const TEMPLATE_WAIT_MS = 2_000;

/** The one initial branch name for a new local repo. */
const INITIAL_BRANCH = 'main';

const GH_MISSING = 'gh CLI not found — install it and run `gh auth login`';
const CANCELLED = 'project creation cancelled';

export type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; notFound?: boolean };

/** Run one command (never through a shell). Injected so tests can drive the
 *  flow without `gh`, a network, or a git identity. `onLine` receives
 *  progress/stderr lines as they arrive. */
export type CommandRunner = (
  cmd: 'git' | 'gh',
  args: string[],
  opts: { cwd: string; onLine?: (line: string) => void; signal?: AbortSignal | undefined },
) => Promise<CommandResult>;

export const spawnCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
      // Non-interactive on purpose: a prompt nobody can see would pin the request. GH_HOST is
      // pinned because every URL, remote and command this flow names is github.com — an ambient
      // GH_HOST (GitHub Enterprise) would list owners on, and create the repository on, another server.
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...(cmd === 'gh' ? { GH_HOST: 'github.com' } : {}) },
    });
    let stdout = '';
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish({ ok: false, error: CANCELLED });
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // git's progress is carriage-return-separated (see `ghCloneRunner`).
    const lines = createProgressLineSplitter((line) => opts.onLine?.(line));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', lines.consume);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      finish({ ok: false, error: err.message, notFound: (err as NodeJS.ErrnoException).code === 'ENOENT' });
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) return finish({ ok: true, stdout });
      const detail = [...lines.tail, lines.pending.trim(), stdout.trim()].filter((s) => s !== '').slice(-ERROR_TAIL_LINES).join('\n');
      finish({ ok: false, error: detail === '' ? `${cmd} ${args[0] ?? ''} exited with code ${code}` : detail });
    });
  });

/** An identity (and no signing) lent to one `git commit`, so a dry run never
 *  depends on the host's git config. */
const LENT_IDENTITY = ['-c', 'user.name=cezar dry run', '-c', 'user.email=dry-run@cezar.invalid', '-c', 'commit.gpgsign=false'];

/**
 * `CEZ_DRY_RUN=1` — real `git` (it is local and required anyway), fake `gh`
 * and a fake `git push`. Answers the pre-checks as a signed-in account whose
 * name is free and whose template is valid. The fake template clone writes
 * only inside the directory the caller created, as a real repo with one commit,
 * so the registered project can host task worktrees like a real one.
 */
export const dryRunCommandRunner: CommandRunner = async (cmd, args, opts) => {
  if (cmd === 'git' && args[0] === 'push') {
    opts.onLine?.(`(CEZ_DRY_RUN=1) git ${args.join(' ')}`);
    return { ok: true, stdout: '' };
  }
  if (cmd === 'git') return spawnCommandRunner(cmd, args[0] === 'commit' ? [...LENT_IDENTITY, ...args] : args, opts);
  opts.onLine?.(`(CEZ_DRY_RUN=1) gh ${args.join(' ')}`);
  if (args[0] === 'api') {
    const path = args[1] ?? '';
    if (path === 'user') return { ok: true, stdout: 'dry-run-user\n' };
    if (path.endsWith('/commits?per_page=1')) return { ok: true, stdout: '1\n' };
    if (args.includes(TEMPLATE_JQ)) return { ok: true, stdout: '[true,false]\n' };
    return { ok: false, error: 'gh: Not Found (HTTP 404)' };
  }
  if (args[0] === 'repo' && args[1] === 'clone') {
    const dir = args[3] ?? opts.cwd;
    const local = { ...opts, cwd: dir };
    const init = await spawnCommandRunner('git', ['init', '-b', INITIAL_BRANCH], local);
    if (!init.ok) return init;
    await writeFile(join(dir, 'README.md'), `# ${args[2] ?? 'repo'}\n\n(CEZ_DRY_RUN=1 fake template clone)\n`, 'utf8');
    const add = await spawnCommandRunner('git', ['add', 'README.md'], local);
    if (!add.ok) return add;
    return spawnCommandRunner('git', [...LENT_IDENTITY, 'commit', '-m', 'Initial commit'], local);
  }
  return { ok: true, stdout: '' };
};

export type CreateProjectFailure =
  | { ok: false; status: 400 | 409 | 500; error: string }
  | { ok: false; status: 503; error: string; reason: string };

/** `kind` — what was created: a local-only repo, an empty GitHub-backed one, or one from a
 *  template. `warning` — the GitHub repository exists but a later step did not finish. */
export type CreateProjectResult =
  | { ok: true; target: string; name: string; slug?: string; kind: 'local' | 'github' | 'template'; warning?: string }
  | CreateProjectFailure;

export interface CreateProjectOptions {
  /** Project name — both the folder name and, with `github`, the repo name. */
  name: string;
  /** Present ⇒ also create a PRIVATE GitHub repository under `owner`. */
  github?: { owner: string; template?: string | undefined } | undefined;
  /** The checkout root, ALREADY `~`-expanded by the caller. */
  projectsDir: string;
  onProgress: (event: CheckoutProgressEvent) => void;
  checkoutId?: string | undefined;
  /** Cancels the steps BEFORE `gh repo create` only (see the module docstring). */
  signal?: AbortSignal | undefined;
  /** Test seam; defaults to spawning real commands (or the dry-run fake). */
  run?: CommandRunner;
  /** Test seam for the template wait. */
  sleep?: (ms: number) => Promise<void>;
}

const OWNER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const TEMPLATE_JQ = '[.is_template, .archived] | @json';

/** One step after `gh repo create`, with the command a user runs to finish it by hand. */
interface FinishingStep {
  label: string;
  command: string;
  run: () => Promise<CommandResult>;
}

export async function createProject(opts: CreateProjectOptions): Promise<CreateProjectResult> {
  const name = opts.name.trim();
  // GitHub's repository-name rules, even for a local-only project: the name is
  // the folder AND (now or later) the repo, and GitHub would silently rewrite
  // anything else — `my project` becomes `my-project` there but not on disk.
  if (!PROJECT_NAME_PATTERN.test(name) || !isValidCheckoutName(name)) {
    return {
      ok: false,
      status: 400,
      error: `not a valid project name: ${name.slice(0, 200)} — use letters, digits, ".", "-" and "_" only, no spaces`,
    };
  }
  let slug: string | undefined;
  let template: string | undefined;
  if (opts.github) {
    const owner = opts.github.owner.trim();
    if (owner.length > 64 || !OWNER_SEGMENT.test(owner)) {
      return { ok: false, status: 400, error: `not a valid GitHub owner: ${owner.slice(0, 200)}` };
    }
    slug = `${owner}/${name}`;
    const rawTemplate = opts.github.template?.trim() ?? '';
    if (rawTemplate !== '') {
      const ref = parseRepoRef(rawTemplate);
      if (!ref) return { ok: false, status: 400, error: `not a GitHub template repository: ${rawTemplate.slice(0, 200)}` };
      template = ref.slug;
    }
  }
  const destination = checkoutTarget(opts.projectsDir, name);
  if (destination.ok === false) return destination;
  const { root, target } = destination;

  const emit = (event: Omit<CheckoutProgressEvent, 'name' | 'checkoutId'>): void =>
    opts.onProgress({ ...event, name, ...(opts.checkoutId ? { checkoutId: opts.checkoutId } : {}) });
  const say = (line: string): void => emit({ phase: 'cloning', line });
  const refuse = <F extends CreateProjectFailure>(failure: F): F => {
    emit({ phase: 'error', error: failure.error });
    return failure;
  };
  const run = opts.run ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCommandRunner : spawnCommandRunner);
  /** `cancellable` is false from `gh repo create` on: those steps always run to the end. */
  const exec = async (cmd: 'git' | 'gh', args: string[], cancellable: boolean, cwd = target): Promise<CommandResult> => {
    try {
      return await run(cmd, args, { cwd, onLine: say, signal: cancellable ? opts.signal : undefined });
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  };

  if (slug) {
    say('Checking GitHub…');
    const blocked = await githubPreflight(slug, template, (cmd, args) => exec(cmd, args, true, process.cwd()));
    if (blocked) return refuse(blocked);
  }

  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    return refuse({ ok: false, status: 500, error: `checkout root is not writable: ${errText(err)}` });
  }
  // The ownership token, exactly as in checkout.ts: non-recursive, so it
  // succeeds only when WE created the directory — which is what licenses the
  // cleanup below.
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return refuse({ ok: false, status: 409, error: `folder already exists: ${target}` });
    }
    return refuse({ ok: false, status: 500, error: `could not create ${target}: ${errText(err)}` });
  }

  /** Remove the local folder and answer with a failure. */
  const fail = async (status: 400 | 500, error: string): Promise<CreateProjectFailure> => {
    await cleanupCheckout(root, target);
    return refuse({ ok: false, status, error: opts.signal?.aborted ? CANCELLED : error });
  };
  /** Run the steps after `gh repo create`; the first failure stops them and becomes a warning
   *  naming every command still to run. The local repo is kept either way. */
  const finishAfterCreate = async (steps: FinishingStep[]): Promise<string | undefined> => {
    for (const [i, step] of steps.entries()) {
      const result = await step.run();
      if (result.ok) continue;
      const remaining = steps.slice(i).map((s) => s.command).join(' && ');
      return `The private repository ${webUrl(slug!)} was created, but ${step.label} failed: ${firstLine(result.error)}. Finish in ${target} with: ${remaining}`;
    }
    return undefined;
  };
  const credentialStep: FinishingStep = {
    label: 'configuring GitHub credentials',
    // Both operations, as run: a helper inherited from the global config must be cleared too.
    command: GH_CREDENTIAL_HELPER_CONFIG.map((args) => ['git', 'config', '--local', ...args].map(shellQuote).join(' ')).join(' && '),
    run: async () => {
      // PR #968: route this repo's github.com HTTPS credentials through `gh`, as `checkout.ts` does.
      for (const args of GH_CREDENTIAL_HELPER_CONFIG) {
        const result = await exec('git', ['config', '--local', ...args], false);
        if (!result.ok) return result;
      }
      return { ok: true, stdout: '' };
    },
  };
  /** `gh repo create` failed — which does not prove GitHub did nothing. Check the name again and
   *  say what the user finds there; never adopt (or delete) a repository cezar cannot prove it made. */
  const createFailed = async (error: string): Promise<CreateProjectFailure> => {
    const recheck = await exec('gh', ['api', `repos/${slug}`, '--jq', '.full_name'], false, process.cwd());
    if (recheck.ok) {
      const recovery = template
        ? `If this attempt created it, add it with Add project → Clone from GitHub (${slug}).`
        : 'If this attempt created it, it is empty — delete it on GitHub and create the project again, or choose another name.';
      return fail(500, `${error}\nThe private repository ${webUrl(slug!)} exists on GitHub now. ${recovery}`);
    }
    if (isNotFound(recheck.error)) return fail(500, error);
    return fail(500, `${error}\nCould not check whether ${webUrl(slug!)} was created — look on GitHub before trying again.`);
  };
  const done = (kind: 'local' | 'github' | 'template', warning: string | undefined): CreateProjectResult => {
    emit({ phase: 'done', ...(warning ? { warning } : {}) });
    return { ok: true, target, name, ...(slug ? { slug } : {}), kind, ...(warning ? { warning } : {}) };
  };

  if (slug && template) {
    if (opts.signal?.aborted) return fail(500, CANCELLED);
    say(`Creating private repository ${slug} from ${template}…`);
    const created = await exec('gh', ['repo', 'create', slug, '--private', '--template', template], false);
    if (!created.ok) return createFailed(created.error);
    // Template generation is asynchronous on GitHub: an immediate clone can
    // land an empty repo. Wait until the first commit is visible — and since
    // the wait gives up eventually, the clone is checked for a commit below.
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < TEMPLATE_WAIT_ATTEMPTS; attempt++) {
      const probe = await exec('gh', ['api', `repos/${slug}/commits?per_page=1`, '--jq', 'length'], false);
      if (probe.ok && Number.parseInt(probe.stdout.trim(), 10) > 0) break;
      if (attempt === 0) say('Waiting for GitHub to generate the repository…');
      await sleep(TEMPLATE_WAIT_MS);
    }
    const cloned = await exec('gh', ['repo', 'clone', cloneUrl(slug), target, '--', '--progress'], false);
    if (!cloned.ok) {
      // Nothing local is worth keeping (the folder holds at most a partial
      // clone), so this is the one post-create failure that cleans up — and
      // says how to finish from the repository that now exists.
      await cleanupCheckout(root, target);
      return refuse({
        ok: false,
        status: 500,
        error: `${cloned.error}\nThe private repository ${webUrl(slug)} was created on GitHub — add it with Add project → Clone from GitHub (${slug}).`,
      });
    }
    // git clones an empty remote without complaint, and a project with no
    // commit cannot host a task: that is a failed clone, not a success.
    const head = await exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], false);
    if (!head.ok) {
      await cleanupCheckout(root, target);
      return refuse({
        ok: false,
        status: 500,
        error: `GitHub had not finished generating ${slug} from ${template}, so the clone has no commit. The private repository ${webUrl(slug)} was created on GitHub — once it shows the template's files, add it with Add project → Clone from GitHub (${slug}).`,
      });
    }
    return done('template', await finishAfterCreate([credentialStep]));
  }

  say('Initializing a git repository…');
  const init = await exec('git', ['init', '-b', INITIAL_BRANCH], true);
  if (!init.ok) return fail(500, init.error);
  // An empty commit gives the project a base commit to branch task worktrees
  // from, without writing any file the user did not ask for. Without one the
  // project cannot host a task, so a failure here (most likely no git
  // identity) is a refusal, not a footnote — and nothing remote exists yet.
  const commit = await exec('git', ['commit', '--allow-empty', '-m', 'Initial commit'], true);
  if (!commit.ok) {
    return fail(
      400,
      `Could not make the initial commit — set your git identity: git config --global user.name "Your Name" && git config --global user.email you@example.com (${firstLine(commit.error)})`,
    );
  }
  if (!slug) return done('local', undefined);

  if (opts.signal?.aborted) return fail(500, CANCELLED);
  say(`Creating private repository ${slug}…`);
  const created = await exec('gh', ['repo', 'create', slug, '--private'], false);
  if (!created.ok) return createFailed(created.error);
  // HTTPS remote + gh credential helper, exactly as a clone gets (#968); the
  // push then goes through plain git, proving the setup a task push relies on.
  const warning = await finishAfterCreate([
    {
      label: 'adding the origin remote',
      command: `git remote add origin ${cloneUrl(slug)}`,
      run: () => exec('git', ['remote', 'add', 'origin', cloneUrl(slug)], false),
    },
    credentialStep,
    {
      label: `pushing ${INITIAL_BRANCH}`,
      command: `git push -u origin ${INITIAL_BRANCH}`,
      run: () => {
        say(`Pushing ${INITIAL_BRANCH} to ${slug}…`);
        return exec('git', ['push', '-u', 'origin', INITIAL_BRANCH], false);
      },
    },
  ]);
  return done('github', warning);
}

/**
 * The GitHub checks that run before anything exists: `gh` present and signed
 * in, `<owner>/<name>` free, the template a live template repository. A
 * failure answers with the refusal; `undefined` means go ahead.
 */
async function githubPreflight(
  slug: string,
  template: string | undefined,
  exec: (cmd: 'gh', args: string[]) => Promise<CommandResult>,
): Promise<CreateProjectFailure | undefined> {
  const user = await exec('gh', ['api', 'user', '--jq', '.login']);
  if (!user.ok) {
    const reason = user.notFound ? GH_MISSING : unauthenticated(user.error);
    return { ok: false, status: 503, error: reason, reason };
  }
  const existing = await exec('gh', ['api', `repos/${slug}`, '--jq', '.full_name']);
  if (existing.ok) return { ok: false, status: 409, error: `a repository named ${slug} already exists on GitHub` };
  if (!isNotFound(existing.error)) {
    return { ok: false, status: 500, error: `could not check whether ${slug} exists on GitHub: ${firstLine(existing.error)}` };
  }
  if (template) {
    const probe = await exec('gh', ['api', `repos/${template}`, '--jq', TEMPLATE_JQ]);
    if (!probe.ok) {
      return isNotFound(probe.error)
        ? { ok: false, status: 400, error: `${template} was not found on GitHub` }
        : { ok: false, status: 500, error: `could not check the template ${template}: ${firstLine(probe.error)}` };
    }
    let flags: unknown;
    try {
      flags = JSON.parse(probe.stdout.trim());
    } catch {
      flags = null;
    }
    const [isTemplate, archived] = Array.isArray(flags) ? flags : [];
    if (isTemplate !== true) return { ok: false, status: 400, error: `${template} is not a GitHub template repository` };
    if (archived !== false) return { ok: false, status: 400, error: `${template} is archived` };
  }
  return undefined;
}

/** `GET /api/v1/projects/github-owners` — who a new repository may belong to:
 *  the signed-in user first, then their organisations, each with its avatar
 *  (and an org's description) for the dialog's owner cards. */
export async function listGithubOwners(run?: CommandRunner): Promise<GithubOwnersResponse> {
  if (!run && process.env.CEZ_DRY_RUN === '1') {
    return {
      available: true,
      owners: [
        { login: 'dry-run-user', personal: true },
        { login: 'dry-run-org', personal: false, description: 'CEZ_DRY_RUN=1 fake organisation' },
      ],
    };
  }
  const exec = run ?? spawnCommandRunner;
  const cwd = process.cwd();
  const settle = (args: string[]): Promise<CommandResult> =>
    exec('gh', args, { cwd }).catch((err: unknown) => ({ ok: false as const, error: errText(err) }));
  const [user, orgs] = await Promise.all([
    settle(['api', 'user', '--jq', '[.login, .avatar_url // ""] | @tsv']),
    settle(['api', 'user/orgs', '--paginate', '--jq', '.[] | [.login, .avatar_url // "", .description // ""] | @tsv']),
  ]);
  if (!user.ok) return { available: false, reason: user.notFound ? GH_MISSING : unauthenticated(user.error) };
  const me = parseOwnerLine(user.stdout.split('\n')[0] ?? '', true);
  if (!me) return { available: false, reason: 'gh returned no GitHub login' };
  // An org listing failure (e.g. a token without read:org) still leaves the
  // personal account — degrade to that rather than hide GitHub entirely.
  const orgOwners = new Map<string, GithubOwner>();
  if (orgs.ok) {
    for (const line of orgs.stdout.split('\n')) {
      const org = parseOwnerLine(line, false);
      if (org && org.login !== me.login) orgOwners.set(org.login, org);
    }
  }
  const sorted = [...orgOwners.values()].sort((a, b) => a.login.localeCompare(b.login));
  return { available: true, owners: [me, ...sorted] };
}

/** One `login<TAB>avatar[<TAB>description]` line from `gh --jq … | @tsv`.
 *  Only https avatars are passed on — the cockpit renders them as `<img src>`. */
function parseOwnerLine(line: string, personal: boolean): GithubOwner | null {
  const [login = '', avatar = '', ...rest] = line.split('\t');
  const trimmed = login.trim();
  if (!OWNER_SEGMENT.test(trimmed)) return null;
  // `@tsv` escapes tabs/newlines inside a field as `\t`/`\n`; fold them to spaces.
  const description = rest.join(' ').replace(/\\[tnr]/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    login: trimmed,
    personal,
    ...(avatar.trim().startsWith('https://') ? { avatarUrl: avatar.trim() } : {}),
    ...(description !== '' ? { description: description.slice(0, 200) } : {}),
  };
}

function unauthenticated(error: string): string {
  return `gh is not authenticated — run \`gh auth login\` (${firstLine(error)})`;
}

/** `gh api` reports a missing repository as `HTTP 404`. */
function isNotFound(error: string): boolean {
  return /\b404\b|Not Found/.test(error);
}

/** The HTTPS remote, never the bare slug: `gh` would pick SSH from its own config, and an SSH key
 *  is what an organisation's SAML policy may reject (#968, `RepoRef.cloneUrl`). */
function cloneUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

function webUrl(slug: string): string {
  return `https://github.com/${slug}`;
}

/** POSIX single-quoting for a copyable command: bare when safe, `''` when empty. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() || text;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
