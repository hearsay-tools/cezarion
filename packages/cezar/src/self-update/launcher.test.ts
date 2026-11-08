import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Home } from '../home/home.ts';
import { BINARY_NAMES } from '../home/identity.ts';
import { posixLauncher, windowsLauncher, writeLaunchers } from './launcher.ts';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'named-launcher-'));
  roots.push(root);
  return Home.sandbox(root);
}

it('writes all binary launchers and generates Windows named-entry fallback', () => {
  const home = sandbox();
  const dir = writeLaunchers({}, home);
  for (const name of BINARY_NAMES) {
    const script = readFileSync(join(dir, name + (process.platform === 'win32' ? '.cmd' : '')), 'utf8');
    expect(script).toContain(`${name}.js`);
    expect(script).toContain('index.js');
    const windows = windowsLauncher({}, home, name);
    expect(windows).toContain(`if exist "${join(home.data, 'versions', 'current', 'node_modules', '@wjarka', 'cezarion', 'dist', `${name}.js`)}"`);
    expect(windows).toContain(`node "${join(home.data, 'versions', 'current', 'node_modules', '@wjarka', 'cezarion', 'dist', 'index.js')}" %*`);
    expect(windows).toContain('\r\n');
  }
});

it.skipIf(process.platform === 'win32')('executes the matching named entry, then falls back for an older installed version', () => {
  const home = sandbox();
  const dist = join(home.data, 'versions/current/node_modules/@wjarka/cezarion/dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), 'console.log(JSON.stringify({entry:process.argv[1],args:process.argv.slice(2)}));');
  const dir = writeLaunchers({}, home);
  for (const name of BINARY_NAMES) {
    const entry = join(dist, `${name}.js`);
    writeFileSync(entry, 'import "./index.js";');
    const args = ['automation', 'schema', 'space and $() `literal`'];
    expect(JSON.parse(execFileSync(join(dir, name), args, { encoding: 'utf8' }))).toEqual({ entry, args });
    rmSync(entry);
    expect(JSON.parse(execFileSync(join(dir, name), args, { encoding: 'utf8' }))).toEqual({ entry: join(dist, 'index.js'), args });
  }
});

it.skipIf(process.platform === 'win32')('keeps the use escape hatch silent when the active build has no notice entry or Node is absent', () => {
  const home = sandbox();
  const entry = join(home.data, 'versions/old/node_modules/@wjarka/cezarion/dist/index.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '');
  for (const name of BINARY_NAMES) {
    const script = join(home.root, name);
    writeFileSync(script, posixLauncher({}, home, name));
    const result = execFileSync('sh', ['-c', 'exec sh "$1" use old 2>&1', 'test', script], { encoding: 'utf8' });
    expect(result).not.toContain('is deprecated');
    expect(result).toContain('now using old');
  }
  const tools = join(home.root, 'tools');
  mkdirSync(tools);
  symlinkSync('/bin/ln', join(tools, 'ln'));
  writeFileSync(join(dirname(entry), 'use-command-notice.js'), 'throw new Error("must not start without Node");');
  const script = join(home.root, 'cez');
  const withoutNode = execFileSync('/bin/sh', [script, 'use', 'old'], { encoding: 'utf8', env: { PATH: tools } });
  expect(withoutNode).toContain('now using old');
});
