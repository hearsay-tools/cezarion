import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectCursorPrintCapabilities } from './cursor-print-capabilities.ts';
import { SAFE_CURSOR_PRINT_TOOLS, NATIVE_CURSOR_DELEGATION_TOOLS } from './cursor-print-tool-catalog.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function bin(version: string, catalog?: string, fail = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-cursor-cap-')); dirs.push(dir);
  const path = join(dir, 'agent');
  const names = catalog ?? [...SAFE_CURSOR_PRINT_TOOLS, ...NATIVE_CURSOR_DELEGATION_TOOLS].join(', ');
  writeFileSync(path, `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a[0]==='--version'){console.log(${JSON.stringify(version)});process.exit(0)} if(${fail})process.exit(2); if(a[0]==='--list-models'){if(process.env.CEZ_TEST_ACCOUNT!=='scoped')process.exit(3);console.log('Available models\\nmodel-a - Model A (default)\\nmodel-a-low - Model A Low');process.exit(0)} if(a.includes('__cezar_probe_invalid__')){console.error(${JSON.stringify(`Invalid --allowed-tools value(s): __cezar_probe_invalid__. Expected one of: ${names}`)});process.exit(1)} process.exit(0);\n`);
  chmodSync(path, 0o700);
  return path;
}

const spec = { cwd: '/tmp', userPrompt: 'hello' };
describe('Cursor print capability preflight', () => {
  it('accepts only the qualified version and exact native tool catalog', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342'), spec)).resolves.toEqual({ supported: true });
  });
  it('reports an older build as unsupported before inference', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.09.01-old'), spec)).resolves.toMatchObject({ supported: false });
  });
  it('rejects an added native tool entry', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342', [...SAFE_CURSOR_PRINT_TOOLS, ...NATIVE_CURSOR_DELEGATION_TOOLS, 'new_tool_call'].join(', ')), spec)).resolves.toMatchObject({ supported: false });
  });
  it('does not infer on ambiguous discovery output', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342', 'unknown', true), spec)).rejects.toThrow(/capability preflight/i);
  });
  it('reads the selected account model catalog before an effort pin', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342'), { ...spec, effort: 'low', env: { CEZ_TEST_ACCOUNT: 'scoped' } }))
      .resolves.toMatchObject({ supported: true, model: 'model-a', models: [{ id: 'model-a' }, { id: 'model-a-low' }] });
  });
  it('rejects an unknown explicit model before launching inference', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342'), { ...spec, model: 'not-listed', env: { CEZ_TEST_ACCOUNT: 'scoped' } }))
      .rejects.toThrow(/not advertised/);
  });
});
