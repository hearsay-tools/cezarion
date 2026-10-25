'use strict';

// Posts one friction finding to the day's inbox issue (docs/sdlc/friction.md
// § Friction inbox). The first finding of a UTC day creates the issue. When
// two agents create it at once, both post to the lowest number, and the
// creator of the other one closes it.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { INBOX } = require('./friction-policy.cjs');

const DESTINATION = new RegExp(String.raw`^\*\*Destination:\*\*\s*(?:${INBOX.destinations.join('|')})\s*$`, 'm');
const ISSUE_BODY = 'Friction findings recorded on this UTC day, one comment each. The friction digest reviews this issue on the next weekday: see docs/sdlc/friction.md § Friction inbox.';
const USAGE = 'Usage: node .github/scripts/friction-inbox.cjs post <finding.md>\n';

function inboxTitle(now = new Date()) {
  return `${INBOX.titlePrefix}${now.toISOString().slice(0, 10)}`;
}

// The issue list reads the repository directly, not the search index, so an
// issue created a moment ago is already in it.
function findInbox(gh, title) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', INBOX.repo, '--label', INBOX.label, '--state', 'all', '--limit', '100', '--json', 'number,title']));
  const numbers = issues.filter(issue => issue.title === title).map(issue => issue.number);
  return numbers.length ? Math.min(...numbers) : null;
}

function createdNumber(output) {
  const match = /\/issues\/(\d+)\s*$/.exec(output);
  if (!match) throw new Error(`gh issue create printed no issue URL: ${output.trim()}`);
  return Number(match[1]);
}

function post({ bodyFile, gh, now = new Date() }) {
  const body = fs.readFileSync(bodyFile, 'utf8');
  if (!DESTINATION.test(body)) throw new Error(`${bodyFile} needs a "**Destination:** ${INBOX.destinations.join(' | ')}" line.`);
  const title = inboxTitle(now);
  let issue = findInbox(gh, title);
  if (issue === null) {
    gh(['label', 'create', INBOX.label, '--repo', INBOX.repo, '--force', '--color', 'C5DEF5', '--description', 'Daily friction inbox; the friction digest reviews it.']);
    const created = createdNumber(gh(['issue', 'create', '--repo', INBOX.repo, '--title', title, '--label', INBOX.label, '--body', ISSUE_BODY]));
    issue = findInbox(gh, title) ?? created;
    if (issue !== created) gh(['issue', 'close', String(created), '--repo', INBOX.repo, '--comment', `Duplicate of ${INBOX.repo}#${issue}.`]);
  }
  const url = gh(['issue', 'comment', String(issue), '--repo', INBOX.repo, '--body-file', bodyFile]).trim();
  return { issue, url };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main(argv, { run = gh, now = new Date(), stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  const [command, bodyFile, ...rest] = argv;
  if (command !== 'post' || !bodyFile || rest.length > 0) {
    stderr(USAGE);
    return 2;
  }
  try {
    stdout(`${post({ bodyFile, gh: run, now }).url}\n`);
    return 0;
  } catch (error) {
    stderr(`Friction inbox post failed: ${String(error.stderr || error.message).trim()}\n`);
    return 1;
  }
}

module.exports = { inboxTitle, findInbox, post, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
