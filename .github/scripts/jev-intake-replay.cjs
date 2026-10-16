'use strict';

// Offline replay of Jev issue intake over recent issues (#1163). It rebuilds
// the duplicate candidates each issue would have seen when it was opened,
// asks Jev once per issue, and scores the answers against the issue's current
// labels next to what the Codex intake actually returned for it.
//
//   node .github/scripts/jev-intake-replay.cjs fetch  --dir .ai/qa/1163 [--count 150]
//   node .github/scripts/jev-intake-replay.cjs ask    --dir .ai/qa/1163   (needs TYPESAFE_API_KEY)
//   node .github/scripts/jev-intake-replay.cjs report --dir .ai/qa/1163 --out <report.md>
//
// fetch and ask write only into --dir; keep it out of git (issue bodies).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildCandidates } = require('./issue-intake-candidates.cjs');
const { buildRequest, callJev, mapAnswers, askableLabels, THRESHOLDS, DEFAULT_MODEL } = require('./jev-issue-intake.cjs');

// Issues open when `target` was opened, as far as creation and close times
// tell. Titles and bodies are today's, which is the closest record we have.
function openAt(issues, target) {
  const at = target.created_at;
  return issues.filter((issue) => issue.number !== target.number
    && issue.created_at < at
    && (issue.closed_at === null || issue.closed_at > at));
}

function askableSet(labels) {
  const { areas, types, accessibility } = askableLabels(labels);
  return new Set([...areas, ...types, ...(accessibility ? [accessibility] : [])].map((label) => label.name));
}

// predictions and truths are arrays of label arrays, one entry per issue.
function scoreLabels(predictions, truths, labels) {
  const perLabel = Object.fromEntries(labels.map((label) => [label, { tp: 0, fp: 0, fn: 0 }]));
  let exact = 0;
  predictions.forEach((predicted, index) => {
    const want = new Set(truths[index].filter((label) => perLabel[label]));
    const got = new Set(predicted.filter((label) => perLabel[label]));
    for (const label of got) perLabel[label][want.has(label) ? 'tp' : 'fp'] += 1;
    for (const label of want) if (!got.has(label)) perLabel[label].fn += 1;
    if (want.size === got.size && [...want].every((label) => got.has(label))) exact += 1;
  });
  const sum = (key) => Object.values(perLabel).reduce((total, counts) => total + counts[key], 0);
  const tp = sum('tp');
  const fp = sum('fp');
  const fn = sum('fn');
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { perLabel, tp, fp, fn, precision, recall, f1, exact, total: predictions.length };
}

function args(argv) {
  const [command, ...rest] = argv;
  const options = { command, count: 150 };
  for (let i = 0; i < rest.length; i += 2) options[rest[i].replace(/^--/, '')] = rest[i + 1];
  options.count = Number(options.count);
  return options;
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: options.encoding ?? 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function ghPaginate(route, jq) {
  const out = gh(['api', '--paginate', route, '--jq', jq]);
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function targetsOf(corpus, count) {
  return [...corpus.issues].sort((a, b) => b.number - a.number).slice(0, count);
}

function fetchCorpus({ dir, count }) {
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const issues = ghPaginate(
    `repos/${repo}/issues?state=all&per_page=100`,
    '.[] | select(.pull_request == null) | {number,title,body,labels: [.labels[].name],created_at,closed_at,updated_at,state_reason}',
  ).map((issue) => ({ ...issue, body: issue.body ?? '' }));
  const labels = JSON.parse(gh(['label', 'list', '--limit', '100', '--json', 'name,description']));
  const corpus = { repo, fetchedAt: new Date().toISOString(), issues, labels };
  const targets = targetsOf(corpus, count);

  // The Codex baseline: the intake.json each issue's intake run uploaded.
  const runs = ghPaginate(
    `repos/${repo}/actions/workflows/issue-intake.yml/runs?per_page=100`,
    '.workflow_runs[] | {id,display_title,created_at,conclusion}',
  );
  const baseline = {};
  for (const target of targets) {
    const limit = new Date(Date.parse(target.created_at) + 15 * 60 * 1000).toISOString();
    const run = runs.find((candidate) => candidate.display_title === target.title
      && candidate.created_at >= target.created_at && candidate.created_at <= limit);
    if (!run) continue;
    const artifacts = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${run.id}/artifacts`])).artifacts
      .filter((artifact) => artifact.name === 'intake-output' && !artifact.expired);
    if (artifacts.length === 0) {
      baseline[target.number] = { run: run.id, conclusion: run.conclusion, intake: null };
      continue;
    }
    const zip = path.join(dir, `artifact-${artifacts[0].id}.zip`);
    fs.writeFileSync(zip, gh(['api', `repos/${repo}/actions/artifacts/${artifacts[0].id}/zip`], { encoding: 'buffer' }));
    const intake = JSON.parse(execFileSync('unzip', ['-p', zip, 'intake.json'], { encoding: 'utf8' }));
    fs.rmSync(zip);
    baseline[target.number] = { run: run.id, conclusion: run.conclusion, intake };
  }

  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'corpus.json'), corpus);
  writeJson(path.join(dir, 'baseline.json'), baseline);
  console.log(`${issues.length} issues, ${targets.length} targets, ${Object.keys(baseline).length} with a Codex run`);
}

function requestFor(corpus, target, model) {
  const candidates = buildCandidates({ issue: target, openIssues: openAt(corpus.issues, target), repo: corpus.repo });
  return buildRequest({ issue: target, candidates, labels: corpus.labels, model });
}

async function ask({ dir, count, model = DEFAULT_MODEL, concurrency = 4 }) {
  const corpus = readJson(path.join(dir, 'corpus.json'));
  const answersPath = path.join(dir, 'answers.json');
  const answers = readJson(answersPath, {});
  const pending = targetsOf(corpus, count).filter((target) => !answers[target.number]);
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const target = pending[next];
      next += 1;
      const request = requestFor(corpus, target, model);
      const started = Date.now();
      const response = await callJev({ request, apiKey: process.env.TYPESAFE_API_KEY });
      answers[target.number] = { model: response.model, ms: Date.now() - started, usage: response.usage, answers: response.answers };
      writeJson(answersPath, answers);
      console.log(`#${target.number} ${response.model} ${Date.now() - started}ms`);
    }
  }
  await Promise.all(Array.from({ length: Number(concurrency) }, worker));
}

function evaluate({ corpus, baseline, answers, targets, thresholds }) {
  const rows = [];
  for (const target of targets) {
    const cached = answers[target.number];
    if (!cached) continue;
    const request = requestFor(corpus, target, cached.model);
    const jev = mapAnswers({ request, response: cached, thresholds });
    const codex = baseline[target.number]?.intake ?? null;
    const top = cached.answers.duplicate;
    rows.push({
      target,
      jev,
      codex,
      candidateCount: Object.keys(request.questions.duplicate.criteria).length - 1,
      duplicatePick: top.choice === 'none' ? null : { number: Number(top.choice.slice(1)), p: top.probabilities[top.choice] },
    });
  }
  return rows;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function scoreTable(title, score, labels) {
  const lines = [
    `### ${title}`,
    '',
    `Micro precision ${pct(score.precision)}, recall ${pct(score.recall)}, F1 ${pct(score.f1)}; exact label set on ${score.exact}/${score.total} issues.`,
    '',
    '| Label | TP | FP | FN | Precision | Recall |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const label of labels) {
    const { tp, fp, fn } = score.perLabel[label];
    lines.push(`| \`${label}\` | ${tp} | ${fp} | ${fn} | ${tp + fp ? pct(tp / (tp + fp)) : '–'} | ${tp + fn ? pct(tp / (tp + fn)) : '–'} |`);
  }
  return lines.join('\n');
}

const SWEEP = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

function report({ dir, out, count }) {
  const corpus = readJson(path.join(dir, 'corpus.json'));
  const baseline = readJson(path.join(dir, 'baseline.json'), {});
  const answers = readJson(path.join(dir, 'answers.json'), {});
  const targets = targetsOf(corpus, count);
  const labels = [...askableSet(corpus.labels)];
  const rows = evaluate({ corpus, baseline, answers, targets, thresholds: THRESHOLDS });
  const truth = (row) => row.target.labels;
  const labelsOf = (intake) => (intake && intake.action === 'label' ? intake.labels : []);

  const jevAll = scoreLabels(rows.map((row) => labelsOf(row.jev)), rows.map(truth), labels);
  const paired = rows.filter((row) => row.codex);
  const jevPaired = scoreLabels(paired.map((row) => labelsOf(row.jev)), paired.map(truth), labels);
  const codexPaired = scoreLabels(paired.map((row) => labelsOf(row.codex)), paired.map(truth), labels);

  const sweepLines = ['| Threshold | ' + SWEEP.join(' | ') + ' |', '| --- |' + SWEEP.map(() => ' --- |').join('')];
  for (const key of ['mainArea', 'type', 'accessibility']) {
    const cells = SWEEP.map((value) => {
      const swept = evaluate({ corpus, baseline, answers, targets, thresholds: { ...THRESHOLDS, [key]: value } });
      const score = scoreLabels(swept.map((row) => labelsOf(row.jev)), swept.map(truth), labels);
      return `${pct(score.f1)} (${score.fp} FP)`;
    });
    sweepLines.push(`| \`${key}\` | ${cells.join(' | ')} |`);
  }

  const duplicateRows = rows
    .filter((row) => (row.duplicatePick && row.duplicatePick.p >= 0.5) || row.target.state_reason === 'duplicate' || row.codex?.action === 'duplicate')
    .map((row) => {
      const jevPick = row.duplicatePick ? `#${row.duplicatePick.number} (${row.duplicatePick.p.toFixed(2)})` : 'none';
      const codexPick = row.codex?.action === 'duplicate' ? `#${row.codex.duplicate_of}${row.codex.duplicate_of === row.target.number ? ' (itself)' : ''}` : '–';
      const closes = row.jev.action === 'duplicate' ? 'yes' : 'no';
      return `| #${row.target.number} | ${row.target.state_reason ?? 'open'} | ${codexPick} | ${jevPick} | ${closes} |`;
    });
  const selfPicks = paired.filter((row) => row.codex.action === 'duplicate' && row.codex.duplicate_of === row.target.number).length;
  const wrongCloses = rows.filter((row) => row.jev.action === 'duplicate' && row.target.state_reason !== 'duplicate');
  const duplicateSweep = [0.6, 0.7, 0.8, 0.9, 0.93, 0.95, 0.97].map((value) => {
    const picks = rows.filter((row) => row.duplicatePick && row.duplicatePick.p >= value);
    const right = picks.filter((row) => row.target.state_reason === 'duplicate').length;
    return `| ${value} | ${right} | ${picks.length - right} |`;
  });

  // Slices that do not lean on Codex's own output: areas only, type only where
  // the issue carries a type, and the issues Codex left unlabeled.
  const areas = labels.filter((label) => label.startsWith('area-'));
  const typeLabels = labels.filter((label) => ['bug', 'enhancement', 'documentation'].includes(label));
  const typed = paired.filter((row) => row.target.labels.some((label) => typeLabels.includes(label)));
  const slice = (subset, only, pick) => scoreLabels(subset.map((row) => labelsOf(pick(row))), subset.map(truth), only);
  const unlabeled = paired.filter((row) => labelsOf(row.codex).length === 0);
  const sliceLine = (name, subset, only) => {
    const jev = slice(subset, only, (row) => row.jev);
    const codex = slice(subset, only, (row) => row.codex);
    return `| ${name} | ${subset.length} | ${pct(codex.precision)} / ${pct(codex.recall)} / ${pct(codex.f1)} | ${pct(jev.precision)} / ${pct(jev.recall)} / ${pct(jev.f1)} |`;
  };
  const slices = [
    sliceLine('Areas only', paired, areas),
    sliceLine('Type, issues that carry a type label', typed, typeLabels),
    sliceLine('Every asked label, issues Codex left unlabeled', unlabeled, labels),
  ];
  const models = [...new Set(rows.map((row) => answers[row.target.number].model))];
  const ms = rows.map((row) => answers[row.target.number].ms).sort((a, b) => a - b);
  const tokens = rows.map((row) => answers[row.target.number].usage?.input_tokens ?? 0);

  const text = `# Jev issue-intake replay

Generated by \`node .github/scripts/jev-intake-replay.cjs report\` for hearsay-tools/cezarion#1163.
Corpus fetched ${corpus.fetchedAt} from ${corpus.repo}: the ${targets.length} newest issues (#${targets.at(-1).number}–#${targets[0].number}), ${rows.length} with a Jev answer. Model: ${models.join(', ')}.

## Method

- Each issue's duplicate candidates are the issues open when it was opened (created earlier, not closed by then), through the same filter the workflow uses: never the issue itself, never an issue it was split out of, never an epic. Titles and bodies are today's.
- The truth is each issue's current labels, limited to the labels intake asks about: ${labels.map((label) => `\`${label}\``).join(', ')}.
- The Codex baseline is the \`intake.json\` each issue's intake run uploaded (${paired.length} issues). The truth leans towards Codex: its labels stayed on the issue unless a person removed one, so it scores near 100% precision by construction, and an issue Codex left unlabeled usually has no type label either, so any type Jev gives it counts as wrong. The slices below take out the parts of that lean that can be taken out.
- Thresholds: ${Object.entries(THRESHOLDS).map(([key, value]) => `\`${key}\` ${value}`).join(', ')}.
- Latency: median ${ms[Math.floor(ms.length / 2)]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms. Input tokens: mean ${Math.round(tokens.reduce((a, b) => a + b, 0) / Math.max(tokens.length, 1))}, max ${Math.max(...tokens)}.

## Tuning

The first run asked the issue's full question set at duplicate 0.9, main area 0.5, type 0.5, secondary areas 0.8 and accessibility 0.7. Three changes followed:

- The per-area yes/no questions added 26 wrong area labels for 7 right ones, most of them \`area-docs\`. They are gone: an issue gets one area at most.
- Jev picked #902, the flaky-test epic, as the duplicate of its child #919 at 0.94. Epics are no longer candidates.
- Jev picked #958 for #963 at 0.93; #963 is follow-up work that names #958 as the change before it. The duplicate threshold is 0.95, above every pick that was not a duplicate.

A type threshold of 0.8 raised overall F1 by 0.4 points but cut recall on issues that carry a type label from 94.8% to 86.5%, so type stays at 0.5.

## Label agreement

${scoreTable(`Codex, the ${paired.length} issues with a Codex run`, codexPaired, labels)}

${scoreTable(`Jev, the same ${paired.length} issues`, jevPaired, labels)}

${scoreTable(`Jev, all ${rows.length} issues`, jevAll, labels)}

### Slices (precision / recall / F1)

| Slice | Issues | Codex | Jev |
| --- | --- | --- | --- |
${slices.join('\n')}

### Threshold sweep (Jev, all issues; micro F1 and false positives, one threshold varied at a time)

${sweepLines.join('\n')}

## Duplicates

Jev closes an issue only when its duplicate pick reaches ${THRESHOLDS.duplicate}. Wrong closes at that threshold: **${wrongCloses.length}**${wrongCloses.length ? ` (${wrongCloses.map((row) => `#${row.target.number}`).join(', ')})` : ''}.
Codex picked the issue itself on ${selfPicks} of ${paired.length} runs; each of those runs failed in \`apply-intake\` and left the issue unlabeled.

| Pick probability at least | Picks on issues closed as duplicates | Picks on other issues |
| --- | --- | --- |
${duplicateSweep.join('\n')}

Rows: every issue closed as a duplicate, every Codex duplicate pick, and every Jev pick at 0.5 or above.

| Issue | Closed as | Codex pick | Jev pick (probability) | Jev closes |
| --- | --- | --- | --- | --- |
${duplicateRows.join('\n') || '| – | – | – | – | – |'}
`;
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}: Jev F1 ${pct(jevPaired.f1)} vs Codex ${pct(codexPaired.f1)} on ${paired.length} paired issues; ${wrongCloses.length} wrong closes`);
}

if (require.main === module) {
  const options = args(process.argv.slice(2));
  const run = { fetch: fetchCorpus, ask, report }[options.command];
  if (!run || !options.dir) {
    console.error('usage: jev-intake-replay.cjs fetch|ask|report --dir <dir> [--count 150] [--out <report.md>] [--model <id>]');
    process.exit(2);
  }
  Promise.resolve(run(options)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { openAt, scoreLabels, askableSet };
