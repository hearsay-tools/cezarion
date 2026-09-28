import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Source override supports the red/green regression proof before the release build.
const cli = process.env.TEST_COCKPIT_SOURCE_CLI === '1' ? join(packageRoot, 'src/index.ts') : join(packageRoot, 'dist/index.js');

test('cockpit ownership rejects live duplicates, recovers after death, and isolates repositories', { timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-ownership-')));
  const children: ChildProcess[] = [];
  const repo = join(root, 'repo');
  const other = join(root, 'other');
  await mkdir(repo);
  await mkdir(other);
  for (const directory of [repo, other]) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'fixture'], { cwd: directory });
  }
  const start = (directory: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--repo', directory, '--port', '0', '--no-open'], {
      cwd: packageRoot,
      env: { ...process.env, CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1', CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTONAME: '0', CEZ_REMOTE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    return {
      child,
      async outcome() {
        for (let i = 0; i < 600; i++) {
          const url = output.match(/cockpit → (http:\/\/\S+)/)?.[1];
          if (url) return { url, code: null, output };
          if (child.exitCode !== null || child.signalCode !== null) return { url: undefined, code: child.exitCode, output };
          await new Promise((done) => setTimeout(done, 50));
        }
        throw new Error(`cockpit neither started nor exited: ${output}`);
      },
    };
  };
  const kill = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  };
  try {
    const first = start(repo);
    const live = await first.outcome();
    assert.ok(live.url, live.output);
    const duplicate = await start(repo).outcome();
    assert.equal(duplicate.code, 1, `second cockpit must refuse before boot: ${duplicate.output}`);
    assert.ok(duplicate.output.includes(live.url), duplicate.output);

    const alias = join(root, 'alias');
    await symlink(repo, alias, 'dir');
    const aliased = await start(alias).outcome();
    assert.equal(aliased.code, 1, aliased.output);
    assert.ok(aliased.output.includes(live.url), aliased.output);

    const different = await start(other).outcome();
    assert.ok(different.url, different.output);
    assert.notEqual(different.url, live.url);
    const registered = await fetch(`${live.url}/api/v1/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: other }),
    });
    const registration = await registered.json() as { project: { id: string } };
    assert.ok(registration.project?.id, JSON.stringify(registration));
    const secondary = await fetch(`${live.url}/api/v1/p/${registration.project.id}/runs`);
    assert.equal(secondary.status, 409);
    assert.ok((await secondary.text()).includes(different.url));
    assert.equal((await fetch(`${live.url}/api/v1/health`)).status, 200);

    await kill(first.child);
    const contenders = [start(repo), start(repo)];
    const outcomes = await Promise.all(contenders.map((item) => item.outcome()));
    assert.equal(outcomes.filter((item) => item.url).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter((item) => item.code === 1).length, 1, JSON.stringify(outcomes));
    const restarted = outcomes.find((item) => item.url)!;
    assert.ok(outcomes.find((item) => item.code === 1)!.output.includes(restarted.url!), JSON.stringify(outcomes));
    assert.equal((await fetch(`${restarted.url}/api/v1/health`)).status, 200);
  } finally {
    await Promise.all(children.map(kill));
    await rm(root, { recursive: true, force: true });
  }
});
