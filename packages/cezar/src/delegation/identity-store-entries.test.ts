import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// The ownership policy in workspace.ts has no store on Windows until a process entry installs one,
// and only entries may import the Windows store, so the policy's importers never load it
// (hearsay-tools/cezarion#3244, ADR 0032). A process entry is a package bin, a source module with
// a shebang or an `argv[1]` main guard, or a script under scripts/. The closure follows static and dynamic imports.
const pkg = join(import.meta.dirname, '../..');
const POLICY = 'src/delegation/workspace.ts';
// The Windows store and the native helper it wraps.
const WINDOWS = ['src/delegation/windows-identity-store.ts', 'src/delegation/windows-workspace-identity.ts'];
const INSTALL = /^installWindowsIdentityStore\(\);$/m;
const isTest = (file: string) => /\.test\.|\.testkit\.|\.d\.ts$/.test(file);

function sourceFiles(dir: string): string[] {
  return readdirSync(join(pkg, dir), { recursive: true, encoding: 'utf8' })
    .filter(name => /\.tsx?$/.test(name) && !isTest(name)).map(name => join(dir, name));
}
function processEntries(): string[] {
  const bins = Object.values((JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin)
    .map(bin => bin.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
  const guarded = sourceFiles('src').filter(file => /^#!|process\.argv\[1\][^\n]*import\.meta/.test(readFileSync(join(pkg, file), 'utf8')));
  const scripts = readdirSync(join(pkg, 'scripts')).filter(name => name.endsWith('.ts') && !isTest(name)).map(name => `scripts/${name}`);
  return [...new Set([...bins, ...guarded, ...scripts])].sort();
}
async function closures(files: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = await build({
    entryPoints: files.map(file => join(pkg, file)), absWorkingDir: pkg, bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', packages: 'external', outdir: join(pkg, '.closure'), logLevel: 'silent',
  });
  const byEntry = new Map<string, Set<string>>();
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    byEntry.set(relative(pkg, join(pkg, output.entryPoint)), new Set(Object.keys(output.inputs).map(input => relative(pkg, join(pkg, input)))));
  }
  return byEntry;
}

describe('workspace identity store installation', () => {
  it('installs a store in every process entry that reaches the ownership policy', async () => {
    const entries = processEntries();
    const byEntry = await closures(entries);
    const installers = new Set(entries.filter(file => INSTALL.test(readFileSync(join(pkg, file), 'utf8'))));
    const reaching = entries.filter(file => byEntry.get(file)?.has(POLICY));
    expect(reaching).toContain('src/index.ts');
    const missing = reaching.filter(file => ![...byEntry.get(file)!].some(input => installers.has(input)));
    expect(missing).toEqual([]);
  }, 60_000);

  it('keeps the Windows store out of every source module but the process entries', async () => {
    const entries = new Set(processEntries());
    const others = [...sourceFiles('src'), ...sourceFiles('scripts')].filter(file => !WINDOWS.includes(file) && !entries.has(file));
    const byFile = await closures(others);
    expect(others.filter(file => WINDOWS.some(store => byFile.get(file)?.has(store)))).toEqual([]);
  }, 60_000);
});
