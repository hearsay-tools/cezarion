import { parentWithWorker, sessionOf, retryClock, nudgeNotes, nativeWire, parkedOn, waitOfKind, fireTimer, settled, prompted, inputsFor, workerParent, turnEnds, blockedDone, blockingWorker, liveRefusal, agentWaits, humanOpen, gated, workerWaits, repliesDoneAgain, replyBlockedAgain, describeWaitCells } from './waits-parity-fixture.testkit.ts';
import { registrationGroups } from '../core/registration-coverage.testkit.ts';
import { runtimeImports } from '../core/module-imports.testkit.ts';
import { COMPLETION_NUDGE_NOTE } from './run.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { it as registerTest, expect } from 'vitest';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { type RunnerId, RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { familyCells } from '../core/parity-classes.testkit.ts';
import { collect, store, until, manager, semaphore, waitOf, root, terminal } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { NO_WAIT_NUDGE } from './turn-end.ts';
import { toolCall, thenSay, WAIT_CRITERIA } from './waits-parity.testkit.ts';
import { answersCells } from './waits-parity-answers-cells.testkit.ts';
import { asksCells } from './waits-parity-asks-cells.testkit.ts';
import { closedCells } from './waits-parity-closed-cells.testkit.ts';
import { completionCells } from './waits-parity-completion-cells.testkit.ts';
import { completionRepliesCells } from './waits-parity-completion-replies-cells.testkit.ts';
import { conversationsCells } from './waits-parity-conversations-cells.testkit.ts';
import { deliveryCells } from './waits-parity-delivery-cells.testkit.ts';
import { doneCells } from './waits-parity-done-cells.testkit.ts';
import { entriesCells } from './waits-parity-entries-cells.testkit.ts';
import { inputCells } from './waits-parity-input-cells.testkit.ts';
import { mixedCells } from './waits-parity-mixed-cells.testkit.ts';
import { processCells } from './waits-parity-process-cells.testkit.ts';
import { recoveryCells } from './waits-parity-recovery-cells.testkit.ts';
import { refusalCells } from './waits-parity-refusal-cells.testkit.ts';
import { registrationCells } from './waits-parity-registration-cells.testkit.ts';
import { type WaitParityPart, type WaitCells, type WaitFold, foldCells, splitPart, folded, WAIT_PARITY_FILES, WAIT_PARITY_FAMILIES, ROW_FAMILIES, type FamilyPart, familyTest, WAIT_FOLDS, foldedWaitFile, FOLDED_WAIT_RUNNERS, waitPartModule, waitFoldModule } from './waits-parity-catalog.testkit.ts';

// The full registry of the wait parity cells. Only `waits-parity.test.ts` imports it: it guards the
// catalog and runs the single-runner cells. Each per-runner file imports its part's or fold's module
// (`waitPartModule`, `waitFoldModule`), so it loads no other part's cells (hearsay-tools/cezarion#3242).
const it = registerTest;

const WAIT_PARITY_CELLS = {
  registration: registrationCells,
  input: inputCells,
  delivery: deliveryCells,
  asks: asksCells,
  done: doneCells,
  answers: answersCells,
  mixed: mixedCells,
  recovery: recoveryCells,
  conversations: conversationsCells,
  refusal: refusalCells,
  completion: completionCells,
  'completion-replies': completionRepliesCells,
  closed: closedCells,
  process: processCells,
  entries: entriesCells,
} satisfies Record<WaitParityPart, WaitCells>;

/** The titles a folded runner's group registers. */
function foldTitles(runner: RunnerId, fold: WaitFold): string[] {
  const titles: string[] = [];
  foldCells(runner, fold, WAIT_PARITY_CELLS, ((title: string) => { titles.push(title); }) as typeof registerTest);
  return titles;
}

/** Each wait parity cells module a test file imports: the registry, a part's or a fold's. */
function cellModules(file: string): string[] {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  return runtimeImports(source, file).flatMap(specifier => /^\.\/(waits-parity-(?:[a-z-]+-)?(?:cells|fold)\.testkit\.ts)$/.exec(specifier)?.[1] ?? []);
}

/** Whether a runner runs any cell of a part, after the wait family's class (hearsay-tools/cezarion#2991)
 *  drops the shared rows outside the derived runner set. A part with none has no file. */
export function partRuns(runner: RunnerId, part: WaitParityPart): boolean {
  let any = false;
  WAIT_PARITY_CELLS[part]([runner], familyCells('waits', runner, (() => { any = true; }) as unknown as typeof registerTest));
  return any;
}

function expectPartLeaf(runner: RunnerId, part: WaitParityPart): void {
  if (splitPart(runner, part)) return; // Full-title family coverage is checked separately below.
  if (folded(runner)) return; // Its one file is checked below.
  if (!partRuns(runner, part)) return;
  const file = WAIT_PARITY_FILES[part](runner);
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  expect(source.match(/describeWaitParity\([^;]+\)/g), file).toEqual([`describeWaitParity({ runner: '${runner}', part: '${part}' })`]);
  // It imports its part's module and no other cells module.
  expect(cellModules(file), file).toEqual([waitPartModule(part)]);
}

function familyCalls(): Array<{ file: string; family: keyof typeof WAIT_PARITY_FAMILIES }> {
  return readdirSync(new URL('.', import.meta.url)).filter(file => file.endsWith('.test.ts')).flatMap(file =>
    registrationGroups(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), file,
      'describeWaitParityFamily', 'WAIT_PARITY_FAMILIES', Object.keys(WAIT_PARITY_FAMILIES))
      .map(family => ({ file, family: family as keyof typeof WAIT_PARITY_FAMILIES })));
}

function expectWaitParityFamilies(): void {
  const found = familyCalls();
  const calls = found.map(call => call.family);
  expect(calls.slice().sort()).toEqual(Object.keys(WAIT_PARITY_FAMILIES).sort());
  // A family file imports its part's cells module and no other.
  for (const { file, family } of found) expect(cellModules(file), file).toEqual([waitPartModule(WAIT_PARITY_FAMILIES[family].part)]);
  for (const runner of RUNNER_IDS) {
    for (const part of Object.keys(ROW_FAMILIES) as FamilyPart[]) {
      if (!splitPart(runner, part)) continue;
      const expected: string[] = [], actual: string[] = [];
      const collect = (names: string[]) => ((title: string) => { names.push(title); }) as typeof registerTest;
      WAIT_PARITY_CELLS[part]([runner], collect(expected));
      for (const name of calls) {
        const scope = WAIT_PARITY_FAMILIES[name];
        if (scope.runner === runner && scope.part === part) WAIT_PARITY_CELLS[part]([runner], familyTest(scope, collect(actual)));
      }
      expect(actual.sort(), `${runner} ${part}: each full row exactly once`).toEqual(expected.sort());
    }
  }
}

// hearsay-tools/cezarion#1531: the single-runner cells run once, on the claude wire, from
// `waits-parity.test.ts`. They take no runner: a cell for every runner goes in its part's cell group
// (the semantic row families in `WAIT_PARITY_CELLS`), which the per-runner files run.
function singleRunnerCells(): void {
  // The first failure and its durable refusal remain a public native-wire case. Repeated
  // closed-session gate effects use real-manager recovery in turn-nudges-decisions.test.ts.
  it('a closed session leaves one charged refusal owed through its first delivery failure', async () => {
    const { p, w } = await parentWithWorker('claude');
    const refusal = `Workers are still live: ${w.id}.`;
    const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
    let closing = true;
    const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
      if (runId === p.id && event.type === 'turn-end' && closing && refusals().some(input => !input.deliveredAt)) sessionOf(p.id).end();
    };
    store.on('event', closeAtTurnEnd);
    try {
      const wakes = store.getRun(p.id)?.automaticWakes ?? 0;
      sessionOf(p.id).end();
      await until(() => store.getRun(p.id)?.waitDeliveryFailures === 1 && !manager.isActive(p.id) && retryClock.pending > 0);
      closing = false;
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]!.deliveredAt).toBeUndefined();
      expect(nudgeNotes(p.id)).toHaveLength(1);
      expect(store.getRun(p.id)?.automaticWakes).toBe(wakes + 1);
    } finally {
      store.off('event', closeAtTurnEnd);
    }
  });

  // hearsay-tools/cezarion#1301: a wait's lifecycle input is that wait's. Once the wait is
  // delivered, the same input undelivered again (a replay) is not a fresh wake.
  it('a delivered wait\'s lifecycle input is never owed again', async () => {
    nativeWire('claude');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'reowed' }), runner: 'claude' });
    await until(() => parkedOn(run.id, waitOfKind(run.id, 'timer')));
    const timer = waitOfKind(run.id, 'timer')!;
    fireTimer(timer.id);
    await until(() => settled(run.id, timer.id)?.phase === 'delivered' && store.getRun(run.id)?.status === 'waiting');
    const input = store.getRun(run.id)!.agentInputs!.find(input => input.id === timer.id)!;
    const nativeBefore = prompted('claude', input.text).length;
    const wakesBefore = store.getRun(run.id)?.automaticWakes;
    store.commitOutcome(run.id, { kind: 'requeued', inputIds: [timer.id] });
    const replayed = structuredClone(store.getRun(run.id)!.agentInputs!);
    await manager.recover();
    await semaphore.release();
    expect(prompted('claude', input.text)).toHaveLength(nativeBefore);
    expect(store.getRun(run.id)?.automaticWakes).toBe(wakesBefore);
    expect(inputsFor(run.id, timer.id).map(input => input.deliveredAt)).toEqual([undefined]);
    // A lifecycle input no wait names is still owed and wakes this same parked session.
    const orphan: AgentInput = { id: randomUUID(), parentRunId: run.id, source: 'lifecycle', text: 'orphan', createdAt: new Date().toISOString() };
    store.commitAgentInputs(run.id, [...replayed, orphan]);
    await manager.recover();
    await semaphore.release();
    await until(() => inputsFor(run.id, orphan.id).some(input => !!input.deliveredAt) && prompted('claude', orphan.text).length > 0);
    expect(prompted('claude', orphan.text)).toHaveLength(1);
    // The orphan supplies the wake; a replay may ride along after another input wakes it.

  });

  // hearsay-tools/cezarion#1301: a refused done is not a done and cancels no wait. With a wait open
  // at that turn end there is no nudge: the run parks on the wait, and the refusal is a note.
  it('a blocked done with an open wait parks on that wait without a nudge', async () => {
    const p = await workerParent('claude');
    const turns = turnEnds(p.id);
    const timerThen = (prompt: string) => expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u20 timer' })} ${prompt}` }])).toBe(true);
    const w = await blockedDone(p.id, () => blockingWorker(p.id), timerThen);
    await until(() => turnEnds(p.id) > turns && parkedOn(p.id, waitOfKind(p.id, 'timer')));
    const refusal = liveRefusal(w);
    expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).includes(refusal))).toHaveLength(1);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toBe(false);
    expect(prompted('claude', refusal)).toEqual([]);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    expect(agentWaits(p.id)).toEqual([expect.objectContaining({ kind: WAIT_KIND.timer, phase: WAIT_PHASE.open })]);
  });

  // hearsay-tools/cezarion#1301: only an accepted cezar_done in the nudge's reply turn takes the
  // second step. A cezar_done refused mid-turn is no done: the turn ended with no wait.
  it('a tool-refused done in the nudge\'s reply turn takes the no-wait rule', async () => {
    process.env.CEZ_MOCK_COMPLETION_REPLY = `${toolCall('cezar_done', {})} ${thenSay('I will collect it next.')}`;
    const p = await workerParent('claude');
    // Uncollected only: with live workers the ordinary rule would open the implicit re-check timer.
    const w = await blockedDone(p.id, () => blockingWorker(p.id, { uncollected: true }));
    await until(() => prompted('claude', NO_WAIT_NUDGE).length > 0 && humanOpen(p.id)[0]?.via === 'no-wait' && gated(p.id));
    expect(prompted('claude', `Collect each (\`worker collect ${w.id}\`)`)).toHaveLength(1);
    expect(workerWaits(p.id)).toEqual([]);
    expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
  });

  it('workers settled during the nudge turn let the done finish', async () => {
    const release = join(root, 'release-u21');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    process.env.CEZ_MOCK_COMPLETION_REPLY = 'mock:hold-cezar-done';
    const p = await workerParent('claude');
    const w = await blockedDone(p.id, () => blockingWorker(p.id));
    await until(() => prompted('claude', liveRefusal(w)).length > 0);
    // While the reply turn is held, the worker settles and its result is collected.
    manager.requestWorkerStop(w.id);
    expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await collect(w.id);
    writeFileSync(release, '');
    await until(() => terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.status).not.toBe('failed');
    expect(workerWaits(p.id)).toEqual([]);
    expect([...store.getRun(p.id)?.waits ?? [], ...store.getRun(p.id)?.lastWaits ?? []].filter(wait => wait.via === 'completion')).toEqual([]);
  });

  it('the completion wait names only live workers', async () => {
    const reply = repliesDoneAgain();
    const p = await workerParent('claude');
    const first = await blockedDone(p.id, () => blockingWorker(p.id));
    await until(() => prompted('claude', liveRefusal(first)).length > 0);
    // The reply's done is blocked by a live worker and a settled, uncollected one.
    const live = await replyBlockedAgain(p.id, reply, first, async () => {
      await blockingWorker(p.id, { uncollected: true });
      return blockingWorker(p.id);
    });
    await until(() => store.getRun(p.id)?.status === 'waiting' && workerWaits(p.id)[0]?.phase === 'open');
    const entry = workerWaits(p.id)[0]!;
    expect(entry.workerIds).toEqual([live.id]);
    expect(entry.revisions).toEqual([{ workerId: live.id, revision: expect.any(Number) }]);
  });
}

/** The matrix guards and the single-runner cells, from `waits-parity.test.ts`. */
export function describeWaitParity(scope: 'once'): void {
  if (scope !== 'once') throw Error(`Import the module of the ${String(scope)} cells`);
  describeWaitCells(() => {
    it('runs every runner\'s cells from its own file', () => {
      const files = readdirSync(new URL('.', import.meta.url)).filter(file =>
        /^waits-.*-parity\.test\.ts$/.test(file) && readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').includes('describeWaitParity('));
      const parts = Object.keys(WAIT_PARITY_FILES) as WaitParityPart[];
      expect(files.sort()).toEqual(RUNNER_IDS.flatMap(runner => {
        if (folded(runner)) return (Object.keys(WAIT_FOLDS) as WaitFold[]).filter(fold => foldTitles(runner, fold).length > 0).map(fold => foldedWaitFile(runner, fold));
        return parts.filter(part => !splitPart(runner, part) && partRuns(runner, part)).map(part => WAIT_PARITY_FILES[part](runner));
      }).sort());
      for (const runner of RUNNER_IDS) for (const [part, file] of Object.entries(WAIT_PARITY_FILES) as Array<[WaitParityPart, (runner: RunnerId) => string]>) {
        expect(existsSync(new URL(`./${file(runner)}`, import.meta.url)), file(runner)).toBe(!folded(runner) && (partRuns(runner, part) || splitPart(runner, part)));
      }
      for (const runner of FOLDED_WAIT_RUNNERS) {
        // A folded runner splits no part by WAIT_PARITY_FAMILIES, its groups register each of its
        // cells exactly once, and each group with cells runs from its own file.
        expect(parts.filter(part => splitPart(runner, part)), runner).toEqual([]);
        const all: string[] = [];
        for (const part of parts) WAIT_PARITY_CELLS[part]([runner], familyCells('waits', runner, ((title: string) => { all.push(title); }) as typeof registerTest));
        const grouped = (Object.keys(WAIT_FOLDS) as WaitFold[]).flatMap(fold => foldTitles(runner, fold));
        expect(grouped.slice().sort(), `${runner}: each cell in exactly one group`).toEqual(all.slice().sort());
        for (const fold of Object.keys(WAIT_FOLDS) as WaitFold[]) {
          if (foldTitles(runner, fold).length === 0) continue;
          const source = readFileSync(new URL(`./${foldedWaitFile(runner, fold)}`, import.meta.url), 'utf8');
          expect(source.match(/describeWaitParity\([^;]+\)/g), foldedWaitFile(runner, fold)).toEqual([`describeWaitParity({ runner: '${runner}', part: 'every-runner', fold: '${fold}' })`]);
          // It imports its fold's module and no other cells module.
          expect(cellModules(foldedWaitFile(runner, fold)), foldedWaitFile(runner, fold)).toEqual([waitFoldModule(fold)]);
        }
      }
    });

    it('registers every criterion and runner in exactly one part', () => {
      for (const runner of RUNNER_IDS) {
        const owners = new Map<string, string[]>();
        for (const part of Object.keys(WAIT_PARITY_CELLS) as WaitParityPart[]) {
          const criteria = new Set<string>();
          const collect = ((title: string) => { criteria.add(title.split(' ')[1]!); }) as typeof registerTest;
          WAIT_PARITY_CELLS[part]([runner], collect);
          for (const criterion of criteria) owners.set(criterion, [...(owners.get(criterion) ?? []), part]);
          expectPartLeaf(runner, part);
        }
        expect([...owners.keys()].sort()).toEqual(WAIT_CRITERIA.map(row => row.id).sort());
        for (const [criterion, parts] of owners) expect(parts, `${runner} ${criterion}`).toHaveLength(1);
      }
    });

    it('registers every criterion', () => {
      expect(WAIT_CRITERIA.map(row => row.id)).toEqual(['U1', 'U4', 'U9', 'U2', 'U3', 'U7', 'U8', 'U8l', 'U8h', 'U10', 'U11', 'U12', 'U13', 'U14', 'U16', 'U16b', 'U9c', 'U7h', 'U7k', 'U7a', 'U9h', 'U6', 'U7d', 'U7q', 'U6s', 'U5', 'U5a', 'U5c', 'U5d', 'U18', 'U17', 'U15', 'U2w', 'U2t', 'U2c', 'U3w', 'U3n', 'U3r', 'U3d', 'U7w', 'U9w', 'U14m', 'U9u', 'U9v', 'U19', 'U19p', 'U19q', 'U19w', 'U20', 'U20u', 'U20h', 'U21', 'U21r', 'U21m', 'U21t', 'U21h', 'U21a', 'U22', 'U22s', 'U22c', 'U22f', 'U22k', 'U22r', 'U22x', 'U24', 'U24r', 'U26', 'U25', 'U1p', 'U2p', 'U4p', 'U9p', 'U9pr', 'U27', 'R13', 'R18', 'R17']);
      for (const runner of RUNNER_IDS) for (const row of WAIT_CRITERIA) expect(HARNESS_ADAPTERS[runner].scenarios[row.scenario]).toBeDefined();
    });

    it('registers every split row exactly once', expectWaitParityFamilies);

    singleRunnerCells();
  });
}
