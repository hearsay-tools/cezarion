import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readNpmConfiguration, resolveNpmInvocation, runOwnedNpm } from './npm-process.ts';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('reports ownership loss when a lock abort follows npm timeout but precedes child exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-npm-timeout-abort-')); roots.push(root);
  const script = join(root, 'npm.cjs'); const ready = join(root, 'ready');
  writeFileSync(script, `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
process.on('SIGTERM',()=>{}); setInterval(()=>{},100);`);
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const run = runOwnedNpm(process.execPath, [script], {}, controller.signal);
  const reaped = run.catch(() => {});
  try {
    const readyDeadline = Date.now() + 2_000;
    while (Date.now() < readyDeadline && !existsSync(ready)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(existsSync(ready)).toBe(true);
    const pid = Number(readFileSync(ready, 'utf8'));
    await vi.advanceTimersByTimeAsync(120_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).rejects.toThrow('update lock ownership changed');
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await reaped;
    } finally {
      vi.useRealTimers();
    }
  }
});

// A Windows npm-cli fixture is a JS file, never an executable npm.cmd.
it('runs a verified npm-cli through Node with shell metacharacters kept in argument boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez npm & toolchain-')); roots.push(root);
  const npmRoot = join(root, 'node_modules/npm');
  mkdirSync(join(npmRoot, 'bin'), { recursive: true });
  writeFileSync(join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
  const cli = join(npmRoot, 'bin/npm-cli.js');
  const output = join(root, 'args.json');
  writeFileSync(cli, `require('node:fs').writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)))`);
  const args = ['install', '--prefix', 'C:\\Users\\A B & (C)\\npm', 'literal"quote', '%PATH%', '@wjarka/cezarion@2.0.0'];
  await runOwnedNpm(cli, [output, ...args], process.env);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(args);
});

function toolchain() {
  const root = mkdtempSync(join(tmpdir(), 'cez npm & Node-')); roots.push(root);
  const node = join(root, 'node.exe'); writeFileSync(node, 'fixture, not executed');
  const npmRoot = join(root, 'node_modules/npm');
  mkdirSync(join(npmRoot, 'bin'), { recursive: true });
  writeFileSync(join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
  const cli = join(npmRoot, 'bin/npm-cli.js'); writeFileSync(cli, '');
  return { root, node, npmRoot, cli };
}

it('selects the verified current Windows Node toolchain without executing npm.cmd or trusting npm_execpath', () => {
  const { node, cli } = toolchain();
  vi.stubEnv('npm_execpath', '/unrelated/untrusted-cli.js');
  expect(resolveNpmInvocation('npm', { nodeExecutable: node, platform: 'win32', searchPath: '' }))
    .toEqual({ command: node, args: [cli] });
});

it('resolves canonical Windows installer and generated shims on quoted PATH entries', () => {
  const { root, cli, npmRoot } = toolchain();
  const otherNode = join(root, 'other/node.exe'); mkdirSync(join(root, 'other')); writeFileSync(otherNode, 'fixture');
  const vendor = '@ECHO OFF\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n';
  writeFileSync(join(npmRoot, 'bin/npm.cmd'), vendor);
  for (const content of [vendor, 'SET dp0=%~dp0\r\n"%_prog%" "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n']) {
    writeFileSync(join(root, 'npm.cmd'), content);
    expect(resolveNpmInvocation('npm', { nodeExecutable: otherNode, platform: 'win32', searchPath: `"${root}"` }))
      .toEqual({ command: otherNode, args: [cli] });
  }
  writeFileSync(join(root, 'npm.cmd'), 'some custom wrapper');
  expect(() => resolveNpmInvocation('npm', { nodeExecutable: otherNode, platform: 'win32', searchPath: root })).toThrow('could not be verified');
});

it('resolves a POSIX canonical npm symlink through Node', () => {
  const { root, cli, node } = toolchain();
  symlinkSync(cli, join(root, 'npm'));
  expect(resolveNpmInvocation('npm', { nodeExecutable: node, platform: 'linux', searchPath: root }))
    .toEqual({ command: node, args: [cli] });
});

it('rejects absent or mismatched npm metadata and lets discovery degrade quietly', async () => {
  const { node, cli, npmRoot } = toolchain();
  writeFileSync(join(npmRoot, 'package.json'), '{"name":"unrelated","bin":{"npm":"bin/npm-cli.js"}}');
  expect(() => resolveNpmInvocation('npm', { nodeExecutable: node, platform: 'win32', searchPath: '' })).toThrow();
  expect(readNpmConfiguration(cli)).toBeUndefined();
  rmSync(npmRoot, { recursive: true });
  expect(readNpmConfiguration(cli)).toBeUndefined();
  await expect(runOwnedNpm(cli, [], process.env)).rejects.toThrow('could not be verified');
});

it('reads prefix and cache through the same Node invocation and inherits npm configuration unchanged', async () => {
  const { cli, root } = toolchain();
  const prefix = 'C:\\Users\\A B & (C)\\npm';
  const cache = 'C:\\Users\\A B & (C)\\cache';
  vi.stubEnv('npm_config_prefix', prefix); vi.stubEnv('npm_config_cache', cache);
  const record = join(root, 'invocations.jsonl');
  writeFileSync(cli, `const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n');
if(args[0]==='prefix')console.log(process.env.npm_config_prefix);
else if(args[0]==='config')console.log(process.env.npm_config_cache);`);
  const config = readNpmConfiguration(cli);
  expect(config).toEqual({ npmBin: cli, prefix, cache });
  const args = ['install', '--prefix', prefix, 'literal"quote & %PATH%', '@wjarka/cezarion@2.0.0'];
  await runOwnedNpm(config!.npmBin, args, process.env);
  expect(readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    .toEqual([['prefix', '-g'], ['config', 'get', 'cache'], args]);
});
