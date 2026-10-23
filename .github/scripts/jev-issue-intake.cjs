'use strict';

// Jev ranks prefetched candidates and answers bounded label questions without tools.
// Recheck top candidates with full bodies when needed. Emit intake.json;
// apply-issue-intake.cjs remains the mutation boundary.

const fs = require('node:fs');
const path = require('node:path');
const { validateIntake } = require('./apply-issue-intake.cjs');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Pinned: the thresholds below were tuned against this version, and
// jev-latest moves when a new release ships.
const DEFAULT_MODEL = 'jev-1.13.0';

// Labels other processes set. Intake never asks about them.
const NEVER_ASKED = new Set(['friction', 'upstream-port', 'epic', 'in-progress', 'needs-qa', 'repo-setup']);
const ACCESSIBILITY = 'accessibility';
const NONE = 'none';
// Code-owned option text: GitHub's one-line label descriptions left Jev no
// boundary for issues that are none of the three.
const TYPE_CRITERIA = Object.freeze({
  bug: 'Behaviour that is broken or wrong today, and the issue asks to fix it: an error, a crash, a hang, a regression, wrong output, or a failing or flaky test.',
  enhancement: 'A new feature or capability, or a change to behaviour that works as designed today.',
  documentation: 'A change to documentation only: README, AGENTS.md, specs, guides or process files, with no code change.',
  [NONE]: 'Maintenance that fixes nothing broken and adds no capability: refactoring, removing dead code, cleanup, or tooling chores.',
});

// Probability each answer must reach before it acts. Set from the replay in
// .ai/analysis/2026-10-16-jev-intake-replay.md; rerun it before changing them.
// The replay dropped the per-area yes/no questions the issue proposed: they
// added 26 wrong area labels for 7 right ones.
const THRESHOLDS = Object.freeze({
  // The first call's top candidate must reach this for the recheck to run;
  // the recheck then reads the top three, whatever their own probability.
  shortlist: 0.5,
  // The recheck's pick, and its own same-work answer, must both reach these.
  // The pick carries the separation: 0.87 for the one real duplicate in the
  // replay against at most 0.69 for anything else, over two runs.
  duplicate: 0.8,
  sameWork: 0.45,
  mainArea: 0.5,
  type: 0.5,
  accessibility: 0.7,
});

const SHORTLIST_SIZE = 3;
const BODY_LIMIT = 12_000;
const EXCERPT_LIMIT = 300;
const RECHECK_BODY_LIMIT = 8_000;
// Jev allows 32k tokens for the state plus the longest question, which is the
// duplicate Choice. Estimate tokens as chars / 3 to stay well under it.
const DUPLICATE_BUDGET_CHARS = 28_000 * 3;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

// Issue template headings (`## Context / Why`) and HTML comments open almost
// every body; dropping them leaves the excerpt for what tells issues apart.
function excerptOf(body, limit) {
  const text = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, limit);
}

function askableLabels(labels) {
  const byName = new Map(labels.map((label) => [label.name, label.description || label.name]));
  const pick = (name) => ({ name, description: byName.get(name) });
  return {
    areas: [...byName.keys()].filter((name) => name.startsWith('area-') && !NEVER_ASKED.has(name)).map(pick),
    types: Object.keys(TYPE_CRITERIA).filter((name) => name !== NONE && byName.has(name)).map(pick),
    accessibility: byName.has(ACCESSIBILITY) ? pick(ACCESSIBILITY) : null,
  };
}

function candidateKey(number) {
  return `#${number}`;
}

function duplicateCriteria(candidates, excerptLimit) {
  const criteria = {};
  for (const candidate of candidates) {
    criteria[candidateKey(candidate.number)] = excerptLimit > 0
      ? { title: candidate.title, excerpt: excerptOf(candidate.body, excerptLimit) }
      : { title: candidate.title };
  }
  criteria[NONE] = 'No listed issue is the same work as the new issue.';
  return criteria;
}

function fitDuplicateCriteria(candidates, stateChars) {
  for (const limit of [EXCERPT_LIMIT, 150, 0]) {
    const criteria = duplicateCriteria(candidates, limit);
    if (stateChars + JSON.stringify(criteria).length <= DUPLICATE_BUDGET_CHARS || limit === 0) return criteria;
  }
  throw new Error('unreachable');
}

const SAME_WORK = 'the same root cause or the same goal, so that finishing one finishes the other, not only the same topic';

function issueState(issue) {
  return { title: String(issue.title ?? ''), body: truncate(issue.body, BODY_LIMIT) };
}

function buildRequest({ issue, candidates, labels, model = DEFAULT_MODEL }) {
  const state = issueState(issue);
  const { areas, types, accessibility } = askableLabels(labels);
  const questions = {
    duplicate: {
      type: 'choice',
      instructions: `The \`title\` and \`body\` describe a newly opened issue. Is it the same underlying work as one of the listed open issues: ${SAME_WORK}? Pick none unless one listed issue is clearly the same work.`,
      criteria: fitDuplicateCriteria(candidates, JSON.stringify(state).length),
    },
  };
  if (areas.length > 0) {
    questions.main_area = {
      type: 'choice',
      instructions: 'Which part of the repository does the issue described by `title` and `body` mainly change?',
      criteria: Object.fromEntries([...areas.map((area) => [area.name, area.description]), [NONE, 'None of these parts']]),
    };
  }
  if (types.length > 0) {
    questions.type = {
      type: 'choice',
      instructions: 'What kind of work does the issue described by `title` and `body` ask for?',
      criteria: Object.fromEntries([...types.map((type) => [type.name, TYPE_CRITERIA[type.name]]), [NONE, TYPE_CRITERIA[NONE]]]),
    };
  }
  if (accessibility) {
    questions.accessibility = {
      type: 'noul',
      instructions: 'Does the issue described by `title` and `body` concern a barrier for people with disabilities, such as keyboard access, screen readers, focus, or contrast?',
    };
  }
  return { model, state, questions };
}

// The candidates the recheck re-reads: the first call's top picks, when its
// best one reaches the shortlist threshold.
function shortlist({ response, thresholds = THRESHOLDS, size = SHORTLIST_SIZE }) {
  const probabilities = response?.answers?.duplicate?.probabilities ?? {};
  const ranked = Object.entries(probabilities)
    .filter(([key, value]) => key !== NONE && typeof value === 'number')
    .sort((a, b) => b[1] - a[1])
    .slice(0, size);
  if (ranked.length === 0 || ranked[0][1] < thresholds.shortlist) return [];
  return ranked.map(([key]) => Number(key.slice(1)));
}

function sameWorkKey(number) {
  return `same_work:${candidateKey(number)}`;
}

function buildRecheckRequest({ issue, candidates, numbers, model = DEFAULT_MODEL }) {
  const byNumber = new Map(candidates.map((candidate) => [candidate.number, candidate]));
  const picked = numbers.map((number) => {
    const candidate = byNumber.get(number);
    if (!candidate) throw new Error(`#${number} is not a duplicate candidate.`);
    return { number, title: candidate.title, body: truncate(candidate.body, RECHECK_BODY_LIMIT) };
  });
  const questions = {
    duplicate: {
      type: 'choice',
      instructions: `The \`title\` and \`body\` describe a newly opened issue. Read each listed open issue in full. Is the new issue the same underlying work as one of them: ${SAME_WORK}? Work that follows up on, builds on, or was split out of a listed issue is not the same work. Pick none unless one is clearly the same work.`,
      criteria: Object.fromEntries([
        ...picked.map((candidate) => [candidateKey(candidate.number), { title: candidate.title, body: candidate.body }]),
        [NONE, 'None of these is the same work as the new issue.'],
      ]),
    },
  };
  for (const candidate of picked) {
    questions[sameWorkKey(candidate.number)] = {
      type: 'noul',
      instructions: {
        open_issue: { title: candidate.title, body: candidate.body },
        question: `Is the new issue described by \`title\` and \`body\` the same underlying work as \`open_issue\`: ${SAME_WORK}? A follow-up to \`open_issue\`, or work split out of it, is not the same work.`,
      },
    };
  }
  return { model, state: issueState(issue), questions };
}

function probability(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} is not a probability.`);
  return value;
}

function answersOf(response) {
  const answers = response?.answers;
  if (!answers || typeof answers !== 'object') throw new Error('Jev response has no answers.');
  return answers;
}

function readChoice(answers, key, question) {
  const answer = answers[key];
  if (!answer || answer.type !== 'choice') throw new Error(`Jev answer ${key} is missing or not a choice.`);
  if (!Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Jev answer ${key} picked an option that was not offered.`);
  return { choice: answer.choice, probability: probability(answer.probabilities?.[answer.choice], `Jev answer ${key}`) };
}

function readNoul(answers, key) {
  const answer = answers[key];
  if (!answer || answer.type !== 'noul') throw new Error(`Jev answer ${key} is missing or not a noul.`);
  return probability(answer.noul, `Jev answer ${key}`);
}

// recheck is { request, response } from the second call, or null when the
// first call ranked no candidate high enough to recheck.
function mapAnswers({ request, response, recheck = null, thresholds = THRESHOLDS }) {
  const answers = answersOf(response);
  const { questions } = request;
  readChoice(answers, 'duplicate', questions.duplicate);

  if (recheck) {
    const recheckAnswers = answersOf(recheck.response);
    const pick = readChoice(recheckAnswers, 'duplicate', recheck.request.questions.duplicate);
    if (pick.choice !== NONE && pick.probability >= thresholds.duplicate) {
      const number = Number(pick.choice.slice(1));
      const sameWork = readNoul(recheckAnswers, sameWorkKey(number));
      if (sameWork >= thresholds.sameWork) {
        return {
          action: 'duplicate',
          duplicate_of: number,
          comment: `Duplicate of #${number} (Jev probability ${pick.probability.toFixed(2)}, same work ${sameWork.toFixed(2)}).`,
          labels: [],
        };
      }
    }
  }

  const labels = [];
  if (questions.main_area) {
    const main = readChoice(answers, 'main_area', questions.main_area);
    if (main.choice !== NONE && main.probability >= thresholds.mainArea) labels.push(main.choice);
  }
  if (questions.type) {
    const type = readChoice(answers, 'type', questions.type);
    if (type.choice !== NONE && type.probability >= thresholds.type) labels.push(type.choice);
  }
  if (questions.accessibility && readNoul(answers, 'accessibility') >= thresholds.accessibility) labels.push(ACCESSIBILITY);

  return { action: labels.length > 0 ? 'label' : 'skip', duplicate_of: null, comment: null, labels };
}

function retryDelayMs(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  const seconds = header === null || header === undefined || header === '' ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000;
  return 1000 * 2 ** (attempt - 1);
}

async function callJev({
  request,
  apiKey,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 4,
  timeoutMs = 30_000,
}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('TYPESAFE_API_KEY is not set.');
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt >= maxAttempts) throw new Error(`Jev request failed after ${attempt} attempts: ${error.message}`);
      await sleep(retryDelayMs(null, attempt));
      continue;
    }
    if (response.ok) return response.json();
    if (RETRY_STATUSES.has(response.status) && attempt < maxAttempts) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    const detail = truncate(await response.text().catch(() => ''), 500);
    throw new Error(`Jev request failed with HTTP ${response.status}: ${detail}`);
  }
}

function summarizeAnswers(prefix, request, response) {
  return Object.entries(response.answers)
    .filter(([key]) => request.questions[key])
    .map(([key, answer]) => (answer.type === 'choice'
      ? `${prefix}${key}: ${answer.choice} (${Number(answer.probabilities?.[answer.choice]).toFixed(2)})`
      : `${prefix}${key}: ${Number(answer.noul).toFixed(2)}`));
}

// Both calls and the mapping. fetchImpl and sleep pass through to callJev.
async function triage({ issue, candidates, labels, model = DEFAULT_MODEL, apiKey, thresholds = THRESHOLDS, ...transport }) {
  const request = buildRequest({ issue, candidates, labels, model });
  const response = await callJev({ request, apiKey, ...transport });
  const numbers = shortlist({ response, thresholds });
  let recheck = null;
  if (numbers.length > 0) {
    const recheckRequest = buildRecheckRequest({ issue, candidates, numbers, model });
    recheck = { request: recheckRequest, response: await callJev({ request: recheckRequest, apiKey, ...transport }) };
  }
  const intake = mapAnswers({ request, response, recheck, thresholds });
  const log = [
    `model: ${response.model}`,
    `action: ${intake.action}`,
    ...summarizeAnswers('', request, response),
    ...(recheck ? summarizeAnswers('recheck ', recheck.request, recheck.response) : ['recheck: skipped']),
  ];
  return { intake, log: log.join('\n') };
}

// node jev-issue-intake.cjs <context dir> <intake.json path>
// Reads issue.json, open-issues.json (the filtered candidates) and
// labels.json from the context directory.
async function main([contextDir, outputPath], env = process.env) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(contextDir, name), 'utf8'));
  const { intake, log } = await triage({
    issue: read('issue.json'),
    candidates: read('open-issues.json'),
    labels: read('labels.json'),
    model: env.ISSUE_INTAKE_JEV_MODEL || DEFAULT_MODEL,
    apiKey: env.TYPESAFE_API_KEY,
  });
  validateIntake(intake);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(intake, null, 2)}\n`);
  console.log(log);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRequest,
  buildRecheckRequest,
  shortlist,
  triage,
  callJev,
  mapAnswers,
  askableLabels,
  excerptOf,
  TYPE_CRITERIA,
  THRESHOLDS,
  DEFAULT_MODEL,
  NEVER_ASKED,
  ENDPOINT,
};
