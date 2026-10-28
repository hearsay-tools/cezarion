/** CI-only fixed schema. The diagnostic does not retain paths or process identities. */
export const categories = ['procRead', 'mountParse', 'ownedRootLocate', 'mapParseAndVariants', 'literalMapped',
  'intersectionBuild', 'filter', 'ancestorLookup', 'candidateConstruct', 'sort', 'identityPrecharge',
  'evidenceRecheck', 'sweepAndLinks', 'reservation', 'unclassified'] as const;
export type Category = typeof categories[number];
type Counts = { attemptedUnits: number; successfulChargeUnits: number; refusedChargeUnits: number };
const limit = 2_147_483_647;
let enabled = false;
let saturated = false;
let invalid = false;
let counts = makeCounts();
let firstExhaustion: { category: Category; amount: number; remaining: number; snapshot: Record<Category, Counts> } | undefined;
function makeCounts(): Record<Category, Counts> {
  return Object.fromEntries(categories.map(category => [category, { attemptedUnits: 0, successfulChargeUnits: 0, refusedChargeUnits: 0 }])) as Record<Category, Counts>;
}
function add(value: number, amount: number): number {
  if (value + amount > limit) { saturated = true; return limit; }
  return value + amount;
}
export function resetAttribution(): void { counts = makeCounts(); firstExhaustion = undefined; saturated = false; invalid = false; enabled = true; }
/** Called after the original debit and before the original check; never calls spend. */
export function recordCharge(category: Category, amount: number, remaining: number): void {
  if (!enabled) return;
  try {
  const tag = categories.includes(category) ? category : 'unclassified';
  const row = counts[tag];
  row.attemptedUnits = add(row.attemptedUnits, amount);
  if (remaining < 0) {
    row.refusedChargeUnits = add(row.refusedChargeUnits, amount);
    firstExhaustion ??= { category: tag, amount, remaining, snapshot: structuredClone(counts) };
  } else row.successfulChargeUnits = add(row.successfulChargeUnits, amount);
  } catch { invalid = true; }
}
export function attributionSnapshot() { return { counts: structuredClone(counts), saturated, invalid, firstExhaustion: structuredClone(firstExhaustion ?? null) }; }
export function reportAttribution(write: (text: string) => unknown): void {
  try { write('CAPACITY_ATTRIBUTION ' + JSON.stringify(attributionSnapshot()) + '\n'); }
  catch { try { write('CAPACITY_ATTRIBUTION_INVALID\n'); } catch { /* preserve destroy outcome */ } }
}
export function refuseReservation(): never { throw new Error('capacity attribution does not support reservations'); }
