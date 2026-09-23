import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ApplicationUpdateService, type RestartPlan } from './service.ts';
import { promoteOriginal, restoreOriginal, runRestartWorkflow, type HelperPlan } from './helper.ts';
import { readNpmConfiguration } from './npm-process.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Real Node child processes, simulated Windows npm layout. This is not native
// cmd.exe/PowerShell proof; on POSIX we also execute the restored shell launcher.
it.each(['direct', 'nested alias', 'hoisted alias'] as const)('restores Windows global %s launchers byte-for-byte after failed promotion', async (layout) => {
  const outerPackage = layout === 'direct' ? '@wjarka/cezarion' : 'cezarion';
  const root = mkdtempSync(join(tmpdir(), 'cez Windows & prefix-')); roots.push(root);
  const prefix = join(root, 'npm prefix'); const home = join(root, 'home'); const cache = join(root, 'npm cache');
  const outer = join(prefix, 'node_modules', outerPackage);
  const original = layout === 'hoisted alias' ? join(prefix, 'node_modules/@wjarka/cezarion')
    : outerPackage === 'cezarion' ? join(outer, 'node_modules/@wjarka/cezarion') : outer;
  mkdirSync(outer, { recursive: true });
  mkdirSync(join(original, 'dist'), { recursive: true });
  mkdirSync(join(original, 'web/dist'), { recursive: true });
  writeFileSync(join(original, 'dist/index.js'), 'console.log("old command works")');
  writeFileSync(join(original, 'web/dist/index.html'), 'old');
  const bins = { cez: 'dist/index.js', cezarion: 'dist/index.js' };
  writeFileSync(join(original, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.0.0', bin: bins, dependencies: {} }));
  if (outerPackage === 'cezarion') {
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'cezarion', version: '1.0.0', bin: { cez: 'bin.js', cezarion: 'bin.js' }, dependencies: { '@wjarka/cezarion': '1.0.0' } }));
    writeFileSync(join(outer, 'bin.js'), "require('@wjarka/cezarion/dist/index.js');");
  }
  const commandEntry = outerPackage === 'cezarion' ? join(outer, 'bin.js') : join(original, 'dist/index.js');
  const target = relative(prefix, commandEntry);
  const saved = new Map<string, Buffer>();
  for (const name of Object.keys(bins)) for (const suffix of ['', '.cmd', '.ps1']) {
    if (name === 'cez' && suffix === '.ps1') continue; // Must restore absence too.
    const path = join(prefix, name + suffix);
    const content = suffix === '.cmd' ? `@echo off\r\nnode "%~dp0%${target.replaceAll('/', '\\')}" %*\r\n`
      : suffix === '.ps1' ? `& node "$PSScriptRoot/${target}" $args\r\n`
      : `#!/bin/sh\nbasedir=$(dirname "$0")\nexec "${process.execPath}" "$basedir/${target}" "$@"\n`;
    const bytes = Buffer.from(content);
    writeFileSync(path, bytes, { mode: 0o755 }); saved.set(path, bytes);
  }
  // An npm-cli fixture executes the real discovery, staging and promotion seams
  // without touching a supervising npm install, cache, or registry.
  const npmRoot = join(root, 'toolchain/node_modules/npm'); const calls = join(root, 'calls.jsonl');
  mkdirSync(join(npmRoot, 'bin'), { recursive: true });
  writeFileSync(join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
  const cli = join(npmRoot, 'bin/npm-cli.js');
  writeFileSync(cli, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,cache:process.env.npm_config_cache})+'\\n');
if(args[0]==='prefix') console.log(${JSON.stringify(prefix)});
else if(args[0]==='config') console.log(${JSON.stringify(cache)});
else if(args.includes('--global')) {
  for(const name of ['cez','cezarion'])for(const suffix of ['', '.cmd', '.ps1'])fs.rmSync(path.join(${JSON.stringify(prefix)},name+suffix),{force:true});
  fs.writeFileSync(${JSON.stringify(join(prefix, 'cez.cmd'))},'broken');
  fs.writeFileSync(${JSON.stringify(join(prefix, 'cez.ps1'))},'new unwanted launcher');
  fs.rmSync(${JSON.stringify(outer)},{recursive:true});
  fs.rmSync(${JSON.stringify(original)},{recursive:true,force:true}); process.exit(1);
} else {
  const stage=args[args.indexOf('--prefix')+1];
  const nextOuter=path.join(stage,'node_modules',${JSON.stringify(outerPackage)});
  fs.cpSync(${JSON.stringify(outer)},nextOuter,{recursive:true});
  if (${layout === 'hoisted alias'}) fs.cpSync(${JSON.stringify(original)},path.join(nextOuter,'node_modules/@wjarka/cezarion'),{recursive:true});
  const next=${outerPackage === 'cezarion' ? "path.join(nextOuter,'node_modules/@wjarka/cezarion')" : 'nextOuter'};
  for(const root of new Set([next,nextOuter])) {
    const file=path.join(root,'package.json'), pkg=JSON.parse(fs.readFileSync(file));
    pkg.version='2.0.0';fs.writeFileSync(file,JSON.stringify(pkg));
  }
}`);
  const npm = readNpmConfiguration(cli);
  expect(npm).toEqual({ npmBin: cli, prefix, cache });
  let restart: RestartPlan | undefined;
  const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: commandEntry, npmPrefix: npm!.prefix,
    npmCache: npm!.cache, npmBin: npm!.npmBin, home, targetVersion: () => '2.0.0', armRestart: async plan => { restart = plan; } });
  expect((await service.apply()).status).toBe('ready');
  await service.restart();
  const plan: HelperPlan = { ...restart!, oldPid: -1, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [], cwd: root,
    repoRoot: root, host: '127.0.0.1', port: 12345, npmBin: npm!.npmBin };
  let rollbackFailed: boolean | undefined;
  await runRestartWorkflow({
    waitForOldExit: async () => {}, promote: () => promoteOriginal(plan),
    validateOriginal: async () => {}, launch: async () => {}, verifyHealth: async () => {}, reapReplacement: async () => {},
    restore: () => restoreOriginal(plan),
    launchPrevious: async () => { expect(execFileSync(process.execPath, [plan.installation.launchEntry], { encoding: 'utf8' }).trim()).toBe('old command works'); },
    reportSuccess: async () => { throw new Error('unexpected success'); },
    reportFailure: async failed => { rollbackFailed = failed; },
  });
  expect(rollbackFailed).toBe(false);
  for (const [path, bytes] of saved) expect(readFileSync(path)).toEqual(bytes);
  expect(existsSync(join(prefix, 'cez.ps1'))).toBe(false);
  if (process.platform !== 'win32') {
    for (const name of Object.keys(bins)) expect(execFileSync('sh', [join(prefix, name)], { encoding: 'utf8' }).trim()).toBe('old command works');
  }
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(invocations.map(call => call.args)).toEqual([
    ['prefix', '-g'], ['config', 'get', 'cache'],
    ['install', '--prefix', restart!.stage, '--engine-strict', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-online', '--fetch-retries=1', `${outerPackage}@2.0.0`],
    ['install', '--global', '--prefix', prefix, '--engine-strict', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-online', '--fetch-retries=1', `${outerPackage}@2.0.0`],
  ]);
  expect(invocations.slice(2).map(call => call.cache)).toEqual([cache, cache]);
  const dir = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!);
  if (process.platform !== 'win32') expect(statSync(join(dir, 'bin-links.json')).mode & 0o777).toBe(0o600);
});
