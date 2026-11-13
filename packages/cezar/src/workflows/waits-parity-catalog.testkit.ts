import type { it as registerTest } from 'vitest';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { familyCells, SHARED_RUNNERS } from '../core/parity-classes.testkit.ts';

// The catalog of the wait parity cells: their parts, files, row families and folds. It loads no
// cells, so a file reads it without the fixture (hearsay-tools/cezarion#3242).
// Six base parts cover registration/budgets, input, delivery/failures, asks/replies,
// done and answers. Seven worker parts cover mixed waits/notices, recovery, conversations,
// refusals/requests, completion, completion replies and closed-session recovery/fallback (hearsay-tools/cezarion#2519).
// Earlier runner/base/worker splits: hearsay-tools/cezarion#1301, hearsay-tools/cezarion#1288.
// Process and entry axes stay separate (hearsay-tools/cezarion#1525); the once file
// checks registration and runs the single-runner cells.
export const WAIT_PARITY_PARTS = ['registration', 'input', 'delivery', 'asks', 'done', 'answers', 'mixed', 'recovery', 'conversations', 'refusal', 'completion', 'completion-replies', 'closed', 'process', 'deadlines', 'entries'] as const;
export type WaitParityPart = typeof WAIT_PARITY_PARTS[number];
/** One part's cells, registered for each runner in `runners`. */
export type WaitCells = (runners: RunnerId[], it?: typeof registerTest) => void;
export const WAIT_PARITY_FILES = Object.fromEntries(
  WAIT_PARITY_PARTS.map(part => [part, (runner: RunnerId) => `waits-${runner}-${part}-parity.test.ts`]),
) as Record<WaitParityPart, (runner: RunnerId) => string>;
/** The module of each part's cells. A part's test files import it first, and a family file imports its part's. */
export const waitPartModule = (part: WaitParityPart): string => `waits-parity-${part}-cells.testkit.ts`;

// Only the measured residual runner/part pairs use smaller row families.
export const WAIT_PARITY_FAMILIES = {
  cursorRegistrationWire: { runner: 'cursor', part: 'registration', family: 'wire' },
  cursorRegistrationLimits: { runner: 'cursor', part: 'registration', family: 'limits' },
  cursorMixedWaits: { runner: 'cursor', part: 'mixed', family: 'waits' },
  cursorMixedNotices: { runner: 'cursor', part: 'mixed', family: 'notices' },
  cursorMixedMessages: { runner: 'cursor', part: 'mixed', family: 'messages' },
  cursorEntriesRefusals: { runner: 'cursor', part: 'entries', family: 'refusals' },
  cursorEntriesNoWait: { runner: 'cursor', part: 'entries', family: 'no-wait' },
  cursorEntriesCompletion: { runner: 'cursor', part: 'entries', family: 'completion' },
  cursorEntriesTimer: { runner: 'cursor', part: 'entries', family: 'timer' },
  cursorAsksOpens: { runner: 'cursor', part: 'asks', family: 'opens' },
  cursorAsksEnds: { runner: 'cursor', part: 'asks', family: 'ends' },
  cursorAsksNudges: { runner: 'cursor', part: 'asks', family: 'nudges' },
  cursorClosedBound: { runner: 'cursor', part: 'closed', family: 'bound' },
  cursorClosedContinue: { runner: 'cursor', part: 'closed', family: 'continue' },
  cursorClosedResume: { runner: 'cursor', part: 'closed', family: 'resume' },
} as const;
export type WaitParityFamily = typeof WAIT_PARITY_FAMILIES[keyof typeof WAIT_PARITY_FAMILIES];

/** The row families of each part that splits by family, keyed by the row's criterion (an entry row's
 *  second criterion, after U27). Every row of such a part is in exactly one family. */
export const ROW_FAMILIES = {
  registration: { wire: ['U1', 'U4', 'U26'], limits: ['U28w', 'U28r', 'U28p', 'U10', 'U16', 'U16b'] },
  mixed: { messages: ['U3w'], notices: ['U3n', 'U3r', 'U3d'], waits: ['U2w', 'U2t', 'U2c', 'U7w'] },
  asks: { opens: ['U7h', 'U7k', 'U7a'], ends: ['U9h', 'U18'], nudges: ['U5a', 'U5c', 'U5d', 'U17', 'U15'] },
  closed: { bound: ['U22c', 'U22f'], continue: ['U22k', 'U22x'], resume: ['U22r', 'U24', 'U24r', 'U25'] },
  entries: { completion: ['U6'], timer: ['U11'], refusals: ['U20', 'U20u'], 'no-wait': ['U5', 'accepted'] },
} as const satisfies Partial<Record<WaitParityPart, Record<string, readonly string[]>>>;
export type FamilyPart = keyof typeof ROW_FAMILIES;
type RowFamily = { [P in FamilyPart]: keyof typeof ROW_FAMILIES[P] }[FamilyPart];

/**
 * A runner outside the shared set runs only the rows that run on every runner, a few per part
 * (hearsay-tools/cezarion#2991). Its parts fold into the groups below, one file each: fewer per-file
 * setups, while each file stays well under CI's per-file cap (`FILE_DURATION_LIMIT_MS` in
 * `.github/scripts/vitest-file-duration.mjs`, 60 s with coverage on; about 30 s with coverage and 13 s
 * locally at most per group). Every part is in one group, or splits by row family (`ROW_FAMILIES`)
 * across groups as cursor's cap split does: `entries` and `closed`. `registration` holds U1 alone, the
 * slowest row, so it keeps a small group. The guard computes the folded runners from the class table
 * and their files from these groups.
 */
export const FOLDED_WAIT_RUNNERS: readonly RunnerId[] = RUNNER_IDS.filter(runner => !SHARED_RUNNERS.includes(runner));
type WaitFoldGroup = {
  readonly parts?: readonly WaitParityPart[];
  readonly families?: { readonly [P in FamilyPart]?: readonly (keyof typeof ROW_FAMILIES[P])[] };
};
export const WAIT_FOLDS = {
  'base-registration': { parts: ['registration', 'process', 'deadlines'] },
  base: { parts: ['input', 'asks', 'done', 'answers'] },
  'base-delivery': { parts: ['delivery'] },
  workers: { parts: ['mixed', 'recovery', 'conversations'] },
  'workers-refusals': { parts: ['refusal', 'completion', 'completion-replies'], families: { closed: ['continue'] } },
  'workers-closed': { families: { closed: ['resume', 'bound'] } },
  'entries-refusals': { families: { entries: ['refusals', 'no-wait'] } },
  'entries-nudges': { families: { entries: ['completion', 'timer'] } },
} as const satisfies Record<string, WaitFoldGroup>;
export type WaitFold = keyof typeof WAIT_FOLDS;
export const foldedWaitFile = (runner: RunnerId, fold: WaitFold): string => `waits-${runner}-every-runner-${fold}-parity.test.ts`;
export const folded = (runner: RunnerId): boolean => FOLDED_WAIT_RUNNERS.includes(runner);
/** The module of each fold's parts. A folded runner's file imports the one of its fold. */
export const waitFoldModule = (fold: WaitFold): string => `waits-parity-${fold}-fold.testkit.ts`;
export type WaitPartScope = { runner: RunnerId; part: WaitParityPart; family?: WaitParityFamily['family'] };
export type WaitFoldScope = { runner: RunnerId; part: 'every-runner'; fold: WaitFold };

/** Register a folded runner's cells of one group, each row only where its class runs it. */
export function foldCells(runner: RunnerId, fold: WaitFold, cells: Partial<Record<WaitParityPart, WaitCells>>, register: typeof registerTest): void {
  const group: WaitFoldGroup = WAIT_FOLDS[fold];
  const partCells = (part: WaitParityPart): WaitCells => {
    const found = cells[part];
    if (found === undefined) throw Error(`The ${fold} fold needs the ${part} cells`);
    return found;
  };
  const classed = familyCells('waits', runner, register);
  for (const part of group.parts ?? []) partCells(part)([runner], classed);
  for (const [part, families] of Object.entries(group.families ?? {}) as Array<[FamilyPart, readonly RowFamily[]]>) {
    partCells(part)([runner], ((title: string, body: () => Promise<void>) => {
      if (families.includes(rowFamily(part, title))) classed(title, body);
    }) as typeof registerTest);
  }
}

function rowFamily(part: FamilyPart, title: string): RowFamily {
  const criterion = title.split(' ')[part === 'entries' ? 2 : 1]!;
  const families: Record<string, readonly string[]> = ROW_FAMILIES[part];
  const family = Object.keys(families).find(name => families[name]!.includes(criterion));
  if (family === undefined) throw Error(`Unclassified ${part} wait parity row: ${title}`);
  return family as RowFamily;
}

export function familyTest(scope: WaitParityFamily, register: typeof registerTest): typeof registerTest {
  return ((title: string, body: () => Promise<void>) => {
    if (rowFamily(scope.part, title) === scope.family) register(title, body);
  }) as typeof registerTest;
}

export function splitPart(runner: RunnerId, part: WaitParityPart): boolean {
  return Object.values(WAIT_PARITY_FAMILIES).some(scope => scope.runner === runner && scope.part === part);
}
