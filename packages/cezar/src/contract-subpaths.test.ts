import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The contract's module subpaths, loaded the way a consumer loads them (hearsay-tools/cezarion#1237).
 *
 * A contract helper imported through a package root loads every contract module, delegation's
 * schemas among them, so a test of an unrelated helper reruns whenever any shared schema changes.
 * Each probe runs in its own Node process from this package's directory: a fresh module cache, the
 * real `node_modules` links and the real `exports` maps, which an in-process import through
 * Vitest's resolver would not prove.
 */
const packageDir = join(import.meta.dirname, '..');
const packagesDir = join(packageDir, '..');

/** argv: the specifier to import, then an optional expression over `m` (its namespace) and `load`. */
const PROBE = `
import { registerHooks } from 'node:module';
const [specifier, call] = process.argv.slice(1);
const loaded = new Set();
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) loaded.add(url);
    return nextLoad(url, context);
  },
});
const m = await import(specifier);
const AsyncFunction = (async () => {}).constructor;
const result = call ? await new AsyncFunction('m', 'load', 'return (' + call + ');')(m, (s) => import(s)) : null;
process.stdout.write(JSON.stringify({ loaded: [...loaded], result }));
`;

function probe(specifier: string, call?: string): { loaded: string[]; result: unknown } {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, specifier, call ?? ''], {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: 60_000, // bound: a cold Node start plus type stripping on a loaded host
  });
  if (child.status !== 0) throw new Error(`${specifier} did not load:\n${child.stderr || child.error?.message}`);
  const { loaded, result } = JSON.parse(child.stdout) as { loaded: string[]; result: unknown };
  return {
    loaded: loaded
      .map((url) => relative(packagesDir, fileURLToPath(url)).replaceAll('\\', '/'))
      .filter((path) => /^(contract|api-client)\/src\//.test(path))
      .sort(),
    result,
  };
}

describe('contract module subpaths', () => {
  it.each([
    '@open-mercato/cezar-contract/workspace',
    '@open-mercato/cezar-api-client/contract/workspace',
  ])('%s runs normalizeSidebarLimits without loading delegation', (specifier) => {
    const { loaded, result } = probe(specifier, 'm.normalizeSidebarLimits({ overall: 12 })');
    expect(result).toEqual({ overall: 12, needsYou: null, finished: null, working: null });
    expect(loaded).toContain('contract/src/workspace.ts');
    expect(loaded).not.toContain('contract/src/delegation.ts');
  });

  it('loads delegation through /runs, so the absence checks above are not vacuous', () => {
    expect(probe('@open-mercato/cezar-contract/runs').loaded).toContain('contract/src/delegation.ts');
  });

  it.each([
    '@open-mercato/cezar-contract/index',
    '@open-mercato/cezar-contract/runs.test',
    '@open-mercato/cezar-api-client/protocol/tool-display.test',
  ])('%s is not exported', (specifier) => {
    expect(() => probe(specifier)).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });
});

/** The pure helpers moved out of `runs.ts`, `live.ts` and `projects.ts`, by their new module. */
const MOVED: Record<string, string[]> = {
  attachments: ['FILE_ATTACHMENT_MEDIA_TYPES', 'isImageMediaType', 'isAttachmentMediaType', 'attachmentExtension', 'isImageAttachmentName'],
  'run-labels': ['runWorkflowLabel'],
  'run-limits': ['ARCHIVED_RUNS_PAGE_DEFAULT', 'ARCHIVED_RUNS_PAGE_MAX'],
  'live-limits': ['LIVE_RUN_LIMIT', 'LIVE_EVENT_LIMIT', 'LIVE_BYTE_LIMIT'],
  'project-limits': ['PROJECT_TAG_MAX_LENGTH', 'PROJECT_TAGS_MAX', 'PROJECT_WEBHOOK_URL_MAX_LENGTH', 'PROJECT_WEBHOOK_TOKEN_MAX_LENGTH', 'PROJECT_NAME_PATTERN'],
};

describe('pure helpers in their own modules', () => {
  it.each([
    '@open-mercato/cezar-contract/run-labels',
    '@open-mercato/cezar-api-client/contract/run-labels',
  ])('%s labels runs without loading delegation', (specifier) => {
    const { loaded, result } = probe(specifier, `[
      m.runWorkflowLabel({ workflow: '(planned)', steps: [{ kind: 'check', name: 'lint' }, { kind: 'agent', name: 'implement' }] }),
      m.runWorkflowLabel({ workflow: '(inbox)', steps: [] }),
      m.runWorkflowLabel({ workflow: 'quick-task', steps: [{ kind: 'agent', name: 'implement' }] }),
    ]`);
    expect(result).toEqual(['implement', '(inbox)', 'quick-task']);
    expect(loaded).not.toContain('contract/src/delegation.ts');
  });

  it.each(Object.keys(MOVED))('contract/%s loads only itself', (name) => {
    expect(probe(`@open-mercato/cezar-contract/${name}`).loaded).toEqual([`contract/src/${name}.ts`]);
  });

  it('the root still exports every moved name, bound to its new module', () => {
    const { result } = probe('@open-mercato/cezar-contract', `(async () => {
      const mismatched = [];
      for (const [name, exported] of Object.entries(${JSON.stringify(MOVED)})) {
        const own = await load('@open-mercato/cezar-contract/' + name);
        for (const key of exported) if (own[key] === undefined || m[key] !== own[key]) mismatched.push(name + '.' + key);
      }
      return mismatched;
    })()`);
    expect(result).toEqual([]);
  });
});
