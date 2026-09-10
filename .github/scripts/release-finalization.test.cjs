const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const missing = () => Object.assign(new Error('Not Found'), { status: 404 });
const denied = () => Object.assign(new Error('GitHub Actions is not permitted to create or approve pull requests'), { status: 403 });

async function fixture(t, base = 'main') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'checkout');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git('init', '-b', base);
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.test');
  git('remote', 'add', 'origin', remote);
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  write('package.json', { name: 'release-fixture', private: true, workspaces: ['packages/*'] });
  const manifests = ['packages/cezar/package.json', 'packages/contract/package.json', 'packages/api-client/package.json', 'packages/web/package.json', 'alias-cezarion/package.json'];
  for (const [i, file] of manifests.entries()) write(file, { name: `fixture-${i}`, version: '0.12.0', private: i !== 0 });
  const npm = () => execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd, stdio: 'pipe' });
  npm();
  write('source.txt', 'the published source\n');
  git('add', '.');
  git('commit', '-m', 'source');
  git('push', 'origin', base);
  const sha = git('rev-parse', 'HEAD');
  const stamp = () => {
    for (const file of manifests) {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, file)));
      write(file, { ...pkg, version: '0.12.1' });
    }
  };
  stamp();
  const state = { prs: [], release: null, tag: null, denyPr: false, denyRelease: false, denyRead: false };
  const repo = { owner: 'example', repo: 'project' };
  const url = 'https://github.com/example/project';
  const github = {
    paginate: async (method, args) => (await method(args)).data,
    rest: {
      pulls: {
        list: async (args) => {
          assert.equal(args.owner, repo.owner);
          assert.equal(args.repo, repo.repo);
          assert.equal(args.state, 'all');
          assert.equal(args.head, 'example:release/v0.12.1');
          if (state.denyRead) throw denied();
          return { data: state.prs.filter((pr) => !args.base || pr.base.ref === args.base) };
        },
        create: async (args) => {
          if (state.denyPr) throw denied();
          assert.equal(args.base, base);
          assert.equal(args.head, 'release/v0.12.1');
          assert.equal(state.prs.filter((pr) => pr.base.ref === args.base).length, 0, 'must reuse the existing PR');
          const pr = { number: 1, html_url: `${url}/pull/1`, state: 'open', merged_at: null,
            head: { ref: args.head, sha: git('ls-remote', 'origin', `refs/heads/${args.head}`).split(/\s/)[0], repo: { full_name: 'example/project' } },
            base: { ref: args.base, repo: { full_name: 'example/project' } } };
          state.prs.push(pr);
          return { data: pr };
        },
      },
      repos: {
        getReleaseByTag: async () => {
          if (state.denyRead) throw denied();
          if (!state.release) throw missing();
          return { data: state.release };
        },
        createRelease: async (args) => {
          if (state.denyRelease) throw denied();
          assert.equal(state.release, null, 'must reuse the existing release');
          assert.equal(args.target_commitish, sha, 'tag the published source, never the bump commit');
          assert.equal(args.tag_name, 'v0.12.1');
          state.tag ??= { type: 'commit', sha };
          state.release = { ...args, id: 42, html_url: `${url}/releases/tag/v0.12.1` };
          return { data: state.release };
        },
      },
      git: {
        getRef: async ({ ref }) => {
          assert.equal(ref, 'tags/v0.12.1');
          if (state.denyRead) throw denied();
          if (!state.tag) throw missing();
          return { data: { object: state.tag } };
        },
        getTag: async ({ tag_sha }) => {
          assert.equal(tag_sha, 'annotated-tag');
          return { data: { object: { type: 'commit', sha } } };
        },
      },
    },
  };
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
  const outputs = { release: { version: '0.12.1', published: 'true', publishedNames: '@wjarka/cezarion,cezarion', aliasName: 'cezarion' } };
  const errors = [];
  const summary = path.join(dir, 'summary.md');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}');
  // Allows the same regression to execute the original shell step when the fix is removed.
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$DENY_PR" = "true" ]; then echo "GitHub Actions is not permitted to create or approve pull requests" >&2; exit 1; fi\necho https://github.com/example/project/pull/1\n', { mode: 0o755 });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });
if (process.env.RACE_BRANCH === 'true' && args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/release/v0.12.1' && !out.stdout.trim()) {
  execFileSync(${JSON.stringify(realGit)}, ['--git-dir', ${JSON.stringify(remote)}, 'update-ref', 'refs/heads/release/v0.12.1', ${JSON.stringify(sha)}]);
}
process.stdout.write(out.stdout ?? '');
process.stderr.write(out.stderr ?? '');
process.exit(out.status ?? 1);
`, { mode: 0o755 });
  const resolve = (text) => String(text).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
    if (expr === 'github.ref_name') return base;
    if (expr === 'github.token') return 'test-token';
    if (expr === 'inputs.bump') return outputs.bump ?? 'patch';
    const match = expr.match(/^steps\.([^.]+)\.outputs\.(.+)$/);
    if (match) return outputs[match[1]]?.[match[2]] ?? '';
    throw new Error(`Unsupported expression: ${expr}`);
  });
  const run = async (name) => {
    const step = workflow.jobs.release.steps.find((s) => s.name === name);
    assert.ok(step, `step ${name} exists`);
    const prior = process.cwd();
    const env = { ...process.env };
    const current = {};
    const core = {
      setOutput: (key, value) => { current[key] = String(value); },
      setFailed: (error) => { errors.push(String(error)); },
      warning: () => {}, info: () => {}, error: () => {},
    };
    try {
      process.chdir(cwd);
      Object.assign(process.env, {
        PATH: `${bin}${path.delimiter}${env.PATH}`, GITHUB_STEP_SUMMARY: summary,
        GITHUB_WORKSPACE: root, GITHUB_REF_NAME: base, DENY_PR: String(state.denyPr), RACE_BRANCH: String(state.raceBranch ?? false),
        GIT_AUTHOR_DATE: outputs.date ?? '2026-09-09T18:00:00Z',
        GIT_COMMITTER_DATE: outputs.date ?? '2026-09-09T18:00:00Z',
        ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, resolve(value)])),
      });
      if (step.run) execFileSync('bash', ['-e', '-c', resolve(step.run)], { cwd, env: process.env, stdio: 'pipe' });
      else await new AsyncFunction('github', 'context', 'core', 'require', step.with.script)(github, { repo, sha, serverUrl: 'https://github.com' }, core, createRequire(path.join(root, 'package.json')));
    } finally {
      if (step.id) outputs[step.id] = current;
      process.chdir(prior);
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      Object.assign(process.env, env);
    }
    return current;
  };
  const reset = () => { git('checkout', '--detach', '-f', sha); if (git('branch', '--list', 'release/v0.12.1')) git('branch', '-D', 'release/v0.12.1'); stamp(); outputs.date = '2026-09-09T20:00:00Z'; };
  return { run, reset, git, write, npm, sha, state, outputs, errors, summary, workflow, remote };
}
const bumpStep = 'Open version-bump PR (patch/minor/major only)';
const releaseStep = 'Create GitHub Release';
const summaryStep = 'Write workflow summary';

test('retry after a pushed branch and denied PR reuses the original commit', async (t) => {
  const f = await fixture(t);
  f.state.denyPr = true;
  await f.run(bumpStep).catch(() => {});
  const pushed = f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1');
  assert.ok(pushed);
  f.reset();
  f.state.denyPr = false;
  await f.run(bumpStep);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1'), pushed);
  assert.equal(f.outputs.bump_pr.status, 'created');
  assert.equal(f.state.prs.length, 1);
  const head = pushed.split(/\s/)[0];
  for (const file of ['packages/cezar/package.json', 'packages/contract/package.json', 'packages/api-client/package.json', 'packages/web/package.json', 'alias-cezarion/package.json']) {
    assert.equal(JSON.parse(f.git('show', `${head}:${file}`)).version, '0.12.1');
  }
  const lock = JSON.parse(f.git('show', `${head}:package-lock.json`));
  for (const name of ['cezar', 'contract', 'api-client', 'web']) assert.equal(lock.packages[`packages/${name}`].version, '0.12.1');
  f.reset();
  await f.run(bumpStep);
  assert.equal(f.outputs.bump_pr.status, 'reused');
  assert.equal(f.state.prs.length, 1);
  assert.equal(f.git('rev-parse', 'HEAD'), f.sha);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], f.sha);
});

test('conflicting remote contents stay untouched and identify manual recovery', async (t) => {
  const f = await fixture(t);
  f.write('source.txt', 'someone else changed this\n');
  f.git('add', '.'); f.git('commit', '-m', 'conflicting work');
  f.git('push', 'origin', 'HEAD:refs/heads/release/v0.12.1');
  const before = f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1');
  f.reset();
  await f.run(bumpStep);
  assert.equal(f.outputs.bump_pr.status, 'failed');
  assert.match(f.errors.join('\n'), /conflict/i);
  assert.match(f.errors.join('\n'), /https:\/\/github.com\/example\/project\/compare\//);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1'), before);
  assert.equal(f.state.prs.length, 0);
});

test('PR permission failure leaves release finalization available and reports each outcome', async (t) => {
  const f = await fixture(t);
  f.state.denyPr = true;
  await f.run(bumpStep);
  assert.equal(f.outputs.bump_pr.status, 'failed');
  assert.match(f.errors.join('\n'), /pull-requests: write/);
  assert.match(f.errors.join('\n'), /Allow GitHub Actions to create and approve pull requests/);
  assert.match(f.errors.join('\n'), /https:\/\/github.com\/example\/project\/compare\/main\.\.\.release%2Fv0\.12\.1\?expand=1/);
  const step = f.workflow.jobs.release.steps.find((s) => s.name === releaseStep);
  assert.match(step.if, /!cancelled\(\)|always\(\)/, 'release must override the implicit success gate');
  await f.run(releaseStep);
  await f.run(summaryStep);
  const summary = fs.readFileSync(f.summary, 'utf8');
  assert.match(summary, /npm publication.*published/i);
  assert.match(summary, /Version-bump PR.*failed/i);
  assert.match(summary, /GitHub Release.*created/i);
  assert.match(summary, /Tag.*verified/i);
  assert.equal(f.state.tag.sha, f.sha);
});

test('repeated GitHub finalization reuses the matching release and annotated tag', async (t) => {
  const f = await fixture(t);
  await f.run(releaseStep);
  const original = structuredClone(f.state.release);
  f.state.tag = { type: 'tag', sha: 'annotated-tag' };
  await f.run(releaseStep);
  assert.equal(f.outputs.github_release.status, 'reused');
  assert.deepEqual(f.state.release, original);
  assert.match(original.body, /\| `@wjarka\/cezarion` \| `0.12.1` \|/);
  assert.match(original.body, /npx cezarion@0.12.1/);
  assert.doesNotMatch(original.body, /api-client/);
});

test('a conflicting tag blocks release creation without overwriting it', async (t) => {
  const f = await fixture(t);
  f.state.tag = { type: 'commit', sha: 'f'.repeat(40) };
  await f.run(releaseStep);
  assert.equal(f.outputs.github_release.status, 'failed');
  assert.equal(f.state.release, null);
  assert.equal(f.state.tag.sha, 'f'.repeat(40));
  await f.run(summaryStep);
  assert.doesNotMatch(fs.readFileSync(f.summary, 'utf8'), /tagged|Tag[^\n]*verified/i);
});

test('a release with conflicting metadata is not silently accepted or changed', async (t) => {
  const f = await fixture(t);
  await f.run(releaseStep);
  f.state.release.body = 'belongs to another publication';
  const before = structuredClone(f.state.release);
  await f.run(releaseStep);
  assert.equal(f.outputs.github_release.status, 'failed');
  assert.deepEqual(f.state.release, before);
});

test('release failure never claims a tag exists based only on npm success', async (t) => {
  const f = await fixture(t);
  f.state.denyRelease = true;
  await f.run(releaseStep);
  await f.run(summaryStep);
  const summary = fs.readFileSync(f.summary, 'utf8');
  assert.match(summary, /npm publication.*published/i);
  assert.match(summary, /GitHub Release.*failed/i);
  assert.doesNotMatch(summary, /tagged|Tag[^\n]*verified/i);
});

test('an unavailable lookup fails closed instead of creating new GitHub objects', async (t) => {
  const f = await fixture(t);
  f.state.denyRead = true;
  await f.run(bumpStep);
  await f.run(releaseStep);
  assert.equal(f.outputs.bump_pr.status, 'failed');
  assert.equal(f.outputs.github_release.status, 'failed');
  assert.equal(f.state.prs.length, 0);
  assert.equal(f.state.release, null);
});

test('maintenance release PR targets the dispatched branch', async (t) => {
  const f = await fixture(t, 'release/0.12.x');
  await f.run(bumpStep);
  assert.equal(f.state.prs[0].base.ref, 'release/0.12.x');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release/0.12.x').split(/\s/)[0], f.sha);
});

test('dry-run and skipped finalization summaries make no completion claims', async (t) => {
  const f = await fixture(t);
  f.outputs.release.published = 'false';
  await f.run(summaryStep);
  const summary = fs.readFileSync(f.summary, 'utf8');
  assert.match(summary, /dry run/i);
  assert.doesNotMatch(summary, /tagged|Tag[^\n]*verified|GitHub Release[^\n]*(created|reused)/i);
});

test('a merged PR whose branch was deleted is reused without resurrecting it', async (t) => {
  const f = await fixture(t);
  await f.run(bumpStep);
  f.state.prs[0].state = 'closed';
  f.state.prs[0].merged_at = '2026-09-09T19:00:00Z';
  f.git('push', 'origin', ':refs/heads/release/v0.12.1');
  f.reset();
  await f.run(bumpStep);
  assert.equal(f.outputs.bump_pr.status, 'reused');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1'), '');
  assert.equal(f.state.prs.length, 1);
});

test('a closed unmerged PR is reported for manual recovery without another PR', async (t) => {
  const f = await fixture(t);
  await f.run(bumpStep);
  f.state.prs[0].state = 'closed';
  f.reset();
  await f.run(bumpStep);
  assert.equal(f.outputs.bump_pr.status, 'failed');
  assert.equal(f.state.prs.length, 1);
});

test('an identical tree from a different source commit is a conflict', async (t) => {
  const f = await fixture(t);
  f.git('commit', '--allow-empty', '-m', 'different source');
  f.npm();
  f.git('add', '.'); f.git('commit', '-m', 'same bump contents');
  f.git('push', 'origin', 'HEAD:refs/heads/release/v0.12.1');
  const before = f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1');
  f.reset();
  await f.run(bumpStep);
  assert.equal(f.outputs.bump_pr.status, 'failed');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1'), before);
});

test('existing version finalization needs no bump PR and can reuse a source tag', async (t) => {
  const f = await fixture(t);
  f.outputs.bump = 'existing';
  f.state.tag = { type: 'commit', sha: f.sha };
  await f.run(releaseStep);
  await f.run(summaryStep);
  assert.equal(f.outputs.github_release.status, 'created');
  assert.equal(f.state.prs.length, 0);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1'), '');
  assert.match(fs.readFileSync(f.summary, 'utf8'), /Version-bump PR: not needed/);
});

test('a branch created concurrently at the source commit is not fast-forwarded', async (t) => {
  const f = await fixture(t);
  f.state.raceBranch = true;
  await f.run(bumpStep);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release/v0.12.1').split(/\s/)[0], f.sha, f.errors.join('\n'));
  assert.equal(f.outputs.bump_pr.status, 'failed');
  assert.equal(f.state.prs.length, 0);
});

test('a bump PR targeting a different base is a conflict, not a second PR', async (t) => {
  const f = await fixture(t);
  await f.run(bumpStep);
  f.state.prs[0].base.ref = 'develop';
  f.reset();
  await f.run(bumpStep);
  assert.equal(f.state.prs.length, 1);
  assert.equal(f.outputs.bump_pr.status, 'failed');
});
