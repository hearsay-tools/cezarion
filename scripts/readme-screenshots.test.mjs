import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { findAgentBrowser, ghConfigDir, missingPrerequisites, parseOptions, REPO_ROOT, serverEnv, USAGE, waitUntil } from '../.ai/scripts/readme-screenshots/capture.mjs';
import { applyChange, controlResponse, HELP_TEXT, main, parseLine, playTurn, VERSION_TEXT } from '../.ai/scripts/readme-screenshots/demo-agent.mjs';
import { cezarFiles, createDemoRepos, DEMO_SKILLS, DEMO_WORKFLOWS, STOREFRONT_FILES } from '../.ai/scripts/readme-screenshots/demo-repos.mjs';
import { CELLS, editedText, findMockText, FOLLOW_UP_REPLY, GITHUB_REPO, LIVE_RUN_TASK, pickScenario, SCENARIOS, SEED_TASKS, testText, turnScript } from '../.ai/scripts/readme-screenshots/scenarios.mjs';

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** Play one turn in-process, recording what the agent emits. */
async function play(t, text, { first = true, closed = Promise.resolve() } = {}) {
  const cwd = scratch(t, 'cez-readme-turn-');
  const events = [];
  await playTurn({ text, first, cwd, emit: (event) => events.push(event), sleep: async () => {}, closed });
  return { cwd, events };
}

test('the cells are exactly the images the README gallery links', () => {
  const linked = new Set([...readFileSync(join(REPO_ROOT, 'README.md'), 'utf8').matchAll(/docs\/screenshots\/([a-z-]+)\.png/g)].map((match) => match[1]));
  assert.deepEqual(CELLS.map((cell) => cell.name).sort(), [...linked].sort());
  for (const cell of CELLS) assert.ok(existsSync(join(REPO_ROOT, 'docs/screenshots', `${cell.name}.png`)), cell.name);
});

test('findMockText names the dry-run giveaways and passes clean text', () => {
  assert.equal(findMockText('Fix it mock:done now'), 'mock:');
  assert.equal(findMockText('Applied (dry run).'), 'dry run');
  assert.equal(findMockText('a dry-run mock reply'), 'dry-run');
  assert.equal(findMockText('Issues · mock/repo'), 'mock/repo');
  assert.equal(findMockText('https://github.com/open-mercato/demo/pull/777'), 'open-mercato/demo');
  assert.equal(findMockText('Back off SSE reconnects after a sleep'), null);
});

test('every seeded task plays its own scenario, and nothing it shows gives the dry run away', () => {
  for (const seed of SEED_TASKS) {
    assert.equal(findMockText(seed.task), null, seed.task);
    const matching = SCENARIOS.filter((scenario) => seed.task.includes(scenario.key));
    assert.ok(matching.length <= 1, `${seed.task} matches ${matching.length} scenarios`);
    if (seed.phase !== 'queued') assert.equal(matching.length, 1, `${seed.task} has no scenario`);
    for (const step of turnScript(pickScenario(seed.task))) assert.equal(findMockText(JSON.stringify(step)), null, JSON.stringify(step));
  }
  assert.equal(findMockText(FOLLOW_UP_REPLY), null);
  assert.equal(pickScenario('Something unrelated').key, 'change');
  assert.equal(SEED_TASKS.filter((seed) => seed.phase === 'live').length, 2, 'two live tasks take both default slots');
  assert.equal(pickScenario(LIVE_RUN_TASK).end, 'live');
});

test('editedText adds and replaces the scenario counts, with no whitespace error', () => {
  const scenario = { key: 'base branch has moved', add: 12, del: 3 };
  const original = `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const lines = editedText(original, scenario).split('\n');
  assert.equal(lines.length - 1, 50 - 3 + 12);
  assert.equal(lines[39], 'line 39');
  assert.equal(lines[40], '// base branch has moved: step 1');
  assert.equal(lines[41], 'export const baseBranchHasMoved1 = 1;');
  assert.equal(lines[52], 'line 43');
  assert.ok(lines.every((line) => !/\s$/.test(line)));
  assert.equal(editedText('', { key: 'x', add: 2, del: 5 }), '// x: step 1\nexport const x1 = 1;\n');
  assert.match(testText(scenario), /describe\('base branch has moved'/);
});

test('a finished turn reads, writes a red test, edits, goes green and ends with CEZ:DONE', async (t) => {
  const task = 'Warn when the base branch has moved under a worktree';
  const scenario = pickScenario(task);
  const { cwd, events } = await play(t, task);
  const tools = events.flatMap((event) => event.type === 'assistant' ? event.message.content.filter((block) => block.type === 'tool_use') : []);
  assert.deepEqual(tools.map((tool) => tool.name), ['Read', 'Grep', 'Write', 'Bash', 'Edit', 'Bash', 'Bash']);
  const results = events.filter((event) => event.type === 'user').map((event) => event.message.content[0].tool_use_id);
  assert.deepEqual(results, tools.map((tool) => tool.id), 'every tool call gets its result');
  const result = events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.total_cost_usd, scenario.cost);
  assert.equal(result.usage.input_tokens + result.usage.output_tokens, scenario.tokens);
  assert.match(events.at(-2).message.content[0].text, /CEZ:DONE$/);
  assert.equal(readFileSync(join(cwd, scenario.test), 'utf8'), testText(scenario));
  assert.equal(readFileSync(join(cwd, scenario.file), 'utf8').split('\n').length - 1, scenario.add);
});

test('a failing turn ends with an error result, and an asking turn with a valid CEZ:ASK', async (t) => {
  const failed = (await play(t, 'Fix the heartbeat flake in the workflow runner')).events.at(-1);
  assert.equal(failed.subtype, 'error_during_execution');
  assert.equal(failed.is_error, true);
  const asked = (await play(t, 'Upgrade to Node 26 and refresh the engines field')).events;
  assert.equal(asked.at(-1).subtype, 'success');
  const text = asked.at(-2).message.content[0].text;
  const ask = JSON.parse(text.slice(text.indexOf('CEZ:ASK ') + 'CEZ:ASK '.length));
  assert.equal(ask.questions[0].options.length, 2);
});

test('a live turn stays in its test run until the session closes, then ends without a result', async (t) => {
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  const cwd = scratch(t, 'cez-readme-live-');
  const events = [];
  const turn = playTurn({ text: LIVE_RUN_TASK, first: true, cwd, emit: (event) => events.push(event), sleep: async () => {}, closed });
  await waitUntil(() => events.filter((event) => event.message?.content?.[0]?.name === 'Bash').length === 2, 'the held test run', 5_000, 10);
  const held = events.length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, held, 'nothing follows the held call while the session is open');
  close();
  await turn;
  assert.equal(events.length, held);
  assert.ok(!events.some((event) => event.type === 'result'));
});

test('a later message in the session gets the short finished reply', async (t) => {
  const { events } = await play(t, 'Please also update the docs', { first: false });
  assert.equal(events.length, 2);
  assert.equal(events[0].message.content[0].text, FOLLOW_UP_REPLY);
  assert.equal(events[1].type, 'result');
});

test('applyChange appends to a test file that exists rather than replacing it', (t) => {
  const cwd = scratch(t, 'cez-readme-apply-');
  const scenario = { key: 'k', file: 'a.ts', test: 'a.test.ts', add: 1, del: 0 };
  writeFileSync(join(cwd, 'a.test.ts'), 'existing();\n');
  applyChange({ write: true }, scenario, cwd);
  assert.equal(readFileSync(join(cwd, 'a.test.ts'), 'utf8'), `existing();\n\n${testText(scenario)}`);
  applyChange({ edit: true }, scenario, join(cwd, 'nested'));
  assert.equal(readFileSync(join(cwd, 'nested/a.ts'), 'utf8'), '// k: step 1\n');
});

test('parseLine reads user turns without their session context, and control requests', () => {
  const context = '<cezar-context id="handoff">\nGoal: x\n</cezar-context>\n\n---\n\nShow peak memory';
  assert.deepEqual(parseLine(JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: context }, { type: 'image' }] } })), { kind: 'user', text: 'Show peak memory', raw: context, uuid: 'u1' });
  assert.deepEqual(parseLine(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'list_models' } })), { kind: 'control', requestId: 'r1', subtype: 'list_models' });
  assert.equal(parseLine('not json'), null);
  assert.equal(parseLine(JSON.stringify({ type: 'keep_alive' })), null);
  assert.deepEqual(controlResponse({ requestId: 'r1', subtype: 'list_models' }).response.response.models.map((model) => model.value), ['opus', 'sonnet', 'haiku']);
  assert.deepEqual(controlResponse({ requestId: 'r2', subtype: 'interrupt' }).response, { subtype: 'success', request_id: 'r2', response: {} });
});

test('the agent CLI answers --help and --version, then speaks stream-json until stdin closes', async (t) => {
  const written = [];
  const io = (stdin) => ({ stdin, stdout: { write: (text) => written.push(text) }, cwd: scratch(t, 'cez-readme-cli-'), exit: () => {} });
  main(['--help'], io(new PassThrough()));
  main(['--version'], io(new PassThrough()));
  assert.deepEqual(written.splice(0), [HELP_TEXT, VERSION_TEXT]);
  const stdin = new PassThrough();
  let exited;
  const done = new Promise((resolve) => { exited = resolve; });
  main(['--replay-user-messages'], { ...io(stdin), exit: exited });
  stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'list_models' } })}\n`);
  stdin.write(`${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'Show peak memory per run in the task table' }] } })}\n`);
  stdin.end();
  // bound: the scripted turn's pauses add up to about 9 s at real speed.
  assert.equal(await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 30_000, 'timeout'))]), 0);
  const events = written.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events[0], { type: 'system', subtype: 'init' });
  assert.equal(events[1].type, 'control_response');
  assert.deepEqual(events[2], { type: 'user', isReplay: true, uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Show peak memory per run in the task table' }] } });
  assert.equal(events.at(-1).type, 'result');
});

test('createDemoRepos builds both projects on main, without the excluded paths', (t) => {
  const root = scratch(t, 'cez-readme-repos-');
  const source = join(root, 'source');
  mkdirSync(join(source, 'packages/app'), { recursive: true });
  mkdirSync(join(source, 'docs'), { recursive: true });
  mkdirSync(join(source, '.ai/qa'), { recursive: true });
  writeFileSync(join(source, 'packages/app/index.ts'), 'export {};\n');
  writeFileSync(join(source, 'docs/big.md'), 'docs\n');
  writeFileSync(join(source, '.ai/qa/note.md'), 'qa\n');
  writeFileSync(join(source, 'untracked.txt'), 'not committed\n');
  git(root, 'init', '-q', '-b', 'trunk', source);
  git(source, 'add', 'packages', 'docs', '.ai');
  git(source, 'commit', '-qm', 'fixture');
  const repos = createDemoRepos({ source, root: join(root, 'demo'), env: process.env });
  assert.equal(repos.cezarion, join(root, 'demo/code/cezarion'));
  assert.ok(existsSync(join(repos.cezarion, 'packages/app/index.ts')));
  for (const path of ['docs', '.ai/qa', 'untracked.txt']) assert.ok(!existsSync(join(repos.cezarion, path)), path);
  for (const repo of [repos.cezarion, repos.storefront]) {
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    for (const path of Object.keys(cezarFiles())) assert.ok(existsSync(join(repo, path)), path);
  }
  for (const path of Object.keys(STOREFRONT_FILES)) assert.ok(existsSync(join(repos.storefront, path)), path);
  assert.equal(git(repos.cezarion, 'remote', 'get-url', 'origin'), `https://github.com/${GITHUB_REPO}.git`);
  assert.equal(git(repos.storefront, 'remote'), '');
  assert.match(readFileSync(join(repos.cezarion, '.ai/cezar/skills/security-review.md'), 'utf8'), /^---\nname: security-review\ndescription: /);
  assert.ok(Object.keys(DEMO_WORKFLOWS).every((name) => !DEMO_WORKFLOWS[name].includes('skill:') || name === 'implement-and-review.yaml'));
  assert.ok(DEMO_SKILLS['security-review'] && DEMO_SKILLS.changelog, 'the builder workflow names skills that exist');
});

test('parseOptions defaults to every cell into docs/screenshots and refuses unknown input', () => {
  const all = parseOptions([], '/repo');
  assert.equal(all.out, '/repo/docs/screenshots');
  assert.deepEqual(all.cells, CELLS);
  assert.equal(all.keep, false);
  const some = parseOptions(['--only', 'live-run', '--only', 'task-view', '--out', 'shots', '--keep'], '/repo');
  assert.deepEqual(some.cells.map((cell) => cell.name), ['task-view', 'live-run']);
  assert.equal(some.out, '/repo/shots');
  assert.equal(some.keep, true);
  assert.equal(parseOptions(['--help']).help, true);
  assert.throws(() => parseOptions(['--only', 'variants-compare']), /unknown cell: variants-compare/);
  assert.throws(() => parseOptions(['--port', '1']), /Unknown option '--port'/);
  for (const cell of CELLS) assert.ok(USAGE.includes(cell.name));
});

test('findAgentBrowser prefers PATH, then the cached release', (t) => {
  const root = scratch(t, 'cez-readme-browser-');
  const bin = join(root, 'bin');
  const cache = join(root, 'cache/agent-tools/agent-browser');
  mkdirSync(bin);
  mkdirSync(cache, { recursive: true });
  assert.equal(findAgentBrowser({ PATH: bin, XDG_CACHE_HOME: join(root, 'cache') }), null);
  writeFileSync(join(cache, 'agent-browser-linux-x64'), '');
  assert.equal(findAgentBrowser({ PATH: bin, XDG_CACHE_HOME: join(root, 'cache') }), join(cache, 'agent-browser-linux-x64'));
  writeFileSync(join(bin, 'agent-browser'), '#!/bin/sh\n');
  chmodSync(join(bin, 'agent-browser'), 0o755);
  assert.equal(findAgentBrowser({ PATH: bin, XDG_CACHE_HOME: join(root, 'cache') }), join(bin, 'agent-browser'));
  assert.equal(findAgentBrowser({ HOME: join(root, 'nohome') }), null);
});

test('serverEnv drops the caller CEZ_* and GIT_* settings and pins HOME, Git and extras', () => {
  const env = serverEnv({ PATH: '/bin', HOME: '/home/me', CEZ_DRY_RUN: '1', cez_automations: '1', GIT_DIR: '/x', GH_TOKEN: 't' }, { home: '/w/home', gitConfig: '/w/gitconfig', extra: { CEZ_HOME: '/w/cez' } });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GH_TOKEN, 't');
  assert.equal(env.HOME, '/w/home');
  assert.equal(env.USERPROFILE, '/w/home');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/w/gitconfig');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.CEZ_HOME, '/w/cez');
  assert.equal(env.CEZ_PROJECT_WARMUP, '0');
  for (const key of ['CEZ_DRY_RUN', 'cez_automations', 'GIT_DIR']) assert.equal(env[key], undefined, key);
  assert.equal(ghConfigDir({ GH_CONFIG_DIR: '/gh' }), '/gh');
  assert.equal(ghConfigDir({ XDG_CONFIG_HOME: '/xdg' }), '/xdg/gh');
  assert.equal(ghConfigDir({ HOME: '/home/me' }), '/home/me/.config/gh');
});

test('missingPrerequisites names the build, the browser and a gh login only the GitHub cell needs', (t) => {
  const root = scratch(t, 'cez-readme-prereq-');
  const others = CELLS.filter((cell) => cell.boot !== 'github');
  assert.deepEqual(missingPrerequisites({ cells: CELLS, repoRoot: root, browser: null, ghLoggedIn: () => false }).map((reason) => reason.split(':')[0]), ['no build', 'agent-browser is not installed', 'gh is not logged in, and the github-issues cell reads GitHub through it']);
  mkdirSync(join(root, 'packages/cezar/dist'), { recursive: true });
  mkdirSync(join(root, 'packages/cezar/web/dist'), { recursive: true });
  writeFileSync(join(root, 'packages/cezar/dist/index.js'), '');
  writeFileSync(join(root, 'packages/cezar/web/dist/index.html'), '');
  assert.deepEqual(missingPrerequisites({ cells: others, repoRoot: root, browser: '/ab', ghLoggedIn: () => { throw new Error('not asked'); } }), []);
  assert.deepEqual(missingPrerequisites({ cells: CELLS, repoRoot: root, browser: '/ab', ghLoggedIn: () => true }), []);
});

test('waitUntil returns the first value and names what timed out', async () => {
  let calls = 0;
  assert.equal(await waitUntil(() => (++calls === 3 ? 'ready' : null), 'three calls', 5_000, 1), 'ready');
  await assert.rejects(waitUntil(() => null, 'nothing', 0, 1), /timed out after 0 s waiting for nothing/);
});
