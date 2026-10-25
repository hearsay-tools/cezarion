// What the README screenshot command shows (hearsay-tools/cezarion#1456): the gallery cells,
// the seeded tasks and the scripted agent turn each task plays. Data and pure helpers only, so
// scripts/readme-screenshots.test.mjs can check every visible string without a cockpit.

/** CSS px and device scale for every cell. The task view is wider, so its toolbar keeps one row
 *  and every resource column fits. */
export const VIEWPORT = Object.freeze({ width: 1600, height: 1000, scale: 2 });

/**
 * The four cells the README gallery links, in capture order. `boot` names the cockpit the cell
 * needs: the GitHub tab reads real public data, so it comes from a boot without dry run.
 */
export const CELLS = Object.freeze([
  { name: 'github-issues', boot: 'github', width: 1600 },
  { name: 'task-view', boot: 'demo', width: 1920 },
  { name: 'live-run', boot: 'demo', width: 1600 },
  { name: 'workflow-builder', boot: 'demo', width: 1600 },
]);

/** The GitHub repository the demo checkout's `origin` names, so the GitHub cell shows its issues. */
export const GITHUB_REPO = 'hearsay-tools/cezarion';

/**
 * Text that gives a dry run away. The capture refuses a page whose visible text matches one,
 * because AC 3 of #1456 forbids it in a gallery image: the bundled mock's scenario tokens, the
 * dry-run wording, and the dry-run GitHub catalog and pull request URL.
 */
const GIVEAWAYS = [/mock:/i, /dry[- ]run/i, /mock\/repo/i, /open-mercato\/demo/i];

/** The first giveaway in `text`, or null when the text is clean. */
export function findMockText(text) {
  for (const pattern of GIVEAWAYS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * One agent turn per task, keyed by a phrase of its task text. `end` is how the turn ends:
 * `done`, `fail` (the step fails), `ask` (the task needs you) or `live` (the turn stays in its
 * last test run until the session closes, so the task is still running when it is captured).
 */
export const SCENARIOS = Object.freeze([
  { key: 'bearer tokens', file: 'packages/cezar/src/core/secret-redaction.ts', read: 'packages/cezar/src/runs/store.ts', test: 'packages/cezar/src/core/secret-redaction-bearer.test.ts', add: 87, del: 6, tokens: 96_500, cost: 0.83, end: 'done' },
  { key: 'fuzzy-match', file: 'packages/web/src/components/command-palette.tsx', read: 'packages/web/src/components/command-palette.tsx', test: 'packages/web/src/components/command-palette-fuzzy.test.tsx', add: 64, del: 21, tokens: 71_200, cost: 0.62, end: 'done' },
  { key: 'SSE reconnects', file: 'packages/web/src/api/global-events.tsx', read: 'packages/web/src/api/global-events.tsx', test: 'packages/web/src/api/global-events-backoff.test.tsx', add: 46, del: 9, tokens: 31_700, cost: 0.27, end: 'live' },
  { key: '--json', file: 'packages/cezar/src/task-cli/cli.ts', read: 'packages/cezar/src/task-cli/cli.ts', test: 'packages/cezar/test/e2e/task-cli-json.test.ts', add: 118, del: 14, tokens: 48_300, cost: 0.41, end: 'live' },
  { key: 'diff view', file: 'packages/web/src/components/diff/diff-view.tsx', read: 'packages/web/src/components/diff/diff.tsx', test: 'packages/web/src/components/diff/diff-stream.test.tsx', add: 203, del: 88, tokens: 134_800, cost: 1.12, end: 'done' },
  { key: 'base branch has moved', file: 'packages/cezar/src/git-worktree.ts', read: 'packages/cezar/src/git-worktree.ts', test: 'packages/cezar/src/git-worktree-base-moved.test.ts', add: 71, del: 9, tokens: 62_400, cost: 0.53, end: 'done' },
  { key: 'per-step cost', file: 'packages/web/src/routes/task-thread/activity-summary.tsx', read: 'packages/web/src/routes/task-thread/activity-summary.tsx', test: 'packages/web/src/routes/task-thread/activity-summary-cost.test.tsx', add: 52, del: 17, tokens: 44_100, cost: 0.38, end: 'done' },
  { key: 'Node 26', file: 'packages/cezar/src/core/node-version.ts', read: 'package.json', test: 'packages/cezar/test/unit/node-version.test.ts', add: 12, del: 4, tokens: 22_800, cost: 0.19, end: 'ask' },
  { key: 'heartbeat', file: 'packages/cezar/src/workflows/heartbeat.ts', read: 'packages/cezar/src/workflows/run.ts', test: 'packages/cezar/src/workflows/heartbeat.test.ts', add: 28, del: 11, tokens: 73_600, cost: 0.61, end: 'fail' },
  { key: 'peak memory', file: 'packages/web/src/routes/tasks-overview.tsx', read: 'packages/cezar/src/core/process-usage.ts', test: 'packages/web/src/routes/tasks-overview-memory.test.tsx', add: 61, del: 8, tokens: 39_700, cost: 0.33, end: 'done' },
  { key: 'agent CLIs', file: 'packages/cezar/src/core/backend-detect.ts', read: 'packages/cezar/src/core/backend-detect.ts', test: 'packages/cezar/src/core/backend-detect-versions.test.ts', add: 83, del: 22, tokens: 57_100, cost: 0.48, end: 'done' },
  { key: 'across page reloads', file: 'src/cart/store.ts', read: 'src/cart/store.ts', test: 'src/cart/store.test.ts', add: 58, del: 7, tokens: 41_900, cost: 0.36, end: 'done' },
  { key: 'currency switcher', file: 'src/components/header.tsx', read: 'src/components/header.tsx', test: 'src/components/header.test.tsx', add: 72, del: 12, tokens: 52_300, cost: 0.44, end: 'done' },
]);

const FALLBACK = Object.freeze({ key: 'change', file: 'src/change.ts', read: 'README.md', test: 'src/change.test.ts', add: 34, del: 5, tokens: 28_000, cost: 0.24, end: 'done' });

/** The scenario whose key the task text contains, or a plain finished change. */
export function pickScenario(text) {
  return SCENARIOS.find((scenario) => text.includes(scenario.key)) ?? FALLBACK;
}

/**
 * The seeded tasks. `phase` orders them: the `batch` tasks run to their end first; then the
 * `live` tasks take both default `maxParallel` slots, so the `queued` tasks wait behind them.
 * `pr` opens a dry-run draft pull request once the batch is idle.
 */
export const SEED_TASKS = Object.freeze([
  { phase: 'batch', project: 'cezarion', workflow: 'fix-and-verify', task: 'Probe installed agent CLIs on startup and show their versions in the Tools menu' },
  { phase: 'batch', project: 'cezarion', workflow: 'fix-and-verify', task: 'Show peak memory per run in the task table' },
  { phase: 'batch', project: 'cezarion', workflow: 'fix-and-verify', task: 'Fix the heartbeat flake in the workflow runner' },
  { phase: 'batch', project: 'cezarion', workflow: 'quick-task', task: 'Add per-step cost to the run summary' },
  { phase: 'batch', project: 'cezarion', workflow: 'fix-and-verify', task: 'Warn when the base branch has moved under a worktree', pr: true },
  { phase: 'batch', project: 'cezarion', workflow: 'fix-and-verify', task: 'Stream the diff view instead of buffering it', pr: true },
  { phase: 'batch', project: 'storefront', workflow: 'quick-task', task: 'Persist the cart across page reloads' },
  { phase: 'batch', project: 'storefront', workflow: 'quick-task', task: 'Add a currency switcher to the header' },
  { phase: 'batch', project: 'cezarion', workflow: 'quick-task', task: 'Upgrade to Node 26 and refresh the engines field' },
  { phase: 'batch', project: 'cezarion', workflow: 'fix-and-verify', task: 'Scrub bearer tokens out of NDJSON tool results before they hit disk' },
  { phase: 'batch', project: 'cezarion', workflow: 'quick-task', task: 'Make the command palette fuzzy-match task titles' },
  { phase: 'live', project: 'cezarion', workflow: 'fix-and-verify', task: 'Back off SSE reconnects: the cockpit hammered the events endpoint after a sleep' },
  { phase: 'live', project: 'cezarion', workflow: 'quick-task', task: 'Add --json output to cez export, with a snapshot test' },
  { phase: 'queued', project: 'cezarion', workflow: 'quick-task', task: 'Cache the GitHub issue list for 60 seconds' },
  { phase: 'queued', project: 'cezarion', workflow: 'fix-and-verify', task: 'Document the Autonomous flag in the README' },
  { phase: 'queued', project: 'cezarion', workflow: 'quick-task', task: 'Upgrade Tailwind to v4.2 and drop the container shim' },
]);

/** The task the live-run cell opens. */
export const LIVE_RUN_TASK = SEED_TASKS.find((seed) => seed.phase === 'live').task;

/** A name from the scenario key, for the identifiers the edit writes. */
function identifier(key) {
  const words = key.replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/);
  return words.map((word, i) => (i ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase())).join('');
}

/**
 * The file text after the scenario's edit: `add` new lines at line 40 (or the end), replacing
 * up to `del` lines after it. The diff counts in the cockpit come from this real change.
 */
export function editedText(original, scenario) {
  const lines = original === '' ? [] : original.replace(/\n$/, '').split('\n');
  const at = Math.min(lines.length, 40);
  const removed = Math.min(scenario.del, lines.length - at);
  const name = identifier(scenario.key);
  const added = Array.from({ length: scenario.add }, (_, i) =>
    i % 9 === 0 ? `// ${scenario.key}: step ${i / 9 + 1}` : `export const ${name}${i} = ${i};`);
  lines.splice(at, removed, ...added);
  return `${lines.join('\n')}\n`;
}

/** The regression test file the turn writes. */
export function testText(scenario) {
  return `import { describe, expect, it } from 'vitest';\n\ndescribe('${scenario.key}', () => {\n  it('covers the reported case', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
}

const ASK = {
  questions: [{
    header: 'Engines',
    question: 'Raise the engines floor to Node 26, or keep 24.21 and test both in CI?',
    options: [
      { label: 'Raise to 26', description: 'Drop 24.x from the support matrix' },
      { label: 'Keep 24.21', description: 'Add a Node 26 CI lane only' },
    ],
  }],
};

/** The closing step of a turn, by how the scenario ends. */
function ending(scenario) {
  if (scenario.end === 'fail') {
    return { say: 'The heartbeat test still fails after two attempts: the timer fires before the store write lands.', result: 'error' };
  }
  if (scenario.end === 'ask') {
    return { say: `The upgrade works on Node 26. One decision is yours before I finish.\n\nCEZ:ASK ${JSON.stringify(ASK)}`, result: 'success' };
  }
  return { say: `Done. \`${scenario.file}\` now covers ${scenario.key}; the new test was red before the fix and is green after it, and typecheck is clean.\n\nCEZ:DONE`, result: 'success' };
}

/**
 * The first turn of a task, as steps the demo agent plays in order. `say` is assistant text,
 * `tool` a tool call and its result after `ms`, `pause` a gap. A step with `write` or `edit`
 * changes the worktree; `hold` keeps a live turn inside that tool call.
 */
export function turnScript(scenario) {
  const live = scenario.end === 'live';
  return [
    { say: `I'll start by reading \`${scenario.read}\` to see how this works today, then write a failing test before I change anything.` },
    { pause: 900 },
    { tool: 'Read', input: { file_path: scenario.read }, result: `     1\t// ${scenario.read}\n     2\timport { z } from 'zod';\n     3\t…`, ms: 700 },
    { tool: 'Grep', input: { pattern: scenario.key.split(' ')[0], path: '.', output_mode: 'files_with_matches' }, result: `${scenario.read}\n${scenario.file}`, ms: 500 },
    { say: `The behaviour lives in \`${scenario.file}\`. Writing the regression test first.` },
    { pause: 800 },
    { tool: 'Write', input: { file_path: scenario.test, content: testText(scenario) }, result: `File created successfully at: ${scenario.test}`, ms: 500, write: true },
    { tool: 'Bash', input: { command: `npm test -- ${scenario.test}`, description: 'Run the new test' }, result: ` FAIL  ${scenario.test}\n  ✗ ${scenario.key} (12 ms)\n\n Test Files  1 failed (1)\n      Tests  1 failed (1)`, ms: 1500 },
    { say: 'Red as expected. Now the fix.' },
    { pause: 900 },
    { tool: 'Edit', input: { file_path: scenario.file, old_string: '…', new_string: '…' }, result: `The file ${scenario.file} has been updated.`, ms: 700, edit: true },
    { tool: 'Bash', input: { command: `npm test -- ${scenario.test}`, description: 'Re-run the test' }, result: ` ✓ ${scenario.test} (4 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)`, ms: 1500, hold: live },
    { tool: 'Bash', input: { command: 'npm run typecheck', description: 'Typecheck the workspaces' }, result: '> tsc --noEmit -p tsconfig.json\n(no errors)', ms: 1200 },
    ending(scenario),
  ];
}

/** The reply to every later message in a session: a follow-up or a nudge. */
export const FOLLOW_UP_REPLY = 'Applied your note and re-ran the focused tests: all green.\n\nCEZ:DONE';
