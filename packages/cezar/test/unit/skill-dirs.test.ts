import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PROJECT_CATALOGS } from '../../../../.ai/scripts/e2e-catalogs.mjs';
import { WORKFLOWS_DIR } from '../../src/workflows/load.js';
import { SKILL_DIRS } from '../../src/skills.js';

/**
 * The cockpit's "no skills yet" hint names the directories to drop files into from a hand-copy
 * (`SKILL_PROJECT_DIRS` in packages/web/src/components/skill-empty-hint.tsx): the bundle cannot
 * import the server. This reads that copy and compares it with the server's discovery list.
 */
test('the project skill dirs the cockpit hint names are the ones discovery scans, in order', () => {
  const hint = readFileSync(new URL('../../../web/src/components/skill-empty-hint.tsx', import.meta.url), 'utf8');
  const declared = /const SKILL_PROJECT_DIRS = \[([^\]]*)\] as const/.exec(hint);
  assert.ok(declared, 'skill-empty-hint.tsx declares SKILL_PROJECT_DIRS');
  const named = [...declared[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  // The per-agent mirrors of `.agents/skills` fold into the hint's "agent mirrors like
  // .claude/skills/" aside instead of being listed.
  const mirrors: string[] = [];
  const listed: string[] = [];
  for (const { dir, source } of SKILL_DIRS) {
    if (source === 'agents' && dir !== '.agents/skills') mirrors.push(dir);
    else listed.push(`${dir}/`);
  }
  assert.deepEqual(named, listed);
  assert.ok(mirrors.includes('.claude/skills') && hint.includes('.claude/skills/'), 'the hint names a real agent mirror');
});

// The harness must replace every repo catalog that the served server can discover.

test('the e2e fixture catalogs cover every project discovery directory', () => {
  assert.deepEqual(PROJECT_CATALOGS, [...SKILL_DIRS.map(({ dir }) => dir), WORKFLOWS_DIR, '.ai/squawk/workflows']);
});
