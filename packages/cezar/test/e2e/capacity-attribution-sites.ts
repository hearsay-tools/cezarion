import { createHash } from 'node:crypto';
import type { Category, LiteralSite } from './capacity-attribution-ledger.ts';

/** Exact source inventory for the current model. A line shift or source change refuses instrumentation. */
const inventory: Record<string, { hash: string; sites: Record<number, Category> }> = {
  'linux-alias-model.ts': { hash: '047b2f203bc2980740ee41eee122ef3fb62541a74dec72307080c6726fcfe058', sites: {
    78: 'mountParse', 92: 'ownedRootLocate', 123: 'intersectionBuild', 129: 'intersectionBuild', 142: 'intersectionBuild',
    156: 'filter', 166: 'ancestorLookup', 168: 'ancestorLookup', 170: 'ancestorLookup', 177: 'sort', 180: 'candidateConstruct',
    203: 'unclassified', 210: 'unclassified', 249: 'evidenceRecheck', 268: 'mapParseAndVariants', 280: 'mapParseAndVariants',
  } },
  'linux-alias-links.ts': { hash: '9704a232ebc44476f5a8dde37efed71d578d9a6e9f7ab941807b900e38974fc8', sites: { 16: 'sweepAndLinks', 32: 'sweepAndLinks', 51: 'sweepAndLinks' } },
  'linux-alias-scan.ts': { hash: '5a2442aee7788c4183ef14b5958a186f872ea3b8691b805a5c47ec6823f7dfcd', sites: { 43: 'identityPrecharge', 88: 'evidenceRecheck', 91: 'evidenceRecheck', 146: 'evidenceRecheck' } },
  'linux-alias-discovery-sweep.ts': { hash: '0cb619fac906f03ed109e92e28fc199da555f1d4c90ab3dc22d18e62c271a41d', sites: { 27: 'sweepAndLinks', 62: 'sweepAndLinks' } },
  'linux-alias-sweep.ts': { hash: '6641a0bf45b6eeb35a21714ffc0fcbd59f5dc5e11d266e5ab120acc41ab988f5', sites: { 10: 'sweepAndLinks' } },
  'linux-alias-scope.ts': { hash: '625c290370350dccd4fbe6b9c0bb9edbc48b7681e81e0a2fab86993565ee797b', sites: { 52: 'evidenceRecheck', 55: 'evidenceRecheck' } },
  'linux-mapped-holders.ts': { hash: 'eb05da0a11ed8114ee1cf1b6ffb52643059f4e74a7e0764ea4c8241959dfae32', sites: { 12: 'literalMapped', 18: 'literalMapped', 28: 'literalMapped', 34: 'literalMapped', 49: 'literalMapped' } },
  'linux-proc-evidence.ts': { hash: '5aab43b8280c17bf9ed70f5a7e2c1fff194533be3dc7bd26722f7e571bc8bb8d', sites: { 16: 'procRead' } },
  'destroy-holders.ts': { hash: '6190e16577dd08bcae06d01cc861cb92c8819cec479b0e43e17a31af742b3360', sites: { 85: 'sweepAndLinks', 89: 'sweepAndLinks', 92: 'sweepAndLinks', 100: 'sweepAndLinks', 102: 'sweepAndLinks', 182: 'sweepAndLinks', 195: 'sweepAndLinks', 221: 'evidenceRecheck', 232: 'sweepAndLinks' } },
};
export const attributionInputs = Object.keys(inventory);

/** Validate this complete inventory before returning any source for a copy. */
export function validateAttributionSources(sources: Readonly<Record<string, string>>): void {
  if (JSON.stringify(Object.keys(sources).sort()) !== JSON.stringify(attributionInputs.slice().sort())) throw new Error('attribution inventory changed');
  for (const [file, spec] of Object.entries(inventory)) {
    const source = sources[file]!;
    if (createHash('sha256').update(source).digest('hex') !== spec.hash) throw new Error(`attribution source hash changed: ${file}`);
    if (/\b(?:cezCapacityAttribution|recordCharge|refuseReservation|resetAttribution|reportAttribution)\b/.test(source)) throw new Error('attribution helper collision');
    if (/\?*\.reserve\s*\(/.test(source)) throw new Error('attribution reservation unsupported');
    const lines = source.split('\n');
    const actual = lines.flatMap((line, index) => /\?*\.spend\s*\(/.test(line) ? [index + 1] : []);
    const expected = Object.keys(spec.sites).map(Number);
    // The reserve implementation and the two chargePaths spends are separately patched.
    if (file === 'linux-alias-model.ts') expected.push(35, 109, 112);
    if (JSON.stringify(actual.sort((a, b) => a - b)) !== JSON.stringify(expected.sort((a, b) => a - b))) throw new Error(`attribution spend sites changed: ${file}`);
  }
}

function taggedCall(line: string, category: Category | 'tag', site?: LiteralSite): string {
  const marker = '.spend(';
  const start = line.indexOf(marker);
  if (start < 0 || line.indexOf(marker, start + marker.length) >= 0) throw new Error('attribution call marker changed');
  const opening = start + marker.length - 1;
  let depth = 0;
  for (let i = opening; i < line.length; i++) {
    if (line[i] === '(') depth++;
    if (line[i] === ')' && --depth === 0) {
      const argument = line.slice(opening + 1, i);
      return line.slice(0, opening + 1) + (argument || '1') + ', ' + (category === 'tag' ? 'tag' : `'${category}'`) + (site ? `, '${site}'` : '') + line.slice(i);
    }
  }
  throw new Error('attribution call is not balanced');
}

function once(source: string, marker: string, replacement: string): string {
  if (source.split(marker).length !== 2) throw new Error('attribution marker changed');
  return source.replace(marker, replacement);
}

/** Stage in memory only. The caller must validate the fixture and copy before writing. */
export function instrumentAttributionSources(sources: Readonly<Record<string, string>>): Record<string, string> {
  validateAttributionSources(sources);
  const result: Record<string, string> = {};
  for (const [file, spec] of Object.entries(inventory)) {
    const lines = sources[file]!.split('\n');
    const literalSites: Record<number, LiteralSite> = { 12: 'linePrecharge', 18: 'rootRelevance', 28: 'variantExpansion', 34: 'finalMembership', 49: 'caughtProbe' };
    for (const [number, category] of Object.entries(spec.sites)) {
      const site = file === 'linux-mapped-holders.ts' ? literalSites[Number(number)] : undefined;
      if ((category === 'literalMapped') !== (site !== undefined)) throw new Error('literal attribution inventory changed');
      lines[Number(number) - 1] = taggedCall(lines[Number(number) - 1]!, category, site);
    }
    if (file === 'linux-alias-model.ts') {
      lines[108] = taggedCall(lines[108]!, 'tag');
      lines[111] = taggedCall(lines[111]!, 'tag');
      const pathSites: Record<number, Category> = { 125: 'intersectionBuild', 130: 'intersectionBuild', 135: 'intersectionBuild',
        138: 'intersectionBuild', 139: 'intersectionBuild', 159: 'filter', 174: 'ancestorLookup', 181: 'candidateConstruct', 183: 'candidateConstruct' };
      for (const [number, tag] of Object.entries(pathSites)) lines[Number(number) - 1] = once(lines[Number(number) - 1]!, 'chargePaths(budget, ', `chargePaths(budget, '${tag}', `);
      let source = lines.join('\n');
      source = once(source, 'function chargePaths(budget: AliasWorkBudget, ...paths: string[]): void {', 'function chargePaths(budget: AliasWorkBudget, tag: Category, ...paths: string[]): void {');
      source = once(source, 'spend(amount = 1): void {\n    this.remaining -= amount;', "spend(amount = 1, tag: Category = 'unclassified', site?: LiteralSite): void {\n    this.remaining -= amount;\n    recordCharge(tag, amount, this.remaining, site);");
      source = once(source, 'reserve(amount: number): { budget: AliasWorkBudget; close: () => void } {', "reserve(amount: number): { budget: AliasWorkBudget; close: () => void } {\n    return refuseReservation();");
      result[file] = "import { recordCharge, refuseReservation, type Category, type LiteralSite } from '../../test/e2e/capacity-attribution-ledger.ts';\n" + source;
    } else result[file] = lines.join('\n');
  }
  return result;
}

export function instrumentCapacityFixture(source: string, expectedHash: string): string {
  if (createHash('sha256').update(source).digest('hex') !== expectedHash) throw new Error('capacity fixture hash changed');
  if (/\b(?:resetAttribution|reportAttribution)\b/.test(source)) throw new Error('attribution helper collision');
  const marker = '    const started = Date.now();\n    const result = await f.service.destroy(f.caller, { workerId });';
  const replacement = `    const started = Date.now();
    resetAttribution();
    let result: Awaited<ReturnType<typeof f.service.destroy>>;
    try { result = await f.service.destroy(f.caller, { workerId }); }
    finally {
      reportAttribution(text => process.stdout.write(text));
    }`;
  return "import { resetAttribution, reportAttribution } from '../../test/e2e/capacity-attribution-ledger.ts';\n" + once(source, marker, replacement);
}
