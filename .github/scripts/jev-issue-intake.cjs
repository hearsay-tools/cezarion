'use strict';

// Issue intake through Jev, TypeSafe's typed-decision model (#1163). One call
// asks every question; this script maps the answers to the intake.json schema
// that apply-issue-intake.cjs applies, so the applicator stays the only code
// that mutates an issue. Jev has no tools and can only answer with options we
// offered, so the duplicate pick is always one of the filtered candidates.

const fs = require('node:fs');
const path = require('node:path');
const { validateIntake } = require('./apply-issue-intake.cjs');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Pinned: the thresholds below were tuned against this version, and
// jev-latest moves when a new release ships.
const DEFAULT_MODEL = 'jev-1.13.0';

// Labels other processes set. Intake never asks about them.
const NEVER_ASKED = new Set(['friction', 'upstream-port', 'epic', 'in-progress', 'needs-qa', 'repo-setup']);
const TYPE_LABELS = ['bug', 'enhancement', 'documentation'];
const ACCESSIBILITY = 'accessibility';
const NONE = 'none';

// Probability each answer must reach before it acts. Set from the replay in
// .ai/analysis/2026-10-16-jev-intake-replay.md; rerun it before changing them.
const THRESHOLDS = Object.freeze({
  duplicate: 0.9,
  mainArea: 0.5,
  type: 0.5,
  secondaryArea: 0.8,
  accessibility: 0.7,
});

const BODY_LIMIT = 12_000;
const EXCERPT_LIMIT = 300;
// Jev allows 32k tokens for the state plus the longest question, which is the
// duplicate Choice. Estimate tokens as chars / 3 to stay well under it.
const DUPLICATE_BUDGET_CHARS = 28_000 * 3;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function askableLabels(labels) {
  const byName = new Map(labels.map((label) => [label.name, label.description || label.name]));
  const pick = (name) => ({ name, description: byName.get(name) });
  return {
    areas: [...byName.keys()].filter((name) => name.startsWith('area-') && !NEVER_ASKED.has(name)).map(pick),
    types: TYPE_LABELS.filter((name) => byName.has(name)).map(pick),
    accessibility: byName.has(ACCESSIBILITY) ? pick(ACCESSIBILITY) : null,
  };
}

function candidateKey(number) {
  return `#${number}`;
}

function duplicateCriteria(candidates, excerptLimit) {
  const criteria = {};
  for (const candidate of candidates) {
    const excerpt = truncate(candidate.body.replace(/\s+/g, ' ').trim(), excerptLimit);
    criteria[candidateKey(candidate.number)] = excerptLimit > 0 ? { title: candidate.title, excerpt } : { title: candidate.title };
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

function buildRequest({ issue, candidates, labels, model = DEFAULT_MODEL }) {
  const state = { title: String(issue.title ?? ''), body: truncate(issue.body, BODY_LIMIT) };
  const { areas, types, accessibility } = askableLabels(labels);
  const questions = {
    duplicate: {
      type: 'choice',
      instructions: 'The `title` and `body` describe a newly opened issue. Is it the same underlying work as one of the listed open issues: the same root cause or the same goal, not only the same topic? Pick none unless one listed issue is clearly the same work.',
      criteria: fitDuplicateCriteria(candidates, JSON.stringify(state).length),
    },
  };
  if (areas.length > 0) {
    questions.main_area = {
      type: 'choice',
      instructions: 'Which part of the repository does the issue described by `title` and `body` mainly change?',
      criteria: Object.fromEntries([...areas.map((area) => [area.name, area.description]), [NONE, 'None of these parts']]),
    };
    for (const area of areas) {
      questions[`area:${area.name}`] = {
        type: 'noul',
        instructions: `Does the work in the issue described by \`title\` and \`body\` change this part of the repository: ${area.description}?`,
      };
    }
  }
  if (types.length > 0) {
    questions.type = {
      type: 'choice',
      instructions: 'What kind of issue do `title` and `body` describe?',
      criteria: Object.fromEntries([...types.map((type) => [type.name, type.description]), [NONE, 'None of these kinds']]),
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

function probability(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} is not a probability.`);
  return value;
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

function mapAnswers({ request, response, thresholds = THRESHOLDS }) {
  const answers = response?.answers;
  if (!answers || typeof answers !== 'object') throw new Error('Jev response has no answers.');
  const { questions } = request;

  const duplicate = readChoice(answers, 'duplicate', questions.duplicate);
  if (duplicate.choice !== NONE && duplicate.probability >= thresholds.duplicate) {
    const number = Number(duplicate.choice.slice(1));
    return {
      action: 'duplicate',
      duplicate_of: number,
      comment: `Duplicate of #${number} (Jev probability ${duplicate.probability.toFixed(2)}).`,
      labels: [],
    };
  }

  const labels = [];
  let mainArea = null;
  if (questions.main_area) {
    const main = readChoice(answers, 'main_area', questions.main_area);
    if (main.choice !== NONE && main.probability >= thresholds.mainArea) {
      mainArea = main.choice;
      labels.push(mainArea);
    }
    for (const area of Object.keys(questions.main_area.criteria).filter((name) => name !== NONE)) {
      if (area !== mainArea && readNoul(answers, `area:${area}`) >= thresholds.secondaryArea) labels.push(area);
    }
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

function summarize(request, response, intake) {
  const lines = [`model: ${response.model}`, `action: ${intake.action}`];
  for (const [key, answer] of Object.entries(response.answers)) {
    if (!request.questions[key]) continue;
    lines.push(answer.type === 'choice'
      ? `${key}: ${answer.choice} (${Number(answer.probabilities?.[answer.choice]).toFixed(2)})`
      : `${key}: ${Number(answer.noul).toFixed(2)}`);
  }
  return lines.join('\n');
}

// node jev-issue-intake.cjs <context dir> <intake.json path>
// Reads issue.json, open-issues.json (the filtered candidates) and
// labels.json from the context directory.
async function main([contextDir, outputPath], env = process.env) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(contextDir, name), 'utf8'));
  const request = buildRequest({
    issue: read('issue.json'),
    candidates: read('open-issues.json'),
    labels: read('labels.json'),
    model: env.ISSUE_INTAKE_JEV_MODEL || DEFAULT_MODEL,
  });
  const response = await callJev({ request, apiKey: env.TYPESAFE_API_KEY });
  const intake = mapAnswers({ request, response });
  validateIntake(intake);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(intake, null, 2)}\n`);
  console.log(summarize(request, response, intake));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRequest,
  callJev,
  mapAnswers,
  askableLabels,
  THRESHOLDS,
  DEFAULT_MODEL,
  NEVER_ASKED,
  ENDPOINT,
};
