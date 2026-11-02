import { baselinePath as unitBaselinePath, srcDir as unitSrcDir, scanTree, shrinkBaseline as shrinkUnitBaseline, tally as tallyUnits, compareToBaseline as compareUnits, readBaseline as readUnitBaseline } from './unit-wait-discipline.ts';
import { relative } from 'node:path';
import { baselines, compareToBaseline, readBaseline, scannedFiles, scanSuite, srcDir, shrinkBaseline, tally } from './server-wait-baseline.ts';
import { repoRoot } from './source-rule.ts';

/** Whole-suite guarantees formerly held by the server unit suite's repository cases. */
export function serverWaitProblems(update = process.env.TEST_WAIT_DISCIPLINE_UPDATE === '1', dir = srcDir, lists = baselines): string[] {
  const scanned = scanSuite(dir);
  const files = scannedFiles(dir);
  const problems: string[] = [];
  if (files.length <= 300 || !files.includes('core/harness-parity.testkit.ts')
    || files.some(file => file.startsWith('test-wait-discipline.') || file.includes('__fixtures__/') || file.includes('node_modules/'))) {
    problems.push('packages/cezar/src:1:1 cez/test-wait-discipline: scan scope changed; scan every test and testkit except the scanner fixtures, node_modules and __fixtures__ (AGENTS.md § Validation)');
  }
  for (const error of scanned.errors) {
    problems.push(`packages/cezar/src/${error.file}:${error.line}:1 cez/test-wait-discipline: unterminated ${error.construct}: ${error.text}. Fix the scan's blanking in packages/cezar/src/lint/blank.ts; everything after this went unread (AGENTS.md § Validation)`);
  }
  for (const baseline of lists) {
    const actual = tally(scanned.sites.filter(site => baseline.rules.includes(site.rule)));
    if (update) shrinkBaseline(actual, baseline);
    const { stale } = compareToBaseline(actual, readBaseline(baseline.path));
    for (const entry of stale) {
      problems.push(`${relative(repoRoot, baseline.path)}:1:1 cez/test-wait-discipline: stale entry ${entry.file} [${entry.rule}] ×${entry.count}: ${entry.site}. Baseline entries no longer found; shrink ${baseline.path} (TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint does it)`);
    }
  }
  return problems;
}

/** The cockpit baseline ratchet, separate from the host's asyncUtilTimeout test. */
export function unitWaitProblems(update = process.env.UNIT_WAIT_DISCIPLINE_UPDATE === '1', dir = unitSrcDir, path = unitBaselinePath): string[] {
  const actual = tallyUnits(scanTree(dir));
  if (update) shrinkUnitBaseline(actual, path);
  return compareUnits(actual, readUnitBaseline(path)).stale.map(entry =>
    `${relative(repoRoot, path)}:1:1 cez/unit-wait-discipline: stale entry ${entry.file} [${entry.rule}] x${entry.count}: ${entry.site}. Baseline entries no longer found; shrink ${path} (UNIT_WAIT_DISCIPLINE_UPDATE=1 npm run lint does it)`);
}
