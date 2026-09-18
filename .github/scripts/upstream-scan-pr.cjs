// Open the weekly upstream-scan PR (spec .ai/specs/2026-09-18-upstream-ledger.md).
// Runs inside actions/github-script after upstream-scan.cjs printed its summary
// into SCAN_JSON. Nothing new → no git, no PR. Otherwise commit `.ai/upstream`
// on `upstream-scan/<date>` and open one draft PR against BASE_BRANCH.
//
// An OPEN PR for that branch is left untouched: its branch may already carry a
// reviewer's status edits, and a rerun the same day must not push over them.
// A branch with no open PR (a closed one, or a failed earlier run) is bot-owned
// and is overwritten.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

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

async function openScanPr({ github, context, core, env = process.env, git = defaultGit, readFile = (f) => fs.readFileSync(f, 'utf8') }) {
  const summary = JSON.parse(env.SCAN_JSON || '{}');
  const base = env.BASE_BRANCH;
  if (!summary.added) {
    core.setOutput('status', 'nothing-new');
    return;
  }
  if (!base || !/^\d{4}-\d{2}-\d{2}$/.test(summary.date ?? '')) throw new Error('openScanPr needs BASE_BRANCH and a dated scan summary.');
  const branch = `upstream-scan/${summary.date}`;
  const prs = await github.paginate(github.rest.pulls.list, {
    ...context.repo, state: 'open', head: `${context.repo.owner}:${branch}`, per_page: 100,
  });
  if (prs.length) {
    core.setOutput('status', 'exists');
    core.setOutput('url', prs[0].html_url);
    return;
  }
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');
  git('checkout', '-B', branch);
  git('add', '.ai/upstream');
  git('commit', '-m', `chore(upstream): scan ${summary.date} — ${summary.added} new upstream commits`);
  git('push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  const { data } = await github.rest.pulls.create({
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

module.exports = { openScanPr, body };
