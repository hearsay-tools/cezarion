const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const TITLE = 'Remove workaround rules whose replacement issue closed';

// Literal marker reader, not a Markdown renderer: fenced examples count too.
function markersIn(file, text) {
  return text.split(/\r?\n/).flatMap((line, index) =>
    [...line.matchAll(/<!-- until: ([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+#[1-9][0-9]*) -->/g)]
      .map(match => ({ file, line: index + 1, issue: match[1] })));
}

function trackedMarkers(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => /\.md$/i.test(file));
  return files.flatMap(file => markersIn(file, readFileSync(path.join(root, file), 'utf8')));
}

function ghApi(endpoint, method = 'GET', data) {
  const args = ['api', endpoint, '--method', method];
  if (data) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: data ? JSON.stringify(data) : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

async function expiredMarkers(markers, resolveIssue) {
  const states = new Map();
  const expired = [];
  for (const marker of markers) {
    if (!states.has(marker.issue)) {
      const state = await resolveIssue(marker.issue);
      if (!['open', 'closed'].includes(state)) throw new Error('Invalid issue state');
      states.set(marker.issue, state);
    }
    if (states.get(marker.issue) === 'closed') expired.push(marker);
  }
  return expired;
}

function renderBody(markers) {
  return 'These workaround rules reference closed replacement issues. Check each rule and remove it when its replacement is in place.\n\n' +
    markers.map(m => `- ${JSON.stringify(m.file)}:${m.line} — https://github.com/${m.issue.replace('#', '/issues/')}`).join('\n');
}

async function updateCleanupIssue(repository, markers, api = ghApi) {
  if (markers.length === 0) return { action: 'none' }; // Leave an existing issue unchanged.
  const body = renderBody(markers);
  // GitHub issue bodies have a 65,536-character limit. Never publish a partial list.
  if (body.length > 65000) throw new Error('Cleanup report exceeds issue body limit');
  const endpoint = `repos/${repository}/issues`;
  let existing;
  for (let page = 1; ; page++) {
    const issues = await api(`${endpoint}?state=open&per_page=100&page=${page}`);
    existing = issues.find(issue => !issue.pull_request && issue.title === TITLE);
    if (existing || issues.length < 100) break;
  }
  if (existing) {
    await api(`${endpoint}/${existing.number}`, 'PATCH', { body });
    return { action: 'update', number: existing.number };
  }
  const issue = await api(endpoint, 'POST', { title: TITLE, body });
  return { action: 'create', number: issue.number };
}

async function run({ root, repository, publish = false, api = ghApi, print = console.log }) {
  const markers = trackedMarkers(root);
  const expired = await expiredMarkers(markers, async issue => {
    const [repo, number] = issue.split('#');
    return (await api(`repos/${repo}/issues/${number}`)).state;
  });
  print(JSON.stringify({ markers, expired }, null, 2));
  if (publish) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
      throw new Error('A repository is required to publish');
    }
    return updateCleanupIssue(repository, expired, api);
  }
  return { action: 'none' };
}

module.exports = { TITLE, markersIn, trackedMarkers, expiredMarkers, updateCleanupIssue, run };
if (require.main === module) {
  run({ repository: process.env.GITHUB_REPOSITORY, publish: process.argv.includes('--publish') })
    .catch(() => { console.error('Workaround expiry report failed; no complete report is available.'); process.exitCode = 1; });
}
