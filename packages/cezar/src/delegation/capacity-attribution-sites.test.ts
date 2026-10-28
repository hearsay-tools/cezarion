import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { attributionInputs, instrumentAttributionSources, instrumentCapacityFixture, validateAttributionSources } from '../../test/e2e/capacity-attribution-sites.ts';
import { validateAttributionSupervisor } from '../../test/e2e/capacity-attribution-auth.ts';

it('validates the exact source inventory before any instrumentation', () => {
  expect(() => validateAttributionSupervisor(fileURLToPath(new URL('../../../../', import.meta.url)))).not.toThrow();
  const sources = Object.fromEntries(attributionInputs.map(file => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]));
  expect(() => validateAttributionSources(sources)).not.toThrow();
  const staged = instrumentAttributionSources(sources);
  for (const source of Object.values(staged)) expect(() => stripTypeScriptTypes(source, { mode: 'transform' })).not.toThrow();
  expect(staged['linux-alias-model.ts']).toContain("chargePaths(budget, 'filter', path)");
  expect(staged['linux-alias-model.ts']).toContain('budget.spend(components, tag)');
  expect(staged['linux-alias-model.ts']).toContain('return refuseReservation()');
  const mapped = staged['linux-mapped-holders.ts']!;
  for (const site of ['linePrecharge', 'variantExpansion', 'finalMembership', 'caughtProbe']) {
    expect(mapped.split(`'${site}'`)).toHaveLength(2);
  }
  expect(mapped).toContain("budget?.spend(1 + roots.length, 'literalMapped', 'linePrecharge')");
  expect(staged['linux-proc-evidence.ts']).toContain("budget.spend(Math.ceil(length / 256), 'procRead')");
  expect(() => validateAttributionSources({ ...sources, 'linux-alias-model.ts': sources['linux-alias-model.ts'] + '\n' })).toThrow('hash changed');
  expect(() => validateAttributionSources({ ...sources, 'unexpected.ts': '' })).toThrow('inventory changed');
});

it('stages reset after metrics and reporting before the original assertion', () => {
  const source = readFileSync(new URL('./authoritative-capacity-ci.test.ts', import.meta.url), 'utf8');
  const staged = instrumentCapacityFixture(source, 'cf9e4a7a33ddb2b89ccceeb94775eaca48a87d2433f4ea07b15c3b956cbf62f0');
  expect(() => stripTypeScriptTypes(staged, { mode: 'transform' })).not.toThrow();
  expect(staged.indexOf('capacity workload:')).toBeLessThan(staged.indexOf('resetAttribution();'));
  expect(staged.indexOf('reportAttribution(text =>')).toBeLessThan(staged.indexOf("expect(result).toMatchObject"));
  expect(staged).toContain('if (complete) await f.close()');
  expect(() => instrumentCapacityFixture(source + '\n', 'cf9e4a7a33ddb2b89ccceeb94775eaca48a87d2433f4ea07b15c3b956cbf62f0')).toThrow('hash changed');
});

it('runs the staged production budget and indexed lookup with shared tagged charges', async () => {
  const sources = Object.fromEntries(attributionInputs.map(file => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]));
  const staged = instrumentAttributionSources(sources);
  const ledger = readFileSync(new URL('../../test/e2e/capacity-attribution-ledger.ts', import.meta.url), 'utf8');
  const encode = (source: string) => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64');
  const ledgerUrl = encode(ledger);
  const model = staged['linux-alias-model.ts']!.replace('../../test/e2e/capacity-attribution-ledger.ts', ledgerUrl);
  const diagnostic = await import(/* @vite-ignore */ ledgerUrl) as typeof import('../../test/e2e/capacity-attribution-ledger.ts');
  const implementation = await import(/* @vite-ignore */ encode(model)) as typeof import('./linux-alias-model.ts');
  diagnostic.resetAttribution();
  const budget = new implementation.AliasWorkBudget(200_000);
  const mounts = [{ dev: '8:1', root: '/fs', point: '/alias' }];
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/fs' }];
  const index = implementation.indexAliasMounts(mounts, budget, '/', roots);
  expect(implementation.aliasCandidates('/alias/file', '/', '08:01', mounts, roots, budget, index)).toEqual(['/owned/file']);
  const report = diagnostic.attributionSnapshot();
  expect(report.counts.intersectionBuild.successfulChargeUnits).toBeGreaterThan(0);
  expect(report.counts.filter.successfulChargeUnits).toBeGreaterThan(0);
  expect(report.counts.ancestorLookup.successfulChargeUnits).toBeGreaterThan(0);
  expect(report.counts.candidateConstruct.successfulChargeUnits).toBeGreaterThan(0);
  expect(() => budget.reserve(1)).toThrow('does not support reservations');
  diagnostic.resetAttribution();
  const limited = new implementation.AliasWorkBudget(2) as unknown as { spend: (amount: number, category: string, site?: string) => void };
  limited.spend(1, 'literalMapped', 'linePrecharge');
  expect(() => limited.spend(2, 'ancestorLookup')).toThrow('work exceeds');
  const first = diagnostic.attributionSnapshot().firstExhaustion;
  expect(() => limited.spend(0, 'evidenceRecheck')).toThrow('work exceeds');
  const after = diagnostic.attributionSnapshot();
  expect(after.literalMappedSites.linePrecharge).toEqual({ attemptedUnits: 1, successfulChargeUnits: 1, refusedChargeUnits: 0, attemptedCalls: 1 });
  expect(after.invalid).toBe(false);
  expect(after.firstExhaustion).toEqual(first);
  expect(after.counts.ancestorLookup).toEqual({ attemptedUnits: 2, successfulChargeUnits: 0, refusedChargeUnits: 2 });
});
