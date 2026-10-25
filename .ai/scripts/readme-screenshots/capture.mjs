#!/usr/bin/env node
// Recapture the README gallery (hearsay-tools/cezarion#1456). See docs/screenshots/README.md.
//
// Two cockpits boot from this checkout's build, each with a scratch HOME and CEZ_HOME under a
// /tmp work directory, so the live cockpit's `.ai/cezar` and the host's global skills never
// reach an image. The GitHub cell comes from a boot without dry run that runs no task and reads
// public data through the caller's `gh` login. The other cells come from a CEZ_DRY_RUN=1 boot
// whose agent is demo-agent.mjs. The images replace the files in `--out` only when every
// selected cell was captured.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveBrowserLaunch } from '../resolve-browser-launch.mjs';
import { createDemoRepos } from './demo-repos.mjs';
import { CELLS, LIVE_RUN_TASK, SEED_TASKS, VIEWPORT, findMockText } from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Cockpits and browser sessions still open, so a signal can stop them before the exit. */
const open = new Set();
export const REPO_ROOT = resolve(HERE, '../../..');

export const USAGE = `Usage: node .ai/scripts/readme-screenshots/capture.mjs [options]

Regenerates the README gallery images from this checkout's build (run npm run build first).

Options:
  --out <dir>     Where the images go (default: docs/screenshots)
  --only <cell>   Capture only this cell; repeat for more. Cells: ${CELLS.map((cell) => cell.name).join(', ')}
  --keep          Keep the scratch work directory and print its path
  --help          Show this text
`;

/** The parsed command line. Throws with a one-line reason for an unknown flag or cell. */
export function parseOptions(argv, repoRoot = REPO_ROOT) {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string' }, only: { type: 'string', multiple: true }, keep: { type: 'boolean' }, help: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  });
  const names = CELLS.map((cell) => cell.name);
  const unknown = (values.only ?? []).filter((name) => !names.includes(name));
  if (unknown.length) throw new Error(`unknown cell: ${unknown.join(', ')} (cells: ${names.join(', ')})`);
  const only = values.only ?? names;
  return {
    out: resolve(repoRoot, values.out ?? 'docs/screenshots'),
    cells: CELLS.filter((cell) => only.includes(cell.name)),
    keep: values.keep === true,
    help: values.help === true,
  };
}

/** `agent-browser` on PATH, else the cached release `.ai/browsers/agent-browser.md` installs. */
export function findAgentBrowser(env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, 'agent-browser'))) return join(dir, 'agent-browser');
  }
  const cache = join(env.XDG_CACHE_HOME || join(env.HOME ?? '', '.cache'), 'agent-tools', 'agent-browser');
  const release = existsSync(cache) ? readdirSync(cache).find((name) => /^agent-browser-[a-z0-9-]+(\.exe)?$/.test(name)) : undefined;
  return release ? join(cache, release) : null;
}

/** Where `gh` keeps its login on this host. The scratch HOME would hide it, so the GitHub boot
 *  passes the directory, never a token. */
export function ghConfigDir(env = process.env) {
  return env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config'), 'gh');
}

/**
 * The environment a cockpit boots with: the caller's, without its CEZ_* and GIT_* settings,
 * plus a scratch HOME, an empty Git config with a fixed identity, and `extra`.
 */
export function serverEnv(base, { home, gitConfig, extra }) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^(CEZ|GIT)_/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Cezarion',
    GIT_AUTHOR_EMAIL: 'cezarion@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Cezarion',
    GIT_COMMITTER_EMAIL: 'cezarion@users.noreply.github.com',
    CEZ_PROJECT_WARMUP: '0',
    ...extra,
  };
}

/** One reason per missing prerequisite for these cells; empty when the run can start. */
export function missingPrerequisites({ cells, repoRoot = REPO_ROOT, browser, ghLoggedIn }) {
  const missing = [];
  if (!existsSync(join(repoRoot, 'packages/cezar/dist/index.js')) || !existsSync(join(repoRoot, 'packages/cezar/web/dist/index.html'))) {
    missing.push('no build: run npm run build first');
  }
  if (!browser) missing.push('agent-browser is not installed: follow ensure-installed in .ai/browsers/agent-browser.md');
  if (cells.some((cell) => cell.boot === 'github') && !ghLoggedIn()) {
    missing.push('gh is not logged in, and the github-issues cell reads GitHub through it: run gh auth login, or pass --only for the other cells');
  }
  return missing;
}

function ghLoggedIn() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Poll `probe` until it returns a value, or throw `what` after `timeoutMs`. */
export async function waitUntil(probe, what, timeoutMs, interval = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(interval);
  }
}

/** A cockpit server this command started, in its own process group. */
export class Cockpit {
  static async start({ repo, env, logFile, cli = join(REPO_ROOT, 'packages/cezar/dist/index.js') }) {
    const child = spawn(process.execPath, [cli, 'serve', '--repo', repo, '--port', '0', '--no-open'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cockpit = new Cockpit(child);
    open.add(cockpit);
    let output = '';
    const record = (chunk) => { output += chunk; writeFileSync(logFile, output); };
    child.stdout.setEncoding('utf8').on('data', record);
    child.stderr.setEncoding('utf8').on('data', record);
    try {
      cockpit.url = await waitUntil(() => child.exitCode === null ? /cockpit → (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] : Promise.reject(new Error(`the cockpit exited; see ${logFile}`)), 'the cockpit to listen', 60_000, 200);
      cockpit.project = (await cockpit.api('/projects')).bootProject;
    } catch (error) {
      // The caller gets no cockpit to stop, so a failed start stops its own server.
      await cockpit.stop();
      throw error;
    }
    return cockpit;
  }

  constructor(child) {
    this.child = child;
  }

  /** A JSON API call. A mutating call names the cockpit as its origin, as the cockpit does. */
  async api(path, body) {
    const init = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: this.url } };
    const response = await fetch(`${this.url}/api/v1${path}`, init);
    const json = await response.json();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${response.status}: ${json.error ?? JSON.stringify(json)}`);
    return json;
  }

  /** SIGTERM to the whole group; SIGKILL after 15 s. The agent sessions see stdin close. */
  async stop() {
    open.delete(this);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((done) => this.child.once('exit', done));
    process.kill(-this.child.pid, 'SIGTERM');
    if (await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)])) return;
    process.kill(-this.child.pid, 'SIGKILL');
    await exited;
  }
}

/** One agent-browser session, so the capture never touches a user's browser profile. */
class Browser {
  constructor(bin, session) {
    const launch = resolveBrowserLaunch();
    this.bin = bin;
    this.prefix = ['--namespace', 'cez-readme', ...(launch.launchArgs.length ? ['--args', launch.launchArgs.join(',')] : []), '--session', session];
    this.env = { ...process.env, ...launch.runtimeEnv };
    open.add(this);
  }

  run(...command) {
    let stdout;
    try {
      stdout = execFileSync(this.bin, [...this.prefix, ...command, '--json'], { env: this.env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      stdout = error.stdout ?? '';
    }
    const answer = JSON.parse(stdout || '{"success":false,"error":"no output"}');
    if (!answer.success) throw new Error(`agent-browser ${command[0]}: ${answer.error}`);
    return answer.data;
  }

  evaluate(js) {
    return this.run('eval', js).result;
  }

  /** Wait for a page expression to hold; `what` names it in the timeout error. */
  waitFor(js, what, timeoutMs = 60_000) {
    return waitUntil(() => this.evaluate(`Boolean(${js})`), what, timeoutMs, 250);
  }

  close() {
    open.delete(this);
    try {
      this.run('close');
    } catch {
      // Already closed, or never opened.
    }
  }
}

/** Settle the page, refuse it when its visible text gives the dry run away, then capture it. */
async function shoot(browser, cell, dir) {
  await browser.waitFor('document.fonts.status === "loaded"', 'web fonts');
  // Entrance transitions run about 300 ms; this outlasts them.
  await sleep(1_000);
  const giveaway = findMockText(browser.evaluate('document.body.innerText'));
  if (giveaway) throw new Error(`${cell.name}: the page shows "${giveaway}"`);
  // A control the capture clicked keeps its focus ring; the image shows none.
  browser.evaluate('document.activeElement?.blur?.()');
  const path = join(dir, `${cell.name}.png`);
  browser.run('screenshot', path);
  return path;
}

/** Point the session at a cell's viewport, in the dark theme, on `url`. */
async function openCell(browser, cell, url) {
  browser.run('set', 'viewport', String(cell.width), String(VIEWPORT.height), String(VIEWPORT.scale));
  browser.run('set', 'media', 'dark');
  browser.run('open', url);
  browser.evaluate("localStorage.setItem('cez-theme', 'dark')");
  browser.run('open', url);
  await browser.waitFor('document.querySelector("main")', 'the cockpit shell');
}

// The sidebar's quick list carries `data-bucket` too; these name the table's group.
const FINISHED_GROUP = '[data-slot="task-status-group"][data-bucket="Finished"]';
const FINISHED_TOGGLE = `${FINISHED_GROUP} [data-slot="status-group-toggle"]`;
const WORKING_GROUP = '[data-slot="task-status-group"][data-bucket="Working"]';

const CAPTURE = {
  async 'github-issues'(browser, cell, cockpit) {
    await openCell(browser, cell, `${cockpit.url}/p/${cockpit.project}/github`);
    await browser.waitFor('document.querySelector(\'[data-slot="gh-row"]\')', 'the GitHub issue list', 90_000);
    browser.run('click', '[data-slot="gh-row"]');
    await browser.waitFor('document.querySelector(\'[data-slot="gh-detail-inner"]\')', 'the issue detail');
  },
  async 'task-view'(browser, cell, cockpit) {
    await openCell(browser, cell, `${cockpit.url}/p/${cockpit.project}/`);
    browser.run('click', '[data-slot="task-columns-trigger"]');
    browser.run('find', 'text', 'Resource columns', 'click');
    await browser.waitFor('document.querySelector(\'[data-presentation="resources"]\')', 'the resource columns');
    browser.run('press', 'Escape');
    // The table lists Finished before Working. Folded, it leaves room for the running and
    // queued tasks. The fold persists in the page, so click only an open group.
    if (browser.evaluate(`document.querySelector('${FINISHED_TOGGLE}')?.getAttribute('aria-expanded') === 'true'`)) browser.run('click', FINISHED_TOGGLE);
    await browser.waitFor(`document.querySelector('${FINISHED_GROUP}')?.dataset.folded === 'true'`, 'the folded Finished group');
    // A running row shows CPU and memory after the cockpit's first usage sample of its agent.
    await browser.waitFor(`(document.querySelector('${WORKING_GROUP}')?.innerText.match(/[\\d.]+ [KMG]B/g) ?? []).length >= 2`, 'the running tasks\' memory', 120_000);
  },
  async 'live-run'(browser, cell, cockpit, seeded) {
    await openCell(browser, cell, `${cockpit.url}/p/${cockpit.project}/tasks/${seeded.liveRunId}`);
    await browser.waitFor('(document.body.innerText.match(/npm test --/g) || []).length >= 2', 'the live turn to reach its test run');
  },
  async 'workflow-builder'(browser, cell, cockpit) {
    await openCell(browser, cell, `${cockpit.url}/p/${cockpit.project}/workflows`);
    await browser.waitFor('document.querySelector(\'#workflow-load option[value="implement-and-review"]\')', 'the seeded workflow');
    browser.run('select', '#workflow-load', 'implement-and-review');
    await browser.waitFor('document.body.innerText.includes("Security review")', 'the workflow steps');
  },
};

/** Statuses of every run in the cockpit's projects. */
async function statuses(cockpit, projects) {
  const lists = await Promise.all(projects.map((project) => cockpit.api(`/p/${project}/run-summaries`)));
  return lists.flat();
}

/** Start `seeds` and return their runs, in order. */
async function startTasks(cockpit, seeds, projectIds) {
  const runs = [];
  for (const seed of seeds) {
    runs.push({ seed, run: await cockpit.api(`/p/${projectIds[seed.project]}/runs`, { workflow: seed.workflow, task: seed.task }) });
  }
  return runs;
}

/**
 * Seed the demo tasks: the batch runs to its end, two of them open dry-run draft pull requests,
 * then the live tasks take both default slots and the queued tasks wait behind them.
 */
async function seedDemo(cockpit, repos, log) {
  const storefront = (await cockpit.api('/projects', { root: repos.storefront })).project.id;
  const projectIds = { cezarion: cockpit.project, storefront };
  const projects = Object.values(projectIds);
  const phase = (name) => SEED_TASKS.filter((seed) => seed.phase === name);
  log(`seeding ${phase('batch').length} finished tasks`);
  const batch = await startTasks(cockpit, phase('batch'), projectIds);
  await waitUntil(async () => !(await statuses(cockpit, projects)).some((run) => run.status === 'queued' || run.status === 'running'), 'the seeded batch to finish', 600_000, 2_000);
  for (const { seed, run } of batch.filter((entry) => entry.seed.pr)) {
    await cockpit.api(`/p/${projectIds[seed.project]}/runs/${run.id}/pr`, {});
  }
  log('starting the running and queued tasks');
  const live = await startTasks(cockpit, phase('live'), projectIds);
  const liveIds = new Set(live.map((entry) => entry.run.id));
  await waitUntil(async () => (await statuses(cockpit, projects)).filter((run) => liveIds.has(run.id) && run.status === 'running').length === liveIds.size, 'the live tasks to start', 120_000, 1_000);
  await startTasks(cockpit, phase('queued'), projectIds);
  return { liveRunId: live.find((entry) => entry.seed.task === LIVE_RUN_TASK).run.id };
}

/** Write the launcher the cockpit runs as `claude`: this Node and the demo agent. */
function writeAgentLauncher(work) {
  const launcher = join(work, 'bin', 'claude');
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, 'demo-agent.mjs'))} "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

/** Boot one cockpit, run `prepare`, capture `cells`, and stop it. */
async function captureBoot({ name, cells, repo, env, work, browserBin, shots, prepare, log }) {
  log(`booting the ${name} cockpit`);
  const cockpit = await Cockpit.start({ repo, env, logFile: join(work, `${name}-cockpit.log`) });
  let browser;
  try {
    browser = new Browser(browserBin, `cez-readme-${name}-${process.pid}`);
    const seeded = await prepare(cockpit);
    for (const cell of cells) {
      log(`capturing ${cell.name}`);
      await CAPTURE[cell.name](browser, cell, cockpit, seeded);
      await shoot(browser, cell, shots);
    }
  } finally {
    browser?.close();
    await cockpit.stop();
  }
}

/** Run the whole capture into `<work>/shots`, then copy the images to `options.out`. */
async function capture(options, { browserBin, work, log }) {
  const home = join(work, 'home');
  const gitConfig = join(work, 'gitconfig');
  mkdirSync(home, { recursive: true });
  writeFileSync(gitConfig, '');
  // Both boots run the demo agent as Claude: the GitHub boot runs no task, and an accidental
  // start there still spends no tokens.
  const agent = writeAgentLauncher(work);
  const env = (extra) => serverEnv(process.env, { home, gitConfig, extra: { CEZ_HOME: join(work, 'cez-home'), CEZ_CLAUDE_BIN: agent, ...extra } });
  // Under the scratch HOME, as a developer's checkouts are; the header shows `…ome/code/cezarion`.
  const repos = createDemoRepos({ source: REPO_ROOT, root: home, env: env({}) });
  const shots = join(work, 'shots');
  mkdirSync(shots);
  const common = { work, browserBin, shots, log, repo: repos.cezarion };
  // GitHub first: that boot runs without dry run, so it must find no task to recover.
  const github = options.cells.filter((cell) => cell.boot === 'github');
  if (github.length) await captureBoot({ ...common, name: 'github', cells: github, env: env({ GH_CONFIG_DIR: ghConfigDir() }), prepare: async () => ({}) });
  const demo = options.cells.filter((cell) => cell.boot === 'demo');
  if (demo.length) await captureBoot({ ...common, name: 'demo', cells: demo, env: env({ CEZ_DRY_RUN: '1' }), prepare: (cockpit) => seedDemo(cockpit, repos, log) });
  mkdirSync(options.out, { recursive: true });
  for (const cell of options.cells) copyFileSync(join(shots, `${cell.name}.png`), join(options.out, `${cell.name}.png`));
}

/** The base for the work directory: short, and outside every checkout, as the header shows it. */
function scratchBase() {
  return process.platform === 'win32' ? tmpdir() : realpathSync('/tmp');
}

export async function main(argv = process.argv.slice(2), log = (line) => process.stderr.write(`${line}\n`)) {
  const options = parseOptions(argv);
  if (options.help) return void process.stdout.write(USAGE);
  const browserBin = findAgentBrowser();
  const missing = missingPrerequisites({ cells: options.cells, browser: browserBin, ghLoggedIn });
  if (missing.length) throw new Error(missing.join('\n'));
  const work = mkdtempSync(join(scratchBase(), 'cez-readme-'));
  const removeWork = () => (options.keep ? log(`kept ${work}`) : rmSync(work, { recursive: true, force: true }));
  // The cockpits run in their own process groups, so a Ctrl-C reaches only this process.
  const onSignal = async (signal) => {
    log(`${signal}: stopping`);
    for (const resource of [...open]) await (resource.stop?.() ?? resource.close());
    removeWork();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await capture(options, { browserBin, work, log });
    log(`wrote ${options.cells.map((cell) => `${cell.name}.png`).join(', ')} to ${options.out}`);
  } finally {
    removeWork();
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => {
    process.stderr.write(`capture-readme-screenshots: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = process.exitCode || 1;
  });
}
