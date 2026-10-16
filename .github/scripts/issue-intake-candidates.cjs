'use strict';

// Duplicate candidates for issue intake, built in code so no provider can pick
// the new issue itself or the issue it was split out of (#1163, #1154). Every
// intake path reads the list this writes; the applicator rebuilds it uncapped
// as a backstop.

const fs = require('node:fs');

// A Jev Choice takes at most 255 options, and one of them is "none".
const MAX_CANDIDATES = 254;

const REF = String.raw`\[?(?:#(\d+)|([\w.-]+\/[\w.-]+)#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))`;
const SPLIT_OUT = new RegExp(String.raw`\b(?:split|carved)(?:\s+out)?\s+(?:of|from)\s+${REF}`, 'gi');

function splitParents(body, repo, title = '') {
  const parents = new Set();
  const here = String(repo).toLowerCase();
  for (const text of [title, body]) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(SPLIT_OUT)) {
      const [, bare, refRepo, refNumber, urlRepo, urlNumber] = match;
      if (bare) parents.add(Number(bare));
      else if (refRepo && refRepo.toLowerCase() === here) parents.add(Number(refNumber));
      else if (urlRepo && urlRepo.toLowerCase() === here) parents.add(Number(urlNumber));
    }
  }
  return parents;
}

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function buildCandidates({ issue, openIssues, repo, max = MAX_CANDIDATES }) {
  if (!issue || !Number.isInteger(issue.number) || issue.number <= 0) throw new Error('issue number must be a positive integer.');
  if (!Array.isArray(openIssues)) throw new Error('openIssues must be an array.');
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must be owner/name.');

  const excluded = splitParents(issue.body, repo, issue.title);
  excluded.add(issue.number);

  const candidates = openIssues
    .filter((other) => other && !other.pull_request && Number.isInteger(other.number) && !excluded.has(other.number))
    .map((other) => ({
      number: other.number,
      title: String(other.title ?? ''),
      body: String(other.body ?? ''),
      labels: (other.labels ?? []).map(labelName).filter((name) => typeof name === 'string' && name.length > 0),
      updated_at: other.updated_at ?? null,
    }));
  if (candidates.length <= max) return candidates;

  const keep = new Set(
    [...candidates]
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
      .slice(0, max)
      .map((candidate) => candidate.number),
  );
  return candidates.filter((candidate) => keep.has(candidate.number));
}

// node issue-intake-candidates.cjs <issue.json> <open-issues-raw.json>
// prints the filtered candidates. GITHUB_REPOSITORY names the repository.
if (require.main === module) {
  const [issuePath, openPath] = process.argv.slice(2);
  const candidates = buildCandidates({
    issue: JSON.parse(fs.readFileSync(issuePath, 'utf8')),
    openIssues: JSON.parse(fs.readFileSync(openPath, 'utf8')),
    repo: process.env.GITHUB_REPOSITORY,
  });
  process.stdout.write(`${JSON.stringify(candidates)}\n`);
}

module.exports = { buildCandidates, splitParents, MAX_CANDIDATES };
