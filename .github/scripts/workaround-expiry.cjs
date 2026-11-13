const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const TITLE = 'Remove workaround rules whose replacement issue closed';

// The start of the backtick run of exactly `length` at or after `from`, or -1.
function backtickRun(line, from, length) {
  for (let start = from; start < line.length;) {
    if (line[start] !== '`') { start++; continue; }
    let end = start;
    while (line[end] === '`') end++;
    if (end - start === length) return start;
    start = end;
  }
  return -1;
}

// One left-to-right pass, as CommonMark reads inline text: whichever of an HTML comment or a
// code span starts first wins, and an escaped backtick opens nothing. A code span renders its
// text, so a marker inside one is prose that names the marker: blank the span with spaces, so
// that the text on its two sides is not joined. Code spans are read within one line here.
function maskCodeSpans(line, inComment) {
  let text = '';
  for (let i = 0; i < line.length;) {
    if (inComment) {
      const end = line.indexOf('-->', i);
      const stop = end < 0 ? line.length : end + 3;
      text += line.slice(i, stop);
      inComment = end < 0;
      i = stop;
    } else if (line.startsWith('<!--', i)) {
      text += '<!--';
      inComment = true;
      i += 4;
    } else if (line[i] === '\\') {
      text += line.slice(i, i + 2);
      i += 2;
    } else if (line[i] === '`') {
      let open = i;
      while (line[open] === '`') open++;
      const close = backtickRun(line, open, open - i);
      const stop = close < 0 ? open : close + open - i;
      text += close < 0 ? line.slice(i, stop) : ' '.repeat(stop - i);
      i = stop;
    } else {
      text += line[i++];
    }
  }
  return { text, inComment };
}

// Read marker comments outside fenced code and code spans, preserving source line numbers.
function markersIn(file, text) {
  const markers = [];
  let fence;
  let inComment = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^[ \t]*$/.test(delimiter[2])) fence = undefined;
      continue;
    }
    if (!inComment && delimiter && (delimiter[1][0] === '~' || !delimiter[2].includes('`'))) {
      fence = delimiter[1];
      continue;
    }
    const masked = maskCodeSpans(line, inComment);
    inComment = masked.inComment;
    for (const match of masked.text.matchAll(/<!-- until: ([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+#[1-9][0-9]*) -->/g)) {
      markers.push({ file, line: index + 1, issue: match[1] });
    }
  }
  return markers;
}

function trackedMarkers(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => /\.md$/i.test(file));
  return files.flatMap(file => markersIn(file, readFileSync(path.join(root, file), 'utf8')));
}

function ghApi(endpoint, method = 'GET', data) {
  const projection = endpoint.includes('?state=open') ? '[.[] | {number, title, pull_request}]'
    : method === 'GET' ? '{state}' : '{number}';
  const args = ['api', endpoint, '--method', method, '--jq', projection];
  if (data) args.push('--input', '-');
  let response;
  try {
    response = execFileSync('gh', args, {
      encoding: 'utf8', input: data ? JSON.stringify(data) : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Do not forward gh stderr: it can contain server responses or credentials.
    const reason = Number.isInteger(error.status) ? `exit ${error.status}` : 'could not start gh';
    const status = /HTTP (\d{3})/.exec(String(error.stderr ?? ''))?.[1] ?? reason;
    const failure = new Error(`GitHub API ${method} ${endpoint} failed: ${status}`);
    failure.status = status;
    throw failure;
  }
  try { return JSON.parse(response); }
  catch { throw new Error(`GitHub API ${method} ${endpoint} returned invalid JSON`); }
}

async function expiredMarkers(markers, resolveIssue, unchecked = []) {
  const states = new Map();
  const expired = [];
  for (const marker of markers) {
    if (!states.has(marker.issue)) {
      try {
        const state = await resolveIssue(marker.issue);
        if (!['open', 'closed'].includes(state)) throw new Error(`Invalid issue state for ${marker.issue}`);
        states.set(marker.issue, state);
      } catch (error) {
        const status = /^(?:[0-9]{3}|exit [0-9]+)$/.test(String(error.status)) ? String(error.status) : 'API error';
        states.set(marker.issue, { status });
      }
    }
    const state = states.get(marker.issue);
    if (state === 'closed') expired.push(marker);
    else if (typeof state === 'object') {
      unchecked.push({ ...marker, status: state.status, message: `could not check: ${marker.issue} (${state.status})` });
    }
  }
  return expired;
}

function renderBody(markers, unchecked) {
  return 'Review the expired workaround rules below and remove each when its replacement is in place. Unchecked issues need a successful state check.\n\n' +
    [...markers.map(m => `- ${JSON.stringify(m.file)}:${m.line} — https://github.com/${m.issue.replace('#', '/issues/')}`),
      ...unchecked.map(m => `- ${m.message} — ${JSON.stringify(m.file)}:${m.line}`)].join('\n');
}

async function updateCleanupIssue(repository, markers, api = ghApi, unchecked = []) {
  if (markers.length === 0 && unchecked.length === 0) return { action: 'none' }; // Leave an existing issue unchanged.
  const body = renderBody(markers, unchecked);
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
  const unchecked = [];
  const expired = await expiredMarkers(markers, async issue => {
    const [repo, number] = issue.split('#');
    return (await api(`repos/${repo}/issues/${number}`)).state;
  }, unchecked);
  print(JSON.stringify({ markers, expired, unchecked }, null, 2));
  if (publish) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
      throw new Error('A repository is required to publish');
    }
    const result = await updateCleanupIssue(repository, expired, api, unchecked);
    return unchecked.length ? { ...result, unchecked } : result;
  }
  return unchecked.length ? { action: 'none', unchecked } : { action: 'none' };
}

module.exports = { TITLE, markersIn, trackedMarkers, expiredMarkers, updateCleanupIssue, run };
if (require.main === module) {
  run({ repository: process.env.GITHUB_REPOSITORY, publish: process.argv.includes('--publish') })
    .then(result => { if (result.unchecked?.length) process.exitCode = 1; })
    .catch(error => { console.error(`Workaround expiry report failed: ${error.message}`); process.exitCode = 1; });
}
