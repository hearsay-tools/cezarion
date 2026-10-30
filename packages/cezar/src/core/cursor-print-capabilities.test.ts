import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectCursorPrintCapabilities } from './cursor-print-capabilities.ts';
import { cursorArgs, resetCursorAutoUpdateFlagCache } from './cursor-cli-flags.ts';
import { CORE_CURSOR_PRINT_TOOLS } from './cursor-print-tool-catalog.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetCursorAutoUpdateFlagCache();
});

/** The live `Expected one of:` list of 2026.10.16-e3cb207, captured 2026-10-19. */
const TOOLS_2026_10_16 = readFileSync(new URL('./__fixtures__/cursor/print-tools-2026.10.16-e3cb207.txt', import.meta.url), 'utf8')
  .split(',').map(name => name.trim()).filter(Boolean);
const QUALIFIED_TOOLS = TOOLS_2026_10_16;

function bin(version: string, catalog?: string, fail = false, rejectFlag = false): { path: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-cursor-cap-')); dirs.push(dir);
  const path = join(dir, 'agent');
  const log = join(dir, 'argv.ndjson');
  const names = catalog ?? QUALIFIED_TOOLS.join(', ');
  // Commander ignores unknown options before --version, as the real CLI does.
  writeFileSync(path, `#!/usr/bin/env node\nconst fs=require('node:fs');let a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0)} if(a.includes('--disable-auto-update')){if(${rejectFlag}){console.error("error: unknown option '--disable-auto-update'");process.exit(1)}a=a.filter(x=>x!=='--disable-auto-update')} if(${fail})process.exit(2); if(a[0]==='acp'){require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:1}:{models:[]}}))});return} if(a[0]==='--list-models'){if(process.env.CEZ_TEST_ACCOUNT!=='scoped')process.exit(3);console.log('Available models\\nmodel-a - Model A (default)\\nmodel-a-low - Model A Low');process.exit(0)} if(a.includes('__cezar_probe_invalid__')){if(!a.includes('--trust')||!a.includes('--force')){console.error('Workspace Trust Required');process.exit(1)}console.error(${JSON.stringify(`Invalid --allowed-tools value(s): __cezar_probe_invalid__. Expected one of: ${names}`)});process.exit(1)} process.exit(0);\n`);
  chmodSync(path, 0o700);
  return { path, log };
}
const argv = (log: string): string[][] => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);

const spec = { cwd: '/tmp', userPrompt: 'hello', toolGrant: UNSET_TOOL_GRANT };
describe('Cursor print capability preflight', () => {
  // hearsay-tools/cezarion#2279: print sends no tool allowlist, so the preflight returns none.
  it('accepts the originally qualified build', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342').path, spec))
      .resolves.toEqual({ supported: true });
  });
  it('accepts an unknown newer build whatever native entries it adds or removes', async () => {
    const catalog = [...QUALIFIED_TOOLS.filter(name => name !== 'web_search_tool_call'), 'spawn_swarm_tool_call'];
    await expect(inspectCursorPrintCapabilities(bin('2027.03.14-0a1b2c3', catalog.join(', ')).path, spec))
      .resolves.toEqual({ supported: true });
  });
  it('reports a build older than the qualified baseline as unsupported before inference', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.09.01-old').path, spec)).resolves.toMatchObject({ supported: false });
  });
  it('reports an unrecognized version format as unsupported', async () => {
    await expect(inspectCursorPrintCapabilities(bin('cursor-agent 3.1.0').path, spec)).resolves.toMatchObject({ supported: false });
  });
  it('reports a build without a core tool as unsupported', async () => {
    const catalog = QUALIFIED_TOOLS.filter(name => name !== CORE_CURSOR_PRINT_TOOLS[0]);
    await expect(inspectCursorPrintCapabilities(bin('2026.10.20-abc1234', catalog.join(', ')).path, spec))
      .resolves.toMatchObject({ supported: false, reason: expect.stringContaining(CORE_CURSOR_PRINT_TOOLS[0]) });
  });
  it('passes --disable-auto-update to every preflight process', async () => {
    const fake = bin('2026.10.01-e373342');
    await inspectCursorPrintCapabilities(fake.path, { ...spec, effort: 'low', env: { CEZ_TEST_ACCOUNT: 'scoped' } });
    const calls = argv(fake.log);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call[0]).toBe('--disable-auto-update');
  });
  it('still qualifies a build that rejects --disable-auto-update, and later launches omit it', async () => {
    const fake = bin('2026.10.01-e373342', undefined, false, true);
    await expect(inspectCursorPrintCapabilities(fake.path, spec)).resolves.toMatchObject({ supported: true });
    const probes = argv(fake.log).filter(call => call.includes('__cezar_probe_invalid__'));
    expect(probes.map(call => call.includes('--disable-auto-update'))).toEqual([true, false]);
    expect(cursorArgs(fake.path, ['acp'])).toEqual(['acp']);
  });
  it('does not infer on ambiguous discovery output', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342', 'unknown', true).path, spec)).rejects.toThrow(/capability preflight/i);
  });
  it('reads the selected account model catalog before an effort pin', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342').path, { ...spec, effort: 'low', env: { CEZ_TEST_ACCOUNT: 'scoped' } }))
      .resolves.toMatchObject({ supported: true, model: 'model-a', models: [{ id: 'model-a' }, { id: 'model-a-low' }] });
  });
  it('rejects an unknown explicit model before launching inference', async () => {
    await expect(inspectCursorPrintCapabilities(bin('2026.10.01-e373342').path, { ...spec, model: 'not-listed', env: { CEZ_TEST_ACCOUNT: 'scoped' } }))
      .rejects.toThrow(/not advertised/);
  });
});
