import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { productIdentity } from '../home/identity.ts';
import { withCompatibilityPackages } from '../release/compatibility.ts';
import { ApplicationUpdateService } from './service.ts';
import { runRestartWorkflow, type HelperPlan } from './helper.ts';
import { capturePlans, fixtureText, frozenUpdater, launchOriginalEntries, modulesAt, oldInstallation } from './legacy-entry-paths.testkit.ts';

const old = productIdentity(false), active = productIdentity(true);
const root = mkdtempSync(join(tmpdir(), 'legacy-entry-paths-'));
const version = '0.18.0';
let Frozen: typeof ApplicationUpdateService;
let validate: (plan: HelperPlan, expected: string) => void;
const trees: Record<string, string> = {};
const runtime = join(root, 'runtime');

beforeAll(async () => {
  const source = join(root, 'source');
  mkdirSync(join(source, 'web/dist/assets'), { recursive: true });
  writeFileSync(join(source, 'web/dist/index.html'), '<script src="/assets/app.js"></script>');
  writeFileSync(join(source, 'web/dist/assets/app.js'), 'real fixture asset');
  withCompatibilityPackages(source, { name: active.npmPackage, version }, packages => {
    for (const { dir, manifest } of Object.values(packages)) {
      trees[manifest.name] = join(root, manifest.name);
      cpSync(dir, trees[manifest.name]!, { recursive: true });
    }
  }, true);
  mkdirSync(join(runtime, 'dist'), { recursive: true });
  cpSync(join(source, 'web'), join(runtime, 'web'), { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: active.npmPackage, version, type: 'module',
    exports: { '.': './dist/index.js' }, dependencies: {}, bin: { hsq: 'dist/index.js' } }));
  // Execute the real dispatcher notice helper without booting the whole CLI for every entry.
  const command = pathToFileURL(join(process.cwd(), 'packages/cezar/src/home/command.ts')).href;
  writeFileSync(join(runtime, 'dist/index.js'), `import { oldCommandNotice } from ${JSON.stringify(command)};
const notice = oldCommandNotice(process.argv[1], true);
if (notice) console.error(notice);
console.log(JSON.stringify({workers:[]}));\n`);
  ({ ApplicationUpdateService: Frozen } = await frozenUpdater(root));
  const frozen = stripTypeScriptTypes(fixtureText('v0.17.0-promotion-validator.ts.txt'));
  ({ validateOriginal: validate } = await import(`data:text/javascript;base64,${Buffer.from(frozen).toString('base64')}`));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function copyPackage(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}
function installTrees(modules: string, alias: boolean, nested: boolean): void {
  const outer = join(modules, alias ? old.npmAlias : old.npmPackage);
  copyPackage(trees[alias ? old.npmAlias : old.npmPackage]!, outer);
  const dependencies = nested ? join(outer, 'node_modules') : modules;
  if (alias) copyPackage(trees[old.npmPackage]!, join(dependencies, old.npmPackage));
  copyPackage(runtime, join(dependencies, active.npmPackage));
}

const groups = [
  { alias: false, entries: ['dist/index.js', 'dist/hsq.js', 'dist/cez.js', 'dist/cezarion.js'], alternate: false },
  { alias: true, entries: ['bin.js'], alternate: false },
  { alias: true, entries: ['cezarion.js', 'cez.js', 'hsq.js', 'bin.js'], alternate: false },
  { alias: true, entries: ['bin.js'], alternate: true },
];
// bound: each fixture validates saved service records and launches several short Node children.
for (const windows of [false, true]) for (const kind of ['global', 'npx'] as const) for (const [index, group] of groups.entries()) {
  it(`${windows ? 'Windows' : 'POSIX'} ${kind} ${group.alias ? 'alias' : 'scoped'} entry group ${index}: old preparation, saved record and every launch path`, async () => {
    const id = `fixture${windows}${kind}${index}`;
    const cache = join(root, id, 'cache');
    const prefix = join(root, id, 'prefix');
    const consumer = kind === 'global' ? prefix : join(cache, '_npx', id);
    const nested = group.alternate ? kind !== 'global' : kind === 'global';
    const original = oldInstallation(consumer, kind, group.alias, group.entries, nested, !group.alternate, windows);
    const modules = modulesAt(consumer, kind, windows);
    let installs = 0;
    const options = { packageRoot: original.packageRoot, launchEntry: original.launchEntries[0]!, npmPrefix: prefix, npmCache: cache,
      home: join(root, id, 'home'), targetVersion: () => version, runNpm: async (args: string[]) => {
        installs++;
        expect(args.at(-1)).toBe(`${group.alias ? old.npmAlias : old.npmPackage}@${version}`);
        installTrees(join(args[args.indexOf('--prefix') + 1]!, 'node_modules'), group.alias, false);
      } };
    const plans = await capturePlans(options, original.launchEntries, Frozen, root, ApplicationUpdateService);
    expect(installs).toBe(1);
    expect(plans).toHaveLength(windows ? group.entries.length : group.entries.length + (group.alternate ? 0 : group.alias && index === 1 ? 2 : 3));
    let launched = false, success = false;
    const unexpected = async () => { assert.fail('fixture upgrade must not roll back'); };
    await runRestartWorkflow({ waitForOldExit: async () => {}, promote: async () => installTrees(modules, group.alias, nested),
      validateOriginal: async () => { for (const plan of plans) validate(plan, version); },
      launch: async () => { await launchOriginalEntries(plans, consumer, { ...process.env, NODE_NO_WARNINGS: '1' }); launched = true; },
      verifyHealth: async () => { expect(launched).toBe(true); }, reportSuccess: async () => { success = true; },
      reapReplacement: unexpected, restore: unexpected, launchPrevious: unexpected, reportFailure: unexpected,
    });
    expect(success).toBe(true);
    expect(JSON.parse(readFileSync(join(original.outer, 'package.json'), 'utf8')).version).toBe(version);
  }, 30_000);
}
