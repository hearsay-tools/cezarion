/** CI-only fixed schema. The diagnostic does not retain paths or process identities. */
export const categories = ['procRead', 'mountParse', 'ownedRootLocate', 'mapParseAndVariants', 'literalMapped',
  'intersectionBuild', 'filter', 'ancestorLookup', 'candidateConstruct', 'sort', 'identityPrecharge',
  'evidenceRecheck', 'sweepAndLinks', 'reservation', 'unclassified'] as const;
export type Category = typeof categories[number];
export const literalSites = ['linePrecharge', 'rootRelevance', 'variantExpansion', 'finalMembership', 'caughtProbe'] as const;
export type LiteralSite = typeof literalSites[number];
type Counts = { attemptedUnits: number; successfulChargeUnits: number; refusedChargeUnits: number };
const limit = 2_147_483_647;
let enabled = false;
let saturated = false;
let invalid = false;
let sitesSaturated = false;
let literalMappedSites = makeSites();
let counts = makeCounts();
let firstExhaustion: { category: Category; amount: number; remaining: number; snapshot: Record<Category, Counts> } | undefined;
function makeCounts(): Record<Category, Counts> {
  return Object.fromEntries(categories.map(category => [category, { attemptedUnits: 0, successfulChargeUnits: 0, refusedChargeUnits: 0 }])) as Record<Category, Counts>;
}
function makeSites(): Record<LiteralSite, Counts & { attemptedCalls: number }> {
  return Object.fromEntries(literalSites.map(site => [site, { attemptedUnits: 0, successfulChargeUnits: 0, refusedChargeUnits: 0, attemptedCalls: 0 }])) as Record<LiteralSite, Counts & { attemptedCalls: number }>;
}
function addSite(value: number, amount: number): number {
  if (value + amount > limit) { sitesSaturated = true; return limit; }
  return value + amount;
}
function add(value: number, amount: number): number {
  if (value + amount > limit) { saturated = true; return limit; }
  return value + amount;
}
export function resetAttribution(): void { counts = makeCounts(); literalMappedSites = makeSites(); firstExhaustion = undefined; saturated = false; sitesSaturated = false; invalid = false; enabled = true; }
/** Called after the original debit and before the original check; never calls spend. */
export function recordCharge(category: Category, amount: number, remaining: number, site?: LiteralSite): void {
  if (!enabled) return;
  try {
  if ((category === 'literalMapped') !== (site !== undefined) || (site !== undefined && !literalSites.includes(site))) invalid = true;
  const tag = categories.includes(category) ? category : 'unclassified';
  const row = counts[tag];
  row.attemptedUnits = add(row.attemptedUnits, amount);
  if (remaining < 0) {
    row.refusedChargeUnits = add(row.refusedChargeUnits, amount);
    firstExhaustion ??= { category: tag, amount, remaining, snapshot: structuredClone(counts) };
  } else row.successfulChargeUnits = add(row.successfulChargeUnits, amount);
  if (category === 'literalMapped' && site !== undefined && literalSites.includes(site)) {
    const target = literalMappedSites[site];
    target.attemptedCalls = addSite(target.attemptedCalls, 1);
    target.attemptedUnits = addSite(target.attemptedUnits, amount);
    if (remaining < 0) target.refusedChargeUnits = addSite(target.refusedChargeUnits, amount);
    else target.successfulChargeUnits = addSite(target.successfulChargeUnits, amount);
  }
  } catch { invalid = true; }
}
export function attributionSnapshot() { return { version: 3, counts: structuredClone(counts), saturated, invalid, sitesSaturated, literalMappedSites: structuredClone(literalMappedSites), firstExhaustion: structuredClone(firstExhaustion ?? null) }; }
export function reportAttribution(write: (text: string) => unknown): void {
  try { write('CAPACITY_ATTRIBUTION ' + JSON.stringify(attributionSnapshot()) + '\n'); }
  catch { try { write('CAPACITY_ATTRIBUTION_INVALID\n'); } catch { /* preserve destroy outcome */ } }
}
export function refuseReservation(): never { throw new Error('capacity attribution does not support reservations'); }
