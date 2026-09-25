// Open the weekly upstream-scan PR (spec .ai/specs/2026-09-18-upstream-ledger.md).
// Runs inside actions/github-script after upstream-scan.cjs printed its summary
// into SCAN_JSON. Nothing new → no git, no PR. Otherwise commit `.ai/upstream`
// on `upstream-scan/<date>` and open one draft PR against BASE_BRANCH.
// Only PR creation uses prGithub (the installation-token client), so native
// pull_request_target CI starts; git and lookups retain the workflow token.
//
// Any OPEN upstream-scan/* PR blocks a new one: its branch may already carry a
// reviewer's status edits, and a later scan would start from main's ledger and
// duplicate every row it holds. A branch with no open PR (a closed one, or a
// failed earlier run) is bot-owned and is overwritten.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const BRANCH_PREFIX = 'upstream-scan';

function defaultGit(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function body(summary, report) {
  return [
    report.trimEnd(),
    '',
    '---',
    '',
    `Scanned upstream to \`${summary.upstreamHead}\` (range \`${summary.since.slice(0, 8)}..${summary.upstreamHead.slice(0, 8)}\`).`,
    'Every row above was appended to `.ai/upstream/ledger.yaml` as `pending`. To decide a row, edit its',
    '`status`, add `decided`, and fill the fields that status requires (see `.ai/upstream/README.md`), then',
    'run `node .github/scripts/upstream-scan.cjs render` so `LEDGER.md` matches. The unit gate rejects a',
    '`ported` row without a fork link and a `rejected` row without a reason.',
    '',
    'Opened by `.github/workflows/upstream-scan.yml`.',
  ].join('\n');
}

async function openScanPr({ github, prGithub, context, core, env = process.env, git = defaultGit, readFile = (f) => fs.readFileSync(f, 'utf8') }) {
  const summary = JSON.parse(env.SCAN_JSON || '{}');
  const base = env.BASE_BRANCH;
  if (!summary.added) {
    core.setOutput('status', 'nothing-new');
    return;
  }
  if (!base || !/^\d{4}-\d{2}-\d{2}$/.test(summary.date ?? '')) throw new Error('openScanPr needs BASE_BRANCH and a dated scan summary.');
  const branch = `${BRANCH_PREFIX}/${summary.date}`;
  // One scan PR at a time, whatever its date. A second scan while last week's PR is still
  // undecided would start from main's ledger, rediscover every row that PR already holds and
  // open a duplicate that conflicts with it on merge. Block until the open one is decided.
  const open = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'open', per_page: 100 });
  const existing = open.find((pr) => typeof pr.head?.ref === 'string' && pr.head.ref.startsWith(`${BRANCH_PREFIX}/`));
  if (existing) {
    core.setOutput('status', 'exists');
    core.setOutput('url', existing.html_url);
    return;
  }
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');
  git('checkout', '-B', branch);
  git('add', '.ai/upstream');
  git('commit', '-m', `chore(upstream): scan ${summary.date} — ${summary.added} new upstream commits`);
  git('push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  const { data } = await prGithub.rest.pulls.create({
    ...context.repo,
    base,
    head: branch,
    draft: true,
    title: `chore(upstream): scan ${summary.date} — ${summary.added} new upstream commits`,
    body: body(summary, readFile(summary.report)),
  });
  core.setOutput('status', 'created');
  core.setOutput('url', data.html_url);
}

module.exports = { openScanPr, body, BRANCH_PREFIX };
