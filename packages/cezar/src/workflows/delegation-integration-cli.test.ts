import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { buildDelegationCli } from './delegation-integration.testkit.ts';

it('keeps the source URL of each bundled CLI module for asset lookup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cez-cli-source-urls-'));
  let compiled: Awaited<ReturnType<typeof buildDelegationCli>> | undefined;
  try {
    const entry = join(directory, 'entry.ts');
    const dependency = join(directory, 'dependency.ts');
    writeFileSync(dependency, 'export const url = import.meta.url;');
    writeFileSync(entry, "import { url } from './dependency.ts'; console.log(JSON.stringify([import.meta.url, url]));");
    compiled = await buildDelegationCli(entry);
    const output = execFileSync(process.execPath, [compiled.entry], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual([pathToFileURL(entry).href, pathToFileURL(dependency).href]);
  } finally {
    compiled?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
