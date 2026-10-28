import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_AUTOSAVE_RECORDS_MAX, type HandoffRecords } from '@open-mercato/cezar-contract/handoff';

import {
  HANDOFF_ONLY_INSTRUCTIONS,
  handoffInstructions,
  handoffPath,
  recordHandoffAutosave,
  recordHandoffPeriodicAutosave,
  refreshHandoffRecords,
  renderHandoffRecords,
  seedHandoffFile,
} from './handoff.ts';
import { RunStore } from './runs/store.ts';
import { blockRunWrites, muteLockedDatabaseLogs, readPersistedRuns } from './runs/run-store.testkit.ts';

const BEGIN = '<!-- cezar:records — cezar rewrites this block whole from its run store; edits here are replaced -->';
const END = '<!-- /cezar:records -->';
const block = (...lines: string[]) => `${BEGIN}\n## Cezar records\n\n### Autosave\n\n${lines.map((line) => `${line}\n`).join('')}${END}\n`;
const records = (...notes: string[]): HandoffRecords => ({ autosave: notes.map((note) => ({ at: '2026-10-16T10:00:00.000Z', note })) });
const SEEDED = '# Handoff — t\n\n**Task id:** run-1\n**Workflow:** quick-task\n\n## Goal\n\ndo it\n\n## Progress log\n\n## Resume notes\n';

/**
 * hearsay-tools/cezarion#1809: cezar's records live in the run store and reach the file as one
 * block that cezar rewrites whole. Nothing outside the block is read or changed.
 */
describe('renderHandoffRecords', () => {
  it('inserts the block right before the seeded Goal and leaves every other byte', () => {
    const text = renderHandoffRecords(SEEDED, records('turn end: committed abc1234'));
    expect(text).toBe(SEEDED.replace('## Goal\n', `${block('- 2026-10-16T10:00:00.000Z — turn end: committed abc1234')}\n## Goal\n`));
    expect(renderHandoffRecords(text, records('turn end: committed abc1234'))).toBe(text);
  });

  it('replaces the block whole, so an edit inside it does not survive', () => {
    const text = renderHandoffRecords(SEEDED, records('first'));
    const edited = text.replace('— first', '— first (agent edit)');
    expect(renderHandoffRecords(edited, records('second', 'first'))).toBe(
      SEEDED.replace('## Goal\n', `${block('- 2026-10-16T10:00:00.000Z — second', '- 2026-10-16T10:00:00.000Z — first')}\n## Goal\n`));
  });

  it('removes the block when there are no records, and writes none into a file without one', () => {
    expect(renderHandoffRecords(renderHandoffRecords(SEEDED, records('first')), undefined)).toBe(SEEDED.replace('## Goal\n', '\n## Goal\n'));
    expect(renderHandoffRecords(SEEDED, undefined)).toBe(SEEDED);
    expect(renderHandoffRecords(SEEDED, { autosave: [] })).toBe(SEEDED);
  });

  it('finds the block wherever the agent moved it', () => {
    const moved = `${SEEDED}\n${block('- old')}`;
    expect(renderHandoffRecords(moved, records('new'))).toBe(`${SEEDED}\n${block('- 2026-10-16T10:00:00.000Z — new')}`);
  });

  it('reads the markers only as whole lines (hearsay-tools/cezarion#1147)', () => {
    const quoted = SEEDED.replace('do it', `Explain the "${BEGIN}" line\n\n## Goal quoted`);
    const text = renderHandoffRecords(quoted, records('first'));
    expect(text).toContain(`Explain the "${BEGIN}" line`);
    expect(text.startsWith(`# Handoff — t\n\n**Task id:** run-1\n**Workflow:** quick-task\n\n${BEGIN}\n`)).toBe(true);
    // The next render replaces the real block, never the quoted marker.
    expect(renderHandoffRecords(text, records('second'))).toBe(renderHandoffRecords(quoted, records('second')));
  });

  // An agent or an editor can save the file with CRLF endings (hearsay-tools/cezarion#1809).
  it('finds the markers and the Goal in a file with CRLF endings, so a render adds no second block', () => {
    const crlf = (text: string) => text.replaceAll('\n', '\r\n');
    const seeded = crlf(SEEDED);
    const first = renderHandoffRecords(seeded, records('first'));
    expect(first).toBe(seeded.replace('## Goal\r\n', `${block('- 2026-10-16T10:00:00.000Z — first')}\n## Goal\r\n`));
    expect(renderHandoffRecords(first, records('first'))).toBe(first);
    // The agent saved the whole file, block included, with CRLF endings.
    const saved = crlf(renderHandoffRecords(SEEDED, records('first')));
    expect(renderHandoffRecords(saved, records('second'))).toBe(
      seeded.replace('## Goal\r\n', `${block('- 2026-10-16T10:00:00.000Z — second')}\r\n## Goal\r\n`));
    expect(renderHandoffRecords(saved, records())).toBe(seeded.replace('## Goal\r\n', '\r\n## Goal\r\n'));
  });

  it('takes a begin marker without its end marker as one line', () => {
    const broken = SEEDED.replace('## Goal\n', `${BEGIN}\n## Goal\n`);
    expect(renderHandoffRecords(broken, records('first'))).toBe(
      SEEDED.replace('## Goal\n', `${block('- 2026-10-16T10:00:00.000Z — first')}## Goal\n`));
  });

  it('puts the block at the start of a file without a Goal, and keeps an empty text empty', () => {
    expect(renderHandoffRecords('free-form notes', records('first'))).toBe(`${block('- 2026-10-16T10:00:00.000Z — first')}\nfree-form notes`);
    expect(renderHandoffRecords('', records('first'))).toBe('');
  });

  // A journal from before hearsay-tools/cezarion#1809 keeps its old section and lifecycle lines.
  it('leaves a legacy Autosave section and heartbeat lines byte for byte', () => {
    const legacy = SEEDED.replace('## Progress log\n\n', '## Autosave (cezar)\n\n- 2026-10-15T09:00:00.000Z — turn end: committed 0ld0000\n\n' +
      '## Progress log\n\n- 2026-10-15T09:01:00.000Z — turn complete — status=waiting\n- 09:00 — agent line\n');
    expect(renderHandoffRecords(legacy, records('first'))).toBe(
      legacy.replace('## Goal\n', `${block('- 2026-10-16T10:00:00.000Z — first')}\n## Goal\n`));
  });
});

describe('the store-backed autosave records', () => {
  const BRANCH = 'cez/run-1';
  let dataDir: string;
  let store: RunStore;
  let runId: string;
  const file = () => handoffPath(dataDir, runId);
  const read = () => readFileSync(file(), 'utf8');
  /** The block's record lines, newest first. */
  const lines = () => {
    const text = read();
    const start = text.indexOf(`${BEGIN}\n`);
    if (start < 0) return [];
    return text.slice(start, text.indexOf(`\n${END}\n`, start)).split('\n').filter((line) => line.startsWith('- '));
  };
  const periodic = (count: number, first: string, latest: string, branch = BRANCH, fold = `${latest}~1`) =>
    `periodic: ${count} cezar autosave commit(s) on ${branch}, first ${first}, latest ${latest}; ` +
    `to fold the latest into your own commits while it is HEAD, run \`git reset --soft ${fold}\``;
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const recordPeriodic = (sha: string | null, branch: string | null = BRANCH) =>
    recordHandoffPeriodicAutosave(store, dataDir, runId, { sha, branch });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
    mkdirSync(join(dataDir, 'runs'));
    store = RunStore.open(dataDir);
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 'do it', steps: [] }).id;
    store.updateRun(runId, { branch: BRANCH });
    store.flush();
    seedHandoffFile(dataDir, store.getRun(runId)!);
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-16T10:00:00.000Z');
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('commits the record to the store and shows it in the file, outside the Progress log', () => {
    recordHandoffAutosave(store, dataDir, runId, 'turn end: cezar autosave committed abc1234 on cez/run-1');
    const committed = readPersistedRuns(dataDir).find((run) => run.id === runId);
    expect(committed.handoffRecords).toEqual({ autosave: [{ at: '2026-10-16T10:00:00.000Z', note: 'turn end: cezar autosave committed abc1234 on cez/run-1' }] });
    expect(lines()).toEqual(['- 2026-10-16T10:00:00.000Z — turn end: cezar autosave committed abc1234 on cez/run-1']);
    expect(read().indexOf(BEGIN)).toBeLessThan(read().indexOf('## Goal\n'));
    expect(read().slice(read().indexOf('## Progress log'))).toBe('## Progress log\n\n## Resume notes\n');
  });

  it('never shows a record the store refused', () => {
    const unmute = muteLockedDatabaseLogs();
    const release = blockRunWrites(dataDir);
    try {
      expect(() => recordHandoffAutosave(store, dataDir, runId, 'turn end: refused')).not.toThrow();
    } finally {
      release();
      unmute();
    }
    expect(read()).not.toContain('turn end: refused');
    expect(readPersistedRuns(dataDir).find((run) => run.id === runId)).toMatchObject({ branch: BRANCH });
    expect(readPersistedRuns(dataDir).find((run) => run.id === runId).handoffRecords).toBeUndefined();
  });

  // The agent owns the file. Before hearsay-tools/cezarion#1809 the file was the only copy, so a
  // rewrite without the section lost every record and an edited periodic line restarted the count.
  it('keeps every record when the agent rewrites the file without the block', () => {
    recordHandoffAutosave(store, dataDir, runId, 'turn end: committed aaa1111');
    writeFileSync(file(), '# My own handoff\n\n## Progress log\n\n- 10:00 — rewrote it\n');
    recordHandoffAutosave(store, dataDir, runId, 'turn end: committed bbb2222');
    expect(lines()).toEqual(['- 2026-10-16T10:00:00.000Z — turn end: committed bbb2222', '- 2026-10-16T10:00:00.000Z — turn end: committed aaa1111']);
    expect(read().endsWith('# My own handoff\n\n## Progress log\n\n- 10:00 — rewrote it\n')).toBe(true);
  });

  it.each([
    ['a truncated line', (line: string) => line.slice(0, 60)],
    ['trailing text', (line: string) => `${line} (squashed)`],
    ['a deleted line', () => ''],
  ])('counts on after the agent edits the periodic line: %s', (_name, edit) => {
    recordPeriodic('aaa1111');
    const [line] = lines();
    writeFileSync(file(), read().replace(`${line!}\n`, edit(line!) ? `${edit(line!)}\n` : ''));
    at('2026-10-16T10:01:30.000Z');
    recordPeriodic('bbb2222');
    expect(lines()).toEqual([`- 2026-10-16T10:01:30.000Z — ${periodic(2, 'aaa1111', 'bbb2222')}`]);
  });

  it('merges consecutive commits on one branch into one record: count, first, latest, time', () => {
    recordPeriodic('aaa1111');
    at('2026-10-16T10:01:30.000Z');
    recordPeriodic('bbb2222');
    at('2026-10-16T10:03:00.000Z');
    recordPeriodic('ccc3333');
    expect(lines()).toEqual([`- 2026-10-16T10:03:00.000Z — ${periodic(3, 'aaa1111', 'ccc3333')}`]);
    expect(store.getRun(runId)?.handoffRecords?.autosave).toEqual([{
      at: '2026-10-16T10:03:00.000Z', note: periodic(3, 'aaa1111', 'ccc3333'),
      periodic: { branch: BRANCH, count: 3, first: 'aaa1111', latest: 'ccc3333' },
    }]);
  });

  it('starts a new record on a different branch', () => {
    recordPeriodic('aaa1111');
    recordPeriodic('bbb2222', 'fix/1004-x');
    expect(lines()).toEqual([
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'bbb2222', 'bbb2222', 'fix/1004-x')}`,
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'aaa1111', 'aaa1111')}`,
    ]);
  });

  it('starts a new record after a turn-end or run-finalize report, which ends the run of commits', () => {
    recordPeriodic('aaa1111');
    recordHandoffAutosave(store, dataDir, runId, 'turn end: cezar autosave committed bbb2222 on cez/run-1');
    recordPeriodic('ccc3333');
    expect(lines()).toEqual([
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'ccc3333', 'ccc3333')}`,
      '- 2026-10-16T10:00:00.000Z — turn end: cezar autosave committed bbb2222 on cez/run-1',
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'aaa1111', 'aaa1111')}`,
    ]);
  });

  it('counts a commit whose sha could not be read, folding back from HEAD', () => {
    recordPeriodic(null);
    expect(lines()).toEqual([`- 2026-10-16T10:00:00.000Z — ${periodic(1, '(sha unavailable)', '(sha unavailable)', BRANCH, 'HEAD~1')}`]);
    recordPeriodic('bbb2222');
    expect(lines()).toEqual([`- 2026-10-16T10:00:00.000Z — ${periodic(2, '(sha unavailable)', 'bbb2222')}`]);
    recordPeriodic(null);
    expect(lines()).toEqual([`- 2026-10-16T10:00:00.000Z — ${periodic(3, '(sha unavailable)', '(sha unavailable)', BRANCH, 'HEAD~1')}`]);
  });

  it('names a detached HEAD and keeps it apart from a branch', () => {
    recordPeriodic('aaa1111', null);
    recordPeriodic('bbb2222', null);
    recordPeriodic('ccc3333');
    expect(lines()).toEqual([
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'ccc3333', 'ccc3333')}`,
      `- 2026-10-16T10:00:00.000Z — ${periodic(2, 'aaa1111', 'bbb2222', 'detached HEAD')}`,
    ]);
  });

  // Git refuses only ASCII space and control characters in a ref name, so a branch can carry
  // Unicode whitespace (round 7 on hearsay-tools/cezarion#1111). The merge compares the stored
  // branch, never a parsed line.
  it.each([
    ['U+00A0 no-break space', 'fix/a b'],
    ['U+2003 em space', 'fix/a b'],
  ])('merges on a branch whose name holds Unicode whitespace: %s', (_name, branch) => {
    recordPeriodic('aaa1111', branch);
    at('2026-10-16T10:01:30.000Z');
    recordPeriodic('bbb2222', branch);
    expect(store.getRun(runId)?.handoffRecords?.autosave.map((record) => record.periodic?.count)).toEqual([2]);
    expect(lines()).toEqual([`- 2026-10-16T10:01:30.000Z — ${periodic(2, 'aaa1111', 'bbb2222', branch)}`]);
  });

  it(`keeps the newest ${HANDOFF_AUTOSAVE_RECORDS_MAX} records`, () => {
    for (let n = 0; n <= HANDOFF_AUTOSAVE_RECORDS_MAX; n++) recordHandoffAutosave(store, dataDir, runId, `turn end: save ${n}`);
    expect(lines()).toHaveLength(HANDOFF_AUTOSAVE_RECORDS_MAX);
    expect(lines()[0]).toContain(`save ${HANDOFF_AUTOSAVE_RECORDS_MAX}`);
    expect(lines().at(-1)).toContain('save 1');
  });

  it('still records when the file is missing, and the next launch shows it', () => {
    rmSync(file());
    recordHandoffAutosave(store, dataDir, runId, 'turn end: committed aaa1111');
    expect(() => read()).toThrow();
    expect(store.getRun(runId)?.handoffRecords?.autosave).toHaveLength(1);
    seedHandoffFile(dataDir, store.getRun(runId)!);
    refreshHandoffRecords(store, dataDir, runId);
    expect(lines()).toEqual(['- 2026-10-16T10:00:00.000Z — turn end: committed aaa1111']);
  });

  it('does nothing for an unknown run or a closed store', () => {
    expect(() => recordHandoffAutosave(store, dataDir, 'missing', 'turn end: x')).not.toThrow();
    expect(() => refreshHandoffRecords(store, dataDir, 'missing')).not.toThrow();
    store.close();
    expect(() => recordHandoffAutosave(store, dataDir, runId, 'turn end: x')).not.toThrow();
    expect(() => refreshHandoffRecords(store, dataDir, runId)).not.toThrow();
    expect(read()).toBe(SEEDED.replace('run-1', runId).replace('quick-task\n', `quick-task\n**Branch:** ${BRANCH}\n`));
    store = RunStore.open(dataDir);
  });

  it('a refresh restores a deleted block and leaves a file without records as it is', () => {
    expect(() => refreshHandoffRecords(store, dataDir, runId)).not.toThrow();
    const seeded = read();
    refreshHandoffRecords(store, dataDir, runId);
    expect(read()).toBe(seeded);
    recordHandoffAutosave(store, dataDir, runId, 'turn end: committed aaa1111');
    writeFileSync(file(), seeded);
    refreshHandoffRecords(store, dataDir, runId);
    expect(lines()).toEqual(['- 2026-10-16T10:00:00.000Z — turn end: committed aaa1111']);
  });
});

// hearsay-tools/cezarion#1234: a session with cezar tools is taught the tools, not the lifecycle
// markers; a session without them keeps today's prompt.
describe('handoffInstructions', () => {
  it('the tool variant teaches cezar_done, cezar_ask and cezar_wait and no lifecycle marker', () => {
    const text = handoffInstructions({ tools: true });
    expect(text).toContain('Lifecycle tools (cezar): End every turn with a cezar tool call that says what happens next. When the goal is fully achieved and verified and you have no question for the user, call cezar_done, then end your turn.');
    expect(text).toContain('When a user decision or missing input is needed, call cezar_ask with the complete decision context and short questions. Put the full draft, findings, evidence and option meanings in context. Cezar shows context as Markdown above the card. Reasoning and rejected calls are hidden. Give a question 2–4 options to show them as choices, or leave its options out and the user types the answer. Once the call accepts the context and questions, end the turn and wait for the user.');
    expect(text).toContain('call cezar_wait with kind "pr" for a pull request\'s checks or its merge, or kind "timer" to re-check later');
    expect(text).not.toContain('kind "human"');
    // A reply settles the question; only CI waits and timers wait for a result or a cancel.
    expect(text).toContain("A human message or any resolved wait wakes you. The user's reply answers your question; PR waits and timers stay open until they resolve or you cancel them with cezar_cancel_wait.");
    expect(text).toContain('Never call cezar_done while anything is unfinished or unverified.');
    for (const marker of ['CEZ:DONE', 'CEZ:MONITORING', 'CEZ:ASK']) expect(text).not.toContain(marker);
    expect(text).toContain('CEZ:PR=');
    expect(text).toContain('## Pasted attachments');
    expect(text).toMatch(/"Cezar records" block[^\n]*never edit it/);
    expect(text).not.toContain('Autosave (cezar)');
    expect(text).not.toContain('CEZ_TODOS_FILE');
  });

  // hearsay-tools/cezarion#1994: at shipped defaults, native cross-session tools stay callable
  // on some runners, so every session learns that tasks talk only through `cez message`.
  it.each([true, false])('steers agents off native cross-session messaging (tools=%s)', tools => {
    const text = handoffInstructions({ tools });
    expect(text).toContain('## Messaging other tasks');
    expect(text).toContain('Cezar tasks talk to each other only through `cez message`, which needs `CEZ_DELEGATION=1`; with it, your delegation instructions give the full command and its verbs (`tasks`, `request`, `progress`, `reply`).');
    expect(text).toContain("Never use your runner's native cross-session tools to reach another task or agent session, for example Claude's SendMessage or ListAgents for other sessions.");
    expect(text).toContain('Without `CEZ_DELEGATION=1` no agent channel to another task exists: tell the user instead.');
    expect(text).toContain('`cez task send` is human input and refuses to run inside a task.');
    expect(text).toContain('Native subagents inside your own session are not tasks.');
  });

  it('the marker variant is unchanged', () => {
    expect(handoffInstructions({ tools: false })).toBe(HANDOFF_ONLY_INSTRUCTIONS);
  });

  // hearsay-tools/cezarion#1428: agents asked about drafts and findings they never sent, once
  // after a plain ask and once after the content lived only in rejected tool-call arguments.
  // hearsay-tools/cezarion#1458: on Claude, assistant text between tool calls may never arrive, so
  // the tool variant puts the content in context; the marker's own message text still arrives.
  it('the tool variant puts the decision context in the call, the marker variant in the message', () => {
    const tools = handoffInstructions({ tools: true });
    expect(tools).not.toContain('as assistant text');
    expect(tools).toContain('Put the full draft, findings, evidence and option meanings in context.');
    const markers = handoffInstructions({ tools: false });
    expect(markers).toContain('Before the CEZ:ASK line, send everything the decision depends on (the full draft, every finding, what each option means) as ordinary text in the same message.');
    expect(markers).toContain('The user sees only your message text and the chips. Your reasoning never reaches them, so never call content "above" unless you sent it as message text.');
    expect(markers).toContain('plus an optional "context" of up to 20000 characters of Markdown shown above the chips');
  });
});
