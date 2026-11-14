// GitHub bookkeeping after npm publication. Each step reports its own outcome;
// no retry updates an existing branch, PR, tag, or release (#192).
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { isReleaseBumpFile, releaseBumpPaths } = require('./release-bump-pr.cjs');
const { ensureReleaseCi } = require('./release-ci.cjs');
const { releaseChangelog } = require('./release-changelog.cjs');

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
// The published source is the release candidate, which can be older than the dispatch
// commit (context.sha). The workflow passes it as SOURCE_SHA; the bump PR, the tag and
// the changelog all name it.
function withSource(context) {
  const sha = process.env.SOURCE_SHA || context.sha;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Missing or invalid published source commit.');
  // @actions/github defines `repo` as a prototype getter, which a spread drops.
  return { ...context, repo: context.repo, sha };
}

function failed(core, error) {
  const reason = message(error);
  core.setOutput('status', 'failed');
  core.setOutput('reason', reason);
  core.setFailed(reason);
}

// The run command is `npx cezarion@V` with the switch off, so old release bodies still match.
function releaseMetadata(version, published, runCommand) {
  return [
    '## Published packages', '', '| Package | Version |', '|---|---|',
    ...published.map((name) => `| \`${name}\` | \`${version}\` |`),
    '', '### Install', '', '```bash', runCommand, '```',
  ].join('\n');
}

function resolveReleaseBody({ release, metadata, tag, context, version }) {
  // Old releases predate generated notes. Reuse exact legacy metadata, never
  // overwrite it. New releases always include a verifiable changelog.
  let body = metadata;
  if (!release || release.body !== metadata) {
    const prefix = `${metadata}\n\n`;
    if (release && !release.body?.startsWith(prefix)) {
      throw new Error(`Conflicting GitHub Release ${tag}. Existing metadata was not changed.`);
    }
    body = prefix + releaseChangelog({
      git, url: repoUrl(context), sha: context.sha, version,
      ...(release ? { previous: release.body.slice(prefix.length) } : {}),
    });
  }
  return body;
}

function expectVerifiableRelease(release, tag, body, context) {
  // target_commitish can name a moving branch; the resolved tag is the source
  // of truth. Never edit a release with different publication metadata.
  if (release.tag_name !== tag || release.name !== tag || release.body !== body || release.draft || release.prerelease) {
    throw new Error(`Conflicting GitHub Release ${tag}. Inspect ${repoUrl(context)}/releases/tag/${tag}; existing metadata was not changed.`);
  }
}

function collectBumpTree() {
  command('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile']);
  // Use Git pathspecs, not a shell. Stage all stamped workspaces and the lockfile.
  git('add', ...releaseBumpPaths());
  const changed = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (changed.some((file) => !isReleaseBumpFile(file))) {
    throw new Error('Unexpected staged changes; refusing to include them in the version-bump branch.');
  }
  return git('write-tree');
}

async function reuseReleasePr({ core, pr, sha, branch, base, context, matches, conflict, startCi }) {
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
  if (!pr.merged_at) await startCi(pr, sha);
  else core.setOutput('ci_status', 'not-needed');
}

function pushBumpBranch({ branch, context, tree, version, fetchBranch }) {
  // Commit-tree leaves HEAD at the published source and varies freely with
  // time. Matching retries reuse the remote SHA, not the new candidate SHA.
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');
  const sha = git('commit-tree', tree, '-p', context.sha, '-m', `chore(release): v${version}`);
  try {
    // An explicit empty lease means CREATE ONLY, even when a concurrently
    // created ref could fast-forward. It cannot overwrite an existing ref.
    git('push', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${sha}:refs/heads/${branch}`);
  } catch (error) {
    // Another attempt may have pushed between lookup and push. Verify it.
    const concurrent = fetchBranch();
    if (!concurrent) throw error;
    return concurrent;
  }
  return sha;
}

async function createBumpPullRequest({ github, prGithub, context, core, branch, base, version, recovery, sha, startCi }) {
  let pr;
  try {
    pr = (await (prGithub || github).rest.pulls.create({
      ...context.repo, base, head: branch, title: `chore(release): v${version}`,
      body: `Record the \`v${version}\` version bump that the Release workflow published to npm \`latest\`. Merge to keep \`${base}\`'s manifests in sync with the published version.`,
    })).data;
  } catch (error) {
    throw new Error(`${message(error)}. PR creation requires the release App installed on this repository with Pull requests: write. For legacy GITHUB_TOKEN callers, check pull-requests: write and Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests (${repoUrl(context)}/settings/actions); an organization policy may also need administrator approval. Open the PR manually: ${recovery}`);
  }
  core.setOutput('status', 'created');
  core.setOutput('url', pr.html_url);
  await startCi(pr, sha);
}

async function bumpPr({ github, prGithub, context, core, nativeCi = false, sleep }) {
  const startCi = async (pr, sha) => {
    try {
      const result = await ensureReleaseCi({ github, repo: context.repo, prNumber: pr.number, expectedSha: sha, native: nativeCi, ...(sleep ? { sleep } : {}) });
      core.setOutput('ci_status', result.status);
      core.setOutput('ci_url', result.url);
    } catch (error) {
      core.setOutput('ci_status', 'failed');
      core.setOutput('ci_reason', message(error));
      core.setFailed(message(error));
    }
  };
  const version = process.env.VERSION;
  const base = process.env.BASE_BRANCH;
  const branch = `release/v${version}`;
  const recovery = `${repoUrl(context)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
  core.setOutput('recovery', recovery);
  try {
    context = withSource(context);
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !base) throw new Error('Missing or invalid release version/base branch.');
    if (git('rev-parse', 'HEAD') !== context.sha) throw new Error('Checkout does not match the published source commit.');
    const tree = collectBumpTree();
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
      await reuseReleasePr({ core, pr: prs[0], sha, branch, base, context, matches, conflict, startCi });
      return;
    }
    if (!sha) sha = pushBumpBranch({ branch, context, tree, version, fetchBranch });
    await createBumpPullRequest({ github, prGithub, context, core, branch, base, version, recovery, sha, startCi });
  } catch (error) { failed(core, error); }
}

async function githubRelease({ github, context, core }) {
  const version = process.env.VERSION;
  const tag = `v${version}`;
  core.setOutput('tag_verified', 'false');
  try {
    context = withSource(context);
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Missing or invalid release version.');
    const runCommand = process.env.RUN_COMMAND;
    const published = (process.env.PUBLISHED_NAMES ?? '').split(',').filter(Boolean);
    if (!runCommand || !published.length) throw new Error('Missing published package names.');
    const metadata = releaseMetadata(version, published, runCommand);
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
    const body = resolveReleaseBody({ release, metadata, tag, context, version });
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
    expectVerifiableRelease(release, tag, body, context);
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
    `- npm publication: ${published ? `published \`${env.ROOT_NAME}@${env.VERSION}\` (including packages already published on an earlier attempt)` : 'dry run — nothing was published'}.`,
    `- Version-bump PR: ${published ? pr : 'skipped'}${env.PR_URL ? ` — ${env.PR_URL}` : ''}.`,
    `- Version-bump CI: ${published ? env.CI_STATUS || 'not requested' : 'skipped'}${env.CI_URL ? ` — ${env.CI_URL}` : ''}.`,
    `- GitHub Release: ${published ? release : 'skipped'}${env.RELEASE_URL ? ` — ${env.RELEASE_URL}` : ''}.`,
    `- Tag: ${published && env.TAG_VERIFIED === 'true' ? `verified \`v${env.VERSION}\` at the published source commit` : 'not confirmed at the published source commit'}.`,
  ];
  if (env.PR_REASON) lines.push('', `PR recovery: ${env.PR_REASON}`);
  if (env.CI_REASON) lines.push('', `CI recovery: ${env.CI_REASON}`);
  if (env.RELEASE_REASON) lines.push('', `Release recovery: ${env.RELEASE_REASON}`);
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

module.exports = { bumpPr, githubRelease, summary };
