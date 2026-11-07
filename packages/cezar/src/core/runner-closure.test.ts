import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';

// A test that drives one runner loads that runner's adapter and none of the other five, so an
// edit to one adapter reruns only its own per-runner tests (hearsay-tools/cezarion#2939). The
// closure is every module the file reaches through static and dynamic imports.
const src = join(import.meta.dirname, '..');
const ADAPTERS: Record<RunnerId, string> = {
  claude: 'core/claude-cli-runner.ts', codex: 'core/codex-app-server-runner.ts', opencode: 'core/opencode-server-runner.ts',
  cursor: 'core/cursor-runner.ts', pi: 'core/pi-runner.ts', omp: 'core/omp-runner.ts',
};
const PER_RUNNER = new RegExp(`^(?:harness|waits)-(${RUNNER_IDS.join('|')})-.*-parity\\.test\\.ts$`);

function perRunnerFiles(): Array<{ file: string; runner: RunnerId }> {
  return ['core', 'workflows'].flatMap(dir => readdirSync(join(src, dir)).flatMap(name => {
    const runner = PER_RUNNER.exec(name)?.[1] as RunnerId | undefined;
    return runner ? [{ file: `${dir}/${name}`, runner }] : [];
  }));
}

/** Each entry's closure, as `src`-relative paths. */
async function closures(files: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = await build({
    entryPoints: files.map(file => join(src, file)), absWorkingDir: src, bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', packages: 'external', outdir: join(src, '.closure'), logLevel: 'silent',
  });
  const byEntry = new Map<string, Set<string>>();
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    byEntry.set(relative(src, join(src, output.entryPoint)), new Set(Object.keys(output.inputs).map(input => relative(src, join(src, input)))));
  }
  return byEntry;
}

describe('per-runner test closures', () => {
  it('hold their own adapter and no other runner adapter or the production factory', async () => {
    const files = perRunnerFiles();
    expect(new Set(files.map(entry => entry.runner))).toEqual(new Set(RUNNER_IDS));
    const byEntry = await closures(files.map(entry => entry.file));
    const loaded = files.map(({ file, runner }) => {
      const closure = byEntry.get(file) ?? new Set();
      return { file, own: closure.has(ADAPTERS[runner]), others: [...RUNNER_IDS.filter(id => id !== runner && closure.has(ADAPTERS[id])), ...(closure.has('core/runner-factory.ts') ? ['factory'] : [])] };
    });
    expect(loaded.filter(entry => !entry.own || entry.others.length)).toEqual([]);
  }, 60_000);
});
