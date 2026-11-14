import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

/** Emit only the typed probe as plain JavaScript for a child process. */
export async function emitProbe(source: URL, target: string): Promise<void> {
  const { code } = await transform(await readFile(source, 'utf8'), { loader: 'ts', format: 'esm', target: 'node24' });
  await writeFile(target, code);
}
