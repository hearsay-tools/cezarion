import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measurementEnabled, recordGeneratedSource } from '../../../../.ai/skills/check-code-quality/scripts/source-snapshots.mjs';

/** Emit only the typed probe. Measurement maps contain fixture code, never application code. */
export async function emitProbe(source: URL, target: string): Promise<void> {
  const { code } = await transform(await readFile(source, 'utf8'), {
    loader: 'ts', format: 'esm', target: 'node24',
    ...(measurementEnabled() ? { sourcemap: 'inline' as const, sourcefile: fileURLToPath(source) } : {}),
  });
  recordGeneratedSource(pathToFileURL(target).href, code);
  await writeFile(target, code);
}
