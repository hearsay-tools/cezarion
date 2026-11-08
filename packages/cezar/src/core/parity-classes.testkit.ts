import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { PARITY_EXEMPTIONS } from './harness-parity-core.testkit.ts';
import { RUNNER_FACTS, type RunnerFacts } from './runner-facts.ts';

/**
 * Which runners each parity family runs on (hearsay-tools/cezarion#2991).
 *
 * - `every-runner`: the cells branch on a runner's own code, or read a narrow fact (native ask,
 *   native subagents, the native timer tool, cumulative cost). Every runner in `RUNNER_IDS`.
 * - `shared`: the cells test Cezar's logic above the seam, which sees a runner only through its
 *   turn-path facts. The derived `SHARED_RUNNERS` show every value of those facts once. A row of
 *   a shared family still runs on every runner when the family lists it in `everyRunner`, when
 *   `PARITY_EXEMPTIONS` exempts any runner from it, or when its cell title carries no row id.
 * - `no-session`: the cells start no runner session. Once, on `NO_SESSION_RUNNER`.
 *
 * `parity-classes.test.ts` checks that the derived set covers every declared value, and that every
 * parity test file belongs to a family here. `cez/runner-fact-combination` keeps shared code from
 * combining two facts, which one runner per value could not show.
 */

/**
 * The turn-path facts (hearsay-tools/cezarion#2991): the declared facts that decide how Cezar's
 * shared logic above the seam sees a turn and its input. A shared parity row runs on the runners
 * that together show every value of each of these facts; `cez/runner-fact-combination` keeps
 * shared code from combining two of them, so one runner per value is enough.
 */
export const TURN_PATH_FACTS = {
  'inputDelivery.mode': facts => facts.inputDelivery.mode,
  'inputDelivery.consumption': facts => facts.inputDelivery.consumption,
  'inputDelivery.acknowledgement': facts => facts.inputDelivery.acknowledgement,
  'inputDelivery.humanInputAtTurnEnd': facts => facts.inputDelivery.humanInputAtTurnEnd,
  systemPromptOnResume: facts => facts.systemPromptOnResume,
} as const satisfies Record<string, (facts: RunnerFacts) => string>;

type FactTable = Readonly<Record<string, RunnerFacts>>;

/** Each turn-path fact with every value the given runners declare for it. */
export function turnPathValues<Id extends string>(ids: readonly Id[], facts: Readonly<Record<Id, RunnerFacts>>): Record<string, Set<string>> {
  return Object.fromEntries(Object.entries(TURN_PATH_FACTS).map(([fact, read]) => [fact, new Set(ids.map(id => read(facts[id])))]));
}

const covers = (values: Record<string, Set<string>>, all: Record<string, Set<string>>) =>
  Object.entries(all).every(([fact, every]) => [...every].every(value => values[fact]!.has(value)));

/**
 * The smallest set of runners that shows every declared value of every turn-path fact. Among sets
 * of that size it takes the first in `ids` order: it compares the sets runner by runner, by each
 * runner's position in `ids`. The result keeps `ids` order.
 */
export function deriveRunnerSet<Id extends string>(ids: readonly Id[], facts: FactTable & Readonly<Record<Id, RunnerFacts>>): Id[] {
  const all = turnPathValues(ids, facts);
  for (let size = 1; size <= ids.length; size++) {
    for (const set of combinations(ids, size)) if (covers(turnPathValues(set, facts), all)) return set;
  }
  return [...ids];
}

/** Every `size`-runner subset of `ids`, in `ids` order and in lexicographic order of positions. */
function* combinations<Id>(ids: readonly Id[], size: number, from = 0): Generator<Id[]> {
  if (size === 0) { yield []; return; }
  for (let at = from; at <= ids.length - size; at++) {
    for (const rest of combinations(ids, size - 1, at + 1)) yield [ids[at]!, ...rest];
  }
}

/** The runners a shared parity row runs on, derived from the declarations. */
export const SHARED_RUNNERS: readonly RunnerId[] = deriveRunnerSet(RUNNER_IDS, RUNNER_FACTS);

/** The runner a family with no session runs on: the first of the shared set. */
export const NO_SESSION_RUNNER: RunnerId = SHARED_RUNNERS[0]!;

export type ParityClass = 'every-runner' | 'shared' | 'no-session';

interface ParityFamily {
  readonly class: ParityClass;
  /** Why the family has its class, from a trace of its cells. */
  readonly why: string;
  /** Rows of a shared family that still run on every runner, each with its reason. */
  readonly everyRunner?: Readonly<Record<string, string>>;
}

const NATIVE_ASK_SCENARIO = 'its scenario asks through the native ask on codex and opencode (nativeAsk answerable), which no runner of the shared set declares';
const PROVIDER_FAILURE = 'the wake fails through the runner\'s own provider-error handling';
const SMOKE = 'per-runner smoke row';
const PROVIDER_ERROR_START = 'its step fails through the runner\'s own provider-error path';

const everyRunner = (why: string): ParityFamily => ({ class: 'every-runner', why });
const shared = (why: string, rows: Readonly<Record<string, string>> = {}): ParityFamily => ({ class: 'shared', why, everyRunner: rows });

const HARNESS_SEAM = 'drives the runner class itself (seam tier), its wire features, permissions or provider errors';

/** Every parity family and its class. A harness family is one `describeRunners` group, as `harness:<group>`. */
export const PARITY_FAMILIES = {
  // Harness parity: the seam tier and every group whose cells branch on runner code.
  ...Object.fromEntries(['startup', 'provider', 'contract', 'seam', 'session', 'input', 'governed', 'native-message', 'spec',
    'tools', 'cdp', 'tool-grants', 'diagnostics', 'child', 'hooks', 'prs', 'permission', 'default-permission',
    'retirement-P3', 'retirement-P4', 'permission-failure', 'malformed', 'early-permission', 'late-permission', 'mcp']
    .map(group => [`harness:${group}`, everyRunner(HARNESS_SEAM)])),
  'harness:answer': everyRunner('R26 resumes a different native ask kind on each runner (askResumeCases)'),
  'harness:owner': everyRunner(`R50 parks on the ask scenario: ${NATIVE_ASK_SCENARIO}`),
  // Harness run tier: RunManager cells whose outcome is Cezar's.
  'harness:run': shared('RunManager cells over the native wire', {
    R1: SMOKE, R2: 'a provider error is the runner\'s own', R3: `R3 ${NATIVE_ASK_SCENARIO}`,
  }),
  'harness:monitoring': shared('the monitoring wrap-up is decided in run.ts', {
    R36: 'parses each runner\'s own prompt channel', R37: 'parses each runner\'s own prompt channel',
    R38: 'parses each runner\'s own prompt channel', R39: 'parses each runner\'s own prompt channel',
  }),
  'harness:owned-workflows': shared('owned workflow steps run through RunManager', {
    R14: 'a mixed-runner chain: each runner hands over to the next in RUNNER_IDS',
    R41: 'asserts on the native wire recording', R42: 'asserts on the native wire recording',
  }),
  'harness:owned': shared('owned input is delivered by run.ts; R8 differs only by steer or boundary delivery', {
    R6: NATIVE_ASK_SCENARIO, R7: NATIVE_ASK_SCENARIO, R9: NATIVE_ASK_SCENARIO,
  }),
  ...Object.fromEntries(['continue', 'restart', 'adopt', 'stop', 'cleanup', 'multi-continue', 'superseded', 'disposal', 'scratch']
    .map(group => [`harness:${group}`, shared('RunManager and store ownership, settlement and scratch rules')])),
  // Waits.
  waits: shared('the wait list, its wakes and its refusals are Cezar\'s; steer or boundary and the acknowledgement are turn-path facts', {
    U1: `${SMOKE}: registration through each runner's own tool transport`,
    U7k: NATIVE_ASK_SCENARIO,
    U8l: 'asserts an opencode-only session state',
    U9: PROVIDER_FAILURE, U9h: PROVIDER_FAILURE, U9w: PROVIDER_FAILURE, U9p: PROVIDER_FAILURE, R18: PROVIDER_FAILURE,
    U14: PROVIDER_FAILURE, U14m: `${PROVIDER_FAILURE}; a claude-only failure mode`,
    U22k: 'reads the U22s exemption', U22r: 'reads the U22s exemption and holds the acknowledgement on opencode only',
  }),
  'waits-subagents': everyRunner('reads the nativeSubagents fact'),
  // CI, PR and worker waits.
  'ci-wait-registration': shared('parks and wakes on a real tool call; tool transport is U1\'s'),
  'ci-wait-conflict': shared('conflict resolution in the wait registry'),
  'ci-wait-rerun': shared('reruns in the CI supervisor'),
  'ci-wait-retry': shared('source retry in the CI supervisor'),
  'ci-wait-failure': everyRunner('every row fails a CI agent through the runner\'s own provider-error path (gatedProviderFailure); R75 also builds each runner\'s own account and home'),
  'pr-merge-wait': shared('PR merge waits in the wait registry'),
  'worker-reboot': everyRunner('each runner reports its own process ids to the ledger the reboot reads; no seam row covers that report'),
  'worker-restart': everyRunner('each runner reports its own process ids to the ledger the restart reads; no seam row covers that report'),
  'session-context': shared('launch context is built in run/launch-context.ts; resume prompt and input delivery are turn-path facts'),
  'resume-diagnostics': shared('resume diagnostics are built by Cezar; the in-thread prefix is systemPromptOnResume', {
    R85: PROVIDER_ERROR_START, R88: PROVIDER_ERROR_START, R89: PROVIDER_ERROR_START,
  }),
  'completion-options': shared('completion options are Cezar\'s'),
  // Workflow families.
  'workflow-autonomous': shared('the autonomous policy is Cezar\'s'),
  'workflow-ask': shared('cezar_ask is Cezar\'s tool', {
    Q8: 'its authored timeout reaches each runner\'s own step deadline',
  }),
  'workflow-final-message': shared('the final-message rules are decided in turn-end.ts', {
    F3: 'branches on cursor', F10: 'branches on cursor',
  }),
  'workflow-followup': everyRunner('the follow-up hold (H rows) is each runner class\'s own'),
  'workflow-no-progress': everyRunner('each runner reports its own model progress'),
  'workflow-step-completion': shared('step completion is decided in run.ts'),
  'workflow-timeout': everyRunner('each runner applies its own step deadline'),
  'skill-resume': shared('inbox generation is Cezar\'s', {
    R53: 'the resumed skill prompt on each runner\'s wire', R54: 'the resumed skill prompt on each runner\'s wire',
    R55: 'the resumed skill prompt on each runner\'s wire', R56: 'the resumed skill prompt on each runner\'s wire',
    R57: 'the recorded session on each runner\'s wire', R59: 'reuses each runner\'s recorded session',
  }),
  'skill-provision': shared('skill installs go to every agent directory', { R95: 'branches on codex' }),
  'worktree-setup': shared('Cezar appends the setup note to the prompt'),
  'model-refusal': everyRunner('each runner maps its own model refusal'),
  'runner-shutdown': everyRunner('each runner class stops its own process'),
  'monitoring-turn': shared('the monitoring turn is decided in run.ts'),
  'ui-parity': everyRunner('every mapper emits every UI capability'),
  'server-contract': { class: 'no-session', why: 'HTTP contract and route parity start no runner (out of scope of hearsay-tools/cezarion#2991)' },
} as const satisfies Record<string, ParityFamily>;

export type ParityFamilyName = keyof typeof PARITY_FAMILIES;

/** Parity test files by family; a file may hold several harness groups. */
export const PARITY_FILES: ReadonlyArray<readonly [RegExp, readonly ParityFamilyName[]]> = [
  [/^core\/harness-(?:[a-z]+-[a-z-]+-)?parity(?:-closure)?\.test\.ts$/, Object.keys(PARITY_FAMILIES).filter(name => name.startsWith('harness:')) as ParityFamilyName[]],
  [/^workflows\/waits-(?:[a-z]+-subagents-)parity\.test\.ts$/, ['waits-subagents']],
  [/^workflows\/waits-(?![a-z]+-subagents-)(?:[a-z]+-[a-z-]+-)?parity\.test\.ts$/, ['waits']],
  [/^workflows\/ci-wait-(?:parity|fresh|continued|recovered)(?:-parity)?\.test\.ts$/, ['ci-wait-registration']],
  [/^workflows\/ci-wait-conflict-.*parity\.test\.ts$/, ['ci-wait-conflict']],
  [/^workflows\/ci-wait-rerun-.*parity\.test\.ts$/, ['ci-wait-rerun']],
  [/^workflows\/ci-wait-retry-parity\.test\.ts$/, ['ci-wait-retry']],
  [/^workflows\/ci-wait-(?:failure|final-recovery|nonfinal-[a-z-]+|restart-[a-z-]+)-parity\.test\.ts$/, ['ci-wait-failure']],
  [/^workflows\/pr-merge-wait-parity\.test\.ts$/, ['pr-merge-wait']],
  [/^workflows\/worker-reboot-.*parity\.test\.ts$/, ['worker-reboot']],
  [/^workflows\/worker-restart-.*parity\.test\.ts$/, ['worker-restart']],
  [/^workflows\/session-context-.*parity\.test\.ts$/, ['session-context']],
  [/^workflows\/resume-diagnostics-.*parity\.test\.ts$/, ['resume-diagnostics']],
  [/^workflows\/completion-options-.*parity\.test\.ts$/, ['completion-options']],
  [/^workflows\/context-completion-registration-parity\.test\.ts$/, ['session-context', 'completion-options']],
  [/^core\/workflow-autonomous-.*parity\.test\.ts$/, ['workflow-autonomous']],
  [/^core\/workflow-ask-.*parity\.test\.ts$/, ['workflow-ask']],
  [/^core\/workflow-final-message-.*parity\.test\.ts$/, ['workflow-final-message']],
  [/^core\/workflow-followup-.*parity\.test\.ts$/, ['workflow-followup']],
  [/^core\/workflow-no-progress-.*parity\.test\.ts$/, ['workflow-no-progress']],
  [/^core\/workflow-step-completion-.*parity\.test\.ts$/, ['workflow-step-completion']],
  [/^core\/workflow-timeout-.*parity\.test\.ts$/, ['workflow-timeout']],
  [/^core\/skill-resume-.*parity\.test\.ts$/, ['skill-resume']],
  [/^core\/skill-provision-.*parity\.test\.ts$/, ['skill-provision']],
  [/^core\/worktree-setup-parity\.test\.ts$/, ['worktree-setup']],
  [/^core\/model-refusal-parity\.test\.ts$/, ['model-refusal']],
  [/^core\/runner-shutdown-.*parity\.test\.ts$/, ['runner-shutdown']],
  [/^workflows\/monitoring-turn-[a-z-]+\.test\.ts$/, ['monitoring-turn']],
  [/^core\/ui-parity\.test\.ts$/, ['ui-parity']],
  [/^server\/(?:contract|route|query-repeat)-parity(?:\.[a-z]+)?\.test\.ts$/, ['server-contract']],
];

/** A row with an exemption on any runner differs by runner, so it runs on every runner. */
const EXEMPT_ROWS = new Set(PARITY_EXEMPTIONS.map(exemption => exemption.criterion));

/**
 * The runners a family's row runs on. `row` is the row id in the cell title; a cell whose title
 * names no row runs on every runner its kit registers it for.
 */
export function parityRunners(family: ParityFamilyName, row: string | undefined): readonly RunnerId[] {
  const entry: ParityFamily = PARITY_FAMILIES[family];
  if (entry.class === 'every-runner' || row === undefined) return RUNNER_IDS;
  if (entry.class === 'no-session') return [NO_SESSION_RUNNER];
  if (entry.everyRunner?.[row] !== undefined || EXEMPT_ROWS.has(row)) return RUNNER_IDS;
  return SHARED_RUNNERS;
}

/** Whether `runner` runs the family's row. */
export function runsOn(family: ParityFamilyName, row: string | undefined, runner: RunnerId): boolean {
  return parityRunners(family, row).includes(runner);
}


/** The row id a parity cell title names as its second word (`codex R48 …`, `claude U7k …`), if any. */
export function parityRowId(title: string): string | undefined {
  const word = title.split(' ')[1];
  return word !== undefined && /^[A-Z]{1,2}\d+[a-z]*$/.test(word) ? word : undefined;
}

type Register = (title: string, ...rest: never[]) => unknown;

/**
 * `register` for one runner's cells of a family, dropping each cell whose row does not run on that
 * runner. Collectors and Vitest's `it` pass through the same filter, so a registration guard counts
 * what runs. A title with no row id always registers.
 */
export function familyCells<T extends Register>(family: ParityFamilyName, runner: RunnerId, register: T): T {
  return ((title: string, ...rest: never[]) => runsOn(family, parityRowId(title), runner) ? register(title, ...rest) : undefined) as T;
}
