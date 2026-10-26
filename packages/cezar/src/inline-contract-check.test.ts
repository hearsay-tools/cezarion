import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The postbuild step on a fixture dist: it bundles the real contract, so a fixture file stands
// in for a compiled service module. hearsay-tools/cezarion#1431: a subpath import of a name the
// bundle lacks passed every gate and failed only when the built CLI started.
const script = fileURLToPath(new URL('../scripts/inline-contract.mjs', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inline(files: Record<string, string>): { dist: string; status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-inline-contract-'));
  roots.push(root);
  const dist = join(root, 'dist');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, name)), { recursive: true });
    writeFileSync(join(dist, name), text);
  }
  const result = spawnSync(process.execPath, [script, dist], { encoding: 'utf8' });
  return { dist, status: result.status, stderr: result.stderr };
}

describe('inline-contract fails the build on a contract import the bundle lacks (hearsay-tools/cezarion#1431)', () => {
  it('names a subpath import of a name the bundle does not export, and repoints nothing', () => {
    // `ask-schema` reaches the bundle only through `ask.ts`'s named re-export, as in #1429.
    const source = "import { ASK_LIMITS, notAContractExport } from '@open-mercato/cezar-contract/ask-schema';\n"
      + 'export const limits = [ASK_LIMITS, notAContractExport];\n';
    const { dist, status, stderr } = inline({ 'server/ask.js': source });

    expect(status, stderr).toBe(1);
    expect(stderr).toContain(
      'dist/server/ask.js:1 imports "notAContractExport" from "@open-mercato/cezar-contract/ask-schema"',
    );
    expect(stderr, 'a name the bundle exports is not a gap').not.toContain('"ASK_LIMITS"');
    expect(readFileSync(join(dist, 'server/ask.js'), 'utf8')).toBe(source);
  });

  it('names a namespace member the bundle does not export', () => {
    const { status, stderr } = inline({
      'health.js': "import * as health from '@open-mercato/cezar-contract/health';\n"
        + 'export const value = health.notAContractExport;\n',
    });

    expect(status, stderr).toBe(1);
    expect(stderr).toContain('dist/health.js:2 imports "notAContractExport" from "@open-mercato/cezar-contract/health"');
  });

  it('rejects a wildcard whose subpath has runtime names absent from the root', () => {
    const { status, stderr } = inline({
      'ask.js': "export * from '@open-mercato/cezar-contract/ask-schema';\n",
    });
    expect(status, stderr).toBe(1);
    expect(stderr).toContain('wildcard re-export');
    expect(stderr).toContain('askContextSchema');
  });

  it('keeps every runtime export of the stored automation wildcard available', () => {
    const { status, stderr } = inline({
      'automations/types.js': "export * from '@open-mercato/cezar-contract/automation-storage';\n",
    });
    expect(status, stderr).toBe(0);
  });

  it('passes and repoints imports whose names the bundle exports', () => {
    const { dist, status, stderr } = inline({
      'ask.js': "import { ASK_LIMITS } from '@open-mercato/cezar-contract/ask-schema';\nexport const limits = ASK_LIMITS;\n",
      'runs/record.js': 'import {\n  runRecordSchema,\n  runStatusSchema as status,\n} from "@open-mercato/cezar-contract/runs";\n'
        + "export { askRequestSchema } from '@open-mercato/cezar-contract';\n"
        + 'export const schemas = [runRecordSchema, status];\n',
    });

    expect(status, stderr).toBe(0);
    expect(readFileSync(join(dist, 'ask.js'), 'utf8')).toContain("from './contract/index.js'");
    const record = readFileSync(join(dist, 'runs/record.js'), 'utf8');
    expect(record).not.toContain('@open-mercato/cezar-contract');
    expect(record.match(/'\.\.\/contract\/index\.js'/g)).toHaveLength(2);
  });
});
