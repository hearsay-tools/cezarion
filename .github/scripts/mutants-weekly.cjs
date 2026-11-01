#!/usr/bin/env node
'use strict';
// The weekly whole-file mutation run (hearsay-tools/cezarion#2398). `plan` picks the files on main;
// `publish` reads each file's result, keeps one rolling issue per file that misses a target and writes
// the run summary. Advisory: nothing here changes a required check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs, compareResults } = require('./mutants-file.cjs');
const TARGETS = require('../mutants/targets.json');

const CAP = 64;
const RESULT_VERSION = 2;
const PLAN_VERSION = 1;
const WORKFLOW_FILE = 'mutants-weekly.yml';
const RESULTS_ARTIFACT = 'mutants-weekly-results';
const MAX_RESULT_BYTES = 256 * 1024 * 1024;
const MAX_BODY = 60_000;
const GITHUB_BODY_LIMIT = 65_536;
const EARLIER_RUNS = 30;
const NOTE = '<!-- cez-mutants-weekly:not-measured -->';
const MARKER = /<!-- cez-mutants-weekly:v1:(\S+) -->/;
const AREA = { cezar: 'area-cezar', web: 'area-web', contract: 'area-contract', 'api-client': 'area-api-client' };
const NO_RESULT = 'no result: the job timed out, failed or was cancelled';

const marker = file => `<!-- cez-mutants-weekly:v1:${file} -->`;
const short = sha => String(sha).slice(0, 7);
const signed = n => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
const flat = text => String(text).replace(/\s+/g, ' ').trim().replace(/`/g, "'").slice(0, 120);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function productFile(file) {
  if (/\.(?:test|e2e|testkit)\.|\.d\.ts$/.test(file)) return false;
  try {
    parseArgs([file]);
    return true;
  } catch {
    return false;
  }
}

function artifactName(file) {
  const hash = crypto.createHash('sha256').update(file).digest('hex').slice(0, 8);
  return `mutants-weekly-file-${file.replace(/[^\w.-]/g, '_').slice(0, 150)}-${hash}`;
}

function parseNumstat(text) {
  const changed = new Map();
  for (const line of text.split('\n')) {
    const row = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (row) changed.set(row[3], (changed.get(row[3]) ?? 0) + (Number(row[1]) || 0) + (Number(row[2]) || 0));
  }
  return changed;
}

function selectFiles({ targets, changed, tracked, cap = CAP }) {
  const skipped = [];
  const listed = [];
  for (const file of targets) {
    if (!tracked.has(file)) skipped.push({ file, reason: 'not at head' });
    else if (!productFile(file)) skipped.push({ file, reason: 'not a measurable product file' });
    else listed.push({ file, reason: 'target', lines: changed.get(file) ?? 0 });
  }
  const recent = [...changed]
    .filter(([file, lines]) => lines > 0 && !targets.includes(file) && tracked.has(file) && productFile(file))
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([file, lines]) => ({ file, reason: 'changed', lines }));
  const all = [...listed, ...recent].map(item => ({ ...item, artifact: artifactName(item.file) }));
  return { selected: all.slice(0, cap), cut: all.slice(cap), skipped };
}

function plan({ git, now = new Date(), targets = Object.keys(TARGETS), cap = CAP }) {
  const head = git(['rev-parse', 'HEAD']).trim();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const tracked = new Set(git(['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean));
  const changed = parseNumstat(git(['log', '--no-renames', '--numstat', '--format=', `--since=${since}`, head, '--', 'packages']));
  return { version: PLAN_VERSION, head, since, cap, ...selectFiles({ targets, changed, tracked, cap }) };
}

function cliDeps() {
  return {
    git: args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    now: () => new Date(),
    env: process.env,
    log: line => console.log(line),
  };
}

function cli(argv, deps = cliDeps()) {
  const [command, flag, out = 'mutants-weekly-plan'] = argv;
  if (command !== 'plan' || !(argv.length === 1 || (argv.length === 3 && flag === '--out'))) throw new Error('Usage: mutants-weekly.cjs plan [--out <dir>]');
  const result = plan({ git: deps.git, now: deps.now() });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify(result, null, 2)}\n`);
  const matrix = { include: result.selected.map(({ file, artifact }) => ({ file, artifact })) };
  if (deps.env.GITHUB_OUTPUT) fs.appendFileSync(deps.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nhead=${result.head}\ncount=${result.selected.length}\n`);
  deps.log(`Selected ${result.selected.length} files at ${result.head}; ${result.cut.length} over the weekly cap, ${result.skipped.length} skipped.`);
  return result;
}

function shapeIssue(result) {
  const lists = ['survivors', 'guards', 'staleEquivalent', 'ambiguousEquivalent'];
  if (!Array.isArray(result.targets) || !result.targets.every(t => typeof t?.name === 'string' && typeof t.pass === 'boolean')) return true;
  return lists.some(key => !Array.isArray(result[key])) || typeof result.score !== 'number';
}

function readResult(dir, entry, head) {
  const file = path.join(dir, entry.artifact, 'result.json');
  let result;
  try {
    if (fs.statSync(file).size > MAX_RESULT_BYTES) return { reason: 'result too large' };
    result = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { reason: error.code === 'ENOENT' ? NO_RESULT : 'unreadable result' };
  }
  if (result?.version !== RESULT_VERSION) return { reason: `result version ${result?.version}, expected ${RESULT_VERSION}` };
  if (result.file !== entry.file) return { reason: 'the result is for another file' };
  if (result.head !== head) return { reason: 'the result is for another head' };
  if (shapeIssue(result)) return { reason: 'the result has an unexpected shape' };
  return { result };
}

function classify(entry, { result, reason }) {
  const base = { file: entry.file, entryReason: entry.reason };
  if (!result) return { ...base, state: 'not-measured', reason };
  const failures = result.targets.filter(t => !t.pass).map(t => t.name);
  if (result.consumers?.state === 'failed') failures.push(`consumer tests: failed — ${result.consumers.reason}`);
  return { ...base, state: failures.length ? 'missed' : 'passed', result, failures };
}

function comparison(earlier, result) {
  if (!earlier) return { kind: 'none' };
  if (earlier.version !== result.version) return { kind: 'incomparable', version: earlier.version };
  try {
    return { kind: 'compared', head: earlier.head, change: compareResults(earlier, result) };
  } catch (error) {
    return { kind: 'incomparable', reason: flat(error.message) };
  }
}

const survivorLine = m => `L${m.line} ${m.kind} / ${m.mutator}${m.function ? ` in \`${flat(m.function)}\`` : ''}: \`${flat(m.original)}\` -> \`${flat(m.replacement)}\``;
const entryLine = e => `\`${flat(e.function)}\` ${e.mutator}: \`${flat(e.original)}\` -> \`${flat(e.replacement)}\``;
function capped(items, cap, line, indent = '') {
  const shown = items.slice(0, cap).map(item => `${indent}- ${line(item)}`);
  if (items.length > cap) shown.push(`${indent}- … and ${items.length - cap} more`);
  return shown;
}

function changeSection(earlier, cap) {
  if (earlier.kind === 'none') return ['No earlier result.'];
  if (earlier.kind === 'incomparable') return [`No comparable earlier result: ${earlier.reason ?? `it has result version ${earlier.version}, this run has version ${RESULT_VERSION}`}.`];
  const { change } = earlier;
  const counts = Object.entries(change.counts).filter(([, n]) => n !== 0).map(([key, n]) => `${key} ${n > 0 ? '+' : ''}${n}`).join(', ') || 'no change';
  return [`Earlier result at \`${short(earlier.head)}\`: counted score ${signed(change.score)} points, raw score ${signed(change.rawScore)} points. Counts: ${counts}.`,
    '', `${plural(change.added.length, 'new survivor')}:`, ...capped(change.added, cap, survivorLine),
    '', `${plural(change.removed.length, 'survivor')} gone since then.`];
}

function guardSection(result, cap) {
  const lines = result.guards.flatMap(g => !g.found ? [`- \`${flat(g.name)}\`: not found in the file`]
    : g.survivors?.length ? [`- \`${flat(g.name)}\`: ${g.survivors.length} undetected`, ...capped(g.survivors, cap, survivorLine, '  ')] : []);
  return lines.length ? lines : ['None.'];
}

function equivalentSection(result, cap) {
  const groups = [['Stale (matches no mutant)', result.staleEquivalent], ['Ambiguous (the function name repeats)', result.ambiguousEquivalent],
    ...(result.multipleEquivalent ?? []).map(e => [`Matches more than one mutant (${e.matchCount})`, [e]])];
  const lines = groups.filter(([, items]) => items.length).flatMap(([title, items]) => [`- ${title}:`, ...capped(items, cap, entryLine, '  ')]);
  return lines.length ? lines : ['None.'];
}

function issueText({ outcome, earlier, head, runUrl }, cap) {
  const { file, result } = outcome;
  return [marker(file),
    `\`${file}\` misses a target from \`.github/mutants/targets.json\` in the weekly whole-file mutation run.`, '',
    `- File: \`${file}\``, `- Head: \`${head}\``, `- Run: ${runUrl}`, `- Tier: ${result.tier}, counted score ${result.score.toFixed(1)}%`, '',
    '### Targets', '', ...result.targets.map(t => `- ${t.pass ? 'PASS' : 'FAIL'}: ${t.name}`),
    ...(result.consumers?.state === 'failed' ? [`- FAIL: consumer tests: failed — ${flat(result.consumers.reason)}`] : []), '',
    '### Change against the earlier result', '', ...changeSection(earlier, cap), '',
    '### Guard survivors', '', ...guardSection(result, cap), '',
    '### Equivalent list entries', '', ...equivalentSection(result, cap), '',
    '### Fixing it', '',
    `Run \`node .github/scripts/mutants-file.cjs ${file}\` as \`docs/sdlc/regression-proof.md\` says, cite its PASS lines in the pull request and write \`Fixes #<this issue>\`. The weekly run closes this issue when every target passes.`,
    ''].join('\n');
}

function renderIssue(input) {
  for (const cap of [30, 10, 3, 0]) {
    const body = issueText(input, cap);
    if (body.length <= MAX_BODY) return body;
  }
  const notice = '\n\n… cut to fit the issue body. The run artifact holds the full result.\n';
  return issueText(input, 0).slice(0, MAX_BODY - notice.length) + notice;
}

function withNote(body, { date, head, runUrl, reason }) {
  const kept = body.includes(NOTE) ? body.slice(0, body.indexOf(NOTE)).trimEnd() : body.trimEnd();
  const note = `\n\n${NOTE}\n### Not measured this week\n\nThe run on ${date} at \`${short(head)}\` did not measure this file: ${flat(reason)}. [Run](${runUrl}). The result above is from an earlier run.\n`;
  return kept.slice(0, GITHUB_BODY_LIMIT - note.length) + note;
}

async function findIssues({ github, owner, repo }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const byFile = new Map();
  for (const issue of issues.filter(i => !i.pull_request).sort((a, b) => a.number - b.number)) {
    const file = MARKER.exec(issue.body ?? '')?.[1];
    if (file && !byFile.has(file)) byFile.set(file, issue);
  }
  return byFile;
}

async function closeIssue({ github, owner, repo, issue, body, reason }) {
  await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body });
  await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'closed', state_reason: reason });
}

async function syncOne({ github, owner, repo, issue, outcome, earlier, head, runUrl, date }) {
  const { file, state } = outcome;
  const open = issue?.state === 'open';
  if (state === 'passed') {
    if (!open) return null;
    await closeIssue({ github, owner, repo, issue, reason: 'completed', body: `Every target passes at \`${short(head)}\` in the [weekly mutation run](${runUrl}). Closing.` });
    return 'closed';
  }
  if (state === 'not-measured') {
    if (!open) return null;
    await github.rest.issues.update({ owner, repo, issue_number: issue.number, body: withNote(issue.body ?? '', { date, head, runUrl, reason: outcome.reason }) });
    return 'noted';
  }
  const body = renderIssue({ outcome, earlier: comparison(earlier.get(file), outcome.result), head, runUrl });
  if (issue) {
    await github.rest.issues.update({ owner, repo, issue_number: issue.number, body, state: 'open' });
    return open ? 'updated' : 'reopened';
  }
  const labels = ['code-quality-improvement', AREA[file.split('/')[1]]].filter(Boolean);
  const created = await github.rest.issues.create({ owner, repo, title: `Mutation targets missed: ${file}`, body, labels });
  return { action: 'created', number: created.data.number };
}

async function syncIssues({ github, owner, repo, outcomes, earlier, head, runUrl, exists, date }) {
  const issues = await findIssues({ github, owner, repo });
  const actions = [];
  for (const outcome of outcomes) {
    const issue = issues.get(outcome.file);
    const done = await syncOne({ github, owner, repo, issue, outcome, earlier, head, runUrl, date });
    if (typeof done === 'string') actions.push({ file: outcome.file, action: done, number: issue.number });
    else if (done) actions.push({ file: outcome.file, ...done });
  }
  for (const [file, issue] of issues) {
    if (issue.state !== 'open' || exists(file)) continue;
    await closeIssue({ github, owner, repo, issue, reason: 'not_planned', body: `\`${file}\` no longer exists at \`${short(head)}\` ([weekly mutation run](${runUrl})). Closing.` });
    actions.push({ file, action: 'closed-deleted', number: issue.number });
  }
  return actions;
}

function unzipResults(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-weekly-'));
  try {
    const zip = path.join(dir, 'results.zip');
    fs.writeFileSync(zip, Buffer.from(data));
    return JSON.parse(execFileSync('unzip', ['-p', zip, 'results.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function findEarlier({ github, owner, repo, runId, files, readArchive = unzipResults, warn }) {
  const found = new Map();
  if (files.length === 0) return found;
  const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: WORKFLOW_FILE, per_page: EARLIER_RUNS });
  const runs = data.workflow_runs.filter(run => run.id < runId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const run of runs) {
    if (files.every(file => found.has(file))) break;
    const { data: listed } = await github.rest.actions.listWorkflowRunArtifacts({ owner, repo, run_id: run.id, name: RESULTS_ARTIFACT });
    const artifact = listed.artifacts.find(a => a.name === RESULTS_ARTIFACT && !a.expired);
    if (!artifact) continue;
    try {
      const { data: archive } = await github.rest.actions.downloadArtifact({ owner, repo, artifact_id: artifact.id, archive_format: 'zip' });
      const { results } = readArchive(archive);
      for (const file of files) if (!found.has(file) && results?.[file]) found.set(file, results[file]);
    } catch (error) {
      warn(`Earlier results of run ${run.id} unreadable: ${error.message}`);
    }
  }
  return found;
}

function renderSummary({ plan: chosen, outcomes, actions }) {
  const issueOf = file => actions.find(a => a.file === file)?.number;
  const of = state => outcomes.filter(o => o.state === state);
  const [passed, missed, notMeasured] = ['passed', 'missed', 'not-measured'].map(of);
  const section = (title, lines) => lines.length ? [`### ${title}`, '', ...lines, ''] : [];
  return [`## Weekly mutation targets`, '',
    `Head \`${chosen.head}\`: ${passed.length + missed.length} measured, ${missed.length} missed, ${notMeasured.length} not measured, ${chosen.cut.length} over the weekly cap.`, '',
    ...section('Missed', missed.map(o => `- \`${o.file}\`${issueOf(o.file) ? ` (#${issueOf(o.file)})` : ''}: ${o.failures.map(name => `FAIL: ${name}`).join('; ')}`)),
    ...section('Passed', passed.map(o => `- \`${o.file}\``)),
    ...section('Not measured', notMeasured.map(o => `- \`${o.file}\`: ${o.reason}`)),
    ...section('Not measured: over the weekly cap', chosen.cut.map(e => `- \`${e.file}\` (${e.lines} changed lines)`)),
    ...section('Skipped', chosen.skipped.map(e => `- \`${e.file}\`: ${e.reason}`)),
    ...section('Issues closed: file deleted', actions.filter(a => a.action === 'closed-deleted').map(a => `- #${a.number} \`${a.file}\``)),
  ].join('\n');
}

function readPlan(dir) {
  const chosen = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const valid = chosen?.version === PLAN_VERSION && /^[0-9a-f]{40}$/.test(chosen.head) && Array.isArray(chosen.cut) && Array.isArray(chosen.skipped)
    && Array.isArray(chosen.selected) && chosen.selected.every(e => productFile(e.file) && e.artifact === artifactName(e.file));
  if (!valid) throw new Error('The plan artifact has an unexpected shape');
  return chosen;
}

async function publish({ github, context, core, planDir, filesDir, outDir, root = process.cwd(), exists, readArchive, now = new Date() }) {
  const { owner, repo } = context.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  let chosen;
  try {
    chosen = readPlan(planDir);
  } catch (error) {
    throw new Error(`Cannot read the plan: ${error.message}`);
  }
  const outcomes = chosen.selected.map(entry => classify(entry, readResult(filesDir, entry, chosen.head)));
  const results = Object.fromEntries(outcomes.filter(o => o.result).map(o => [o.file, o.result]));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ version: 1, head: chosen.head, runId: context.runId, runUrl, results }));
  const missed = outcomes.filter(o => o.state === 'missed').map(o => o.file);
  const earlier = await findEarlier({ github, owner, repo, runId: context.runId, files: missed, readArchive, warn: core.warning });
  const actions = await syncIssues({ github, owner, repo, outcomes, earlier, head: chosen.head, runUrl,
    exists: exists ?? (file => fs.existsSync(path.join(root, file))), date: now.toISOString().slice(0, 10) });
  await core.summary.addRaw(renderSummary({ plan: chosen, outcomes, actions })).write();
  return { outcomes, actions };
}

module.exports = { CAP, MAX_BODY, RESULTS_ARTIFACT, WORKFLOW_FILE, marker, productFile, artifactName, parseNumstat, selectFiles, plan, cli, cliDeps, readResult,
  classify, comparison, renderIssue, withNote, findIssues, syncIssues, findEarlier, unzipResults, renderSummary, readPlan, publish };
if (require.main === module) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
