// GitHub bookkeeping after npm publication. Each step reports its own outcome;
// no retry updates an existing branch, PR, tag, or release (#192).
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const command = (program, args) => execFileSync(program, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const git = (...args) => command('git', args);
const message = (error) => String(error.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 2000);
const repoUrl = (context) => `${context.serverUrl ?? 'https://github.com'}/${context.repo.owner}/${context.repo.repo}`;
const readOptional = async (read) => {
  try { return (await read()).data; } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
};
function failed(core, error) {
  const reason = message(error);
  core.setOutput('status', 'failed');
  core.setOutput('reason', reason);
  core.setFailed(reason);
}

async function bumpPr({ github, context, core }) {
  const version = process.env.VERSION;
  const base = process.env.BASE_BRANCH;
  const branch = `release/v${version}`;
  const recovery = `${repoUrl(context)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
  core.setOutput('recovery', recovery);
  try {
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !base) throw new Error('Missing or invalid release version/base branch.');
    if (git('rev-parse', 'HEAD') !== context.sha) throw new Error('Checkout does not match the published source commit.');
    command('npm', ['install', '--package-lock-only', '--ignore-scripts']);
    // Use Git pathspecs, not a shell. Stage all stamped workspaces and the alias.
    git('add', 'packages/*/package.json', 'alias-cezarion/package.json', 'package-lock.json');
    const changed = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
    if (changed.some((file) => !/^(packages\/[^/]+\/package\.json|alias-cezarion\/package\.json|package-lock\.json)$/.test(file))) {
      throw new Error('Unexpected staged changes; refusing to include them in the version-bump branch.');
    }
    const tree = git('write-tree');
    const conflict = () => new Error(`Conflicting release branch or PR for ${branch}. Remote work was not overwritten. Inspect ${recovery} and resolve the mismatch manually before retrying.`);
    const matches = (sha) => git('rev-parse', `${sha}^{tree}`) === tree
      && git('show', '-s', '--format=%P', sha) === context.sha;
    const fetchBranch = () => {
      // An empty successful lookup means absent; transport/auth failures throw.
      if (!git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) return null;
      git('fetch', '--no-tags', 'origin', `refs/heads/${branch}`);
      const sha = git('rev-parse', 'FETCH_HEAD');
      if (!matches(sha)) throw conflict();
      return sha;
    };
    // Inspect every PR for this head, including a manually chosen wrong base.
    // Filtering by base here would hide that conflict and allow a duplicate PR.
    const prs = await github.paginate(github.rest.pulls.list, {
      ...context.repo, state: 'all', head: `${context.repo.owner}:${branch}`, per_page: 100,
    });
    if (prs.length > 1) throw conflict();
    let sha = fetchBranch();
    if (prs.length) {
      const pr = prs[0];
      // A merged bump can have had its branch deleted. Verify its original head
      // without resurrecting the branch or opening a second PR.
      if (!sha && pr.merged_at) {
        git('fetch', '--no-tags', 'origin', pr.head.sha);
        sha = git('rev-parse', 'FETCH_HEAD');
        if (!matches(sha)) throw conflict();
      }
      const fullName = `${context.repo.owner}/${context.repo.repo}`;
      if (!sha || pr.head.sha !== sha || pr.head.ref !== branch || pr.base.ref !== base
        || pr.head.repo?.full_name !== fullName || pr.base.repo?.full_name !== fullName
        || (pr.state !== 'open' && !pr.merged_at)) throw conflict();
      core.setOutput('status', 'reused');
      core.setOutput('url', pr.html_url);
      return;
    }
    if (!sha) {
      // Commit-tree leaves HEAD at the published source and varies freely with
      // time. Matching retries reuse the remote SHA, not the new candidate SHA.
      git('config', 'user.name', 'github-actions[bot]');
      git('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');
      sha = git('commit-tree', tree, '-p', context.sha, '-m', `chore(release): v${version}`);
      try {
        // An explicit empty lease means CREATE ONLY, even when a concurrently
        // created ref could fast-forward. It cannot overwrite an existing ref.
        git('push', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${sha}:refs/heads/${branch}`);
      } catch (error) {
        // Another attempt may have pushed between lookup and push. Verify it.
        const concurrent = fetchBranch();
        if (!concurrent) throw error;
        sha = concurrent;
      }
    }
    let pr;
    try {
      pr = (await github.rest.pulls.create({
        ...context.repo, base, head: branch, title: `chore(release): v${version}`,
        body: `Record the \`v${version}\` version bump that the Release workflow published to npm \`latest\`. Merge to keep \`${base}\`'s manifests in sync with the published version.`,
      })).data;
    } catch (error) {
      throw new Error(`${message(error)}. PR creation requires pull-requests: write and Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests (${repoUrl(context)}/settings/actions); an organization policy may also need administrator approval. Open the PR manually: ${recovery}`);
    }
    core.setOutput('status', 'created');
    core.setOutput('url', pr.html_url);
  } catch (error) { failed(core, error); }
}

async function githubRelease({ github, context, core }) {
  const version = process.env.VERSION;
  const tag = `v${version}`;
  core.setOutput('tag_verified', 'false');
  try {
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Missing or invalid release version.');
    const alias = process.env.ALIAS_NAME;
    const published = (process.env.PUBLISHED_NAMES ?? '').split(',').filter(Boolean);
    if (!alias || !published.length) throw new Error('Missing published package names.');
    const body = [
      '## Published packages', '', '| Package | Version |', '|---|---|',
      ...published.map((name) => `| \`${name}\` | \`${version}\` |`),
      '', '### Install', '', '```bash', `npx ${alias}@${version}`, '```',
    ].join('\n');
    const verifyTag = async () => {
      const ref = await readOptional(() => github.rest.git.getRef({ ...context.repo, ref: `tags/${tag}` }));
      if (!ref) return false;
      let object = ref.object;
      // Peel annotated tags, with a bound for malformed/cyclic API responses.
      for (let depth = 0; object.type === 'tag' && depth < 8; depth++) {
        object = (await github.rest.git.getTag({ ...context.repo, tag_sha: object.sha })).data.object;
      }
      if (object.type !== 'commit' || object.sha !== context.sha) {
        throw new Error(`Conflicting tag ${tag}; expected published source ${context.sha}. Inspect ${repoUrl(context)}/releases/tag/${tag} before retrying. No tag was moved.`);
      }
      core.setOutput('tag_verified', 'true');
      return true;
    };
    const tagged = await verifyTag();
    let release = await readOptional(() => github.rest.repos.getReleaseByTag({ ...context.repo, tag }));
    let status = 'reused';
    if (!release) {
      release = (await github.rest.repos.createRelease({
        ...context.repo, tag_name: tag, target_commitish: context.sha, name: tag,
        body, draft: false, prerelease: false,
      })).data;
      status = 'created';
    } else if (!tagged) {
      throw new Error(`Existing release ${tag} has no verifiable tag. Inspect ${repoUrl(context)}/releases/tag/${tag} before retrying.`);
    }
    // target_commitish can name a moving branch; the resolved tag is the source
    // of truth. Never edit a release with different publication metadata.
    if (release.tag_name !== tag || release.name !== tag || release.body !== body || release.draft || release.prerelease) {
      throw new Error(`Conflicting GitHub Release ${tag}. Inspect ${repoUrl(context)}/releases/tag/${tag}; existing metadata was not changed.`);
    }
    if (!await verifyTag()) throw new Error(`GitHub Release ${tag} exists but its tag could not be verified.`);
    core.setOutput('status', status);
    core.setOutput('url', release.html_url);
  } catch (error) { failed(core, error); }
}

function summary() {
  const env = process.env;
  const published = env.PUBLISHED === 'true';
  const pr = env.PR_STATUS || (env.BUMP === 'existing' ? 'not needed (existing version)' : 'not completed');
  const release = env.RELEASE_STATUS || 'not completed';
  const lines = [
    `## Release ${env.VERSION}`, '',
    `- npm publication: ${published ? `published \`${env.ALIAS_NAME}@${env.VERSION}\` (including packages already published on an earlier attempt)` : 'dry run — nothing was published'}.`,
    `- Version-bump PR: ${published ? pr : 'skipped'}${env.PR_URL ? ` — ${env.PR_URL}` : ''}.`,
    `- GitHub Release: ${published ? release : 'skipped'}${env.RELEASE_URL ? ` — ${env.RELEASE_URL}` : ''}.`,
    `- Tag: ${published && env.TAG_VERIFIED === 'true' ? `verified \`v${env.VERSION}\` at the published source commit` : 'not confirmed at the published source commit'}.`,
  ];
  if (env.PR_REASON) lines.push('', `PR recovery: ${env.PR_REASON}`);
  if (env.RELEASE_REASON) lines.push('', `Release recovery: ${env.RELEASE_REASON}`);
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

module.exports = { bumpPr, githubRelease, summary };
