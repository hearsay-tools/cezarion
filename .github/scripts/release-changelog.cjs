// Commit-derived release notes. Pin the range in the body so tags added after
// publication cannot change what a retry considers matching generated notes.
const stableTag = /^v\d+\.\d+\.\d+$/;
const compareVersions = (a, b) => {
  const left = a.slice(1).split('.').map(BigInt);
  const right = b.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
};
const escapeMarkdown = (text) => text
  .replace(/[\x00-\x1f\x7f]/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#+.!|~>-]/g, '\\$&');

function releaseChangelog({ git, url, sha, version, previous }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid published source commit.');
  if (git('rev-parse', '--is-shallow-repository') !== 'false') {
    throw new Error('Release changelog requires full Git history; use fetch-depth: 0.');
  }
  let baseTag = null;
  let baseSha = null;
  if (previous !== undefined) {
    const match = previous.match(/^<!-- cezar-changelog:v1 base=(root|v\d+\.\d+\.\d+@[a-f0-9]{40}) head=([a-f0-9]{40}) -->\n/);
    if (!match || match[2] !== sha) throw new Error('Conflicting generated changelog range. Existing release was not changed.');
    if (match[1] !== 'root') [baseTag, baseSha] = match[1].split('@');
  } else {
    // Highest stable version below this release that is reachable from its
    // source. Ignore preview, future, current, and unrelated-branch tags.
    baseTag = git('tag', '--merged', sha, '--list', 'v*').split('\n')
      .filter((tag) => stableTag.test(tag) && compareVersions(tag, `v${version}`) < 0)
      .sort(compareVersions).at(-1) ?? null;
    if (baseTag) baseSha = git('rev-parse', `refs/tags/${baseTag}^{commit}`);
  }
  if (baseSha) {
    if (compareVersions(baseTag, `v${version}`) >= 0) throw new Error('Changelog base must precede the release version.');
    // On retry use the recorded commit, even if someone has moved the old tag.
    git('merge-base', '--is-ancestor', baseSha, sha);
  }
  const marker = `<!-- cezar-changelog:v1 base=${baseTag ? `${baseTag}@${baseSha}` : 'root'} head=${sha} -->`;
  const range = baseSha ? `${baseSha}..${sha}` : sha;
  const total = Number(git('rev-list', '--count', range, '--'));
  // Bound Git's output as well as the rendered body. Latest commits come first;
  // the full-history/comparison link remains available for everything omitted.
  const commits = git('log', '--topo-order', '--max-count=500', '--format=%H%x00%<(500,trunc)%s', range, '--')
    .split('\n').filter(Boolean).map((line) => {
      const [commit, subject] = line.split('\0');
      return `- ${escapeMarkdown(subject.trimEnd())} ([${commit.slice(0, 7)}](${url}/commit/${commit}))`;
    });
  const comparison = baseSha
    ? `Changes since ${baseTag}: [full comparison](${url}/compare/${baseSha}...${sha}).`
    : `First release: all history through [${sha.slice(0, 7)}](${url}/commits/${sha}).`;
  const lines = [marker, '## Changes', '', comparison, ''];
  let bytes = Buffer.byteLength(lines.join('\n'));
  let shown = 0;
  for (const commit of commits) {
    const size = Buffer.byteLength(commit) + 1;
    // Leave room for the count below and the publication metadata outside this
    // section. Use bytes so multibyte subjects also remain safely bounded.
    if (bytes + size > 60000) break;
    lines.push(commit);
    bytes += size;
    shown++;
  }
  if (!total) lines.push('No commits since the previous release.');
  else if (shown < total) lines.push('', `Showing ${shown} of ${total} commits; see the full history or comparison above for the remaining ${total - shown}.`);
  return lines.join('\n');
}

module.exports = { releaseChangelog };
