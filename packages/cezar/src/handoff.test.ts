import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HANDOFF_INSTRUCTIONS,
  HANDOFF_ONLY_INSTRUCTIONS,
  appendHandoffAutosaveReport,
  appendHandoffHeartbeat,
  handoffInstructions,
  handoffPath,
  handoffProgressExcerpt,
  recordHandoffPeriodicAutosave,
  seedHandoffFile,
} from './handoff.ts';
import { todoSchema } from './todos.ts';

/**
 * HANDOFF_INSTRUCTIONS is the only thing that tells an agent what to append to todos.json,
 * so a field can be added to todoSchema and still never be written by anyone. `runnable`
 * shipped exactly that way. This pins the contract instead of the prose: every agent-writable
 * schema field has to appear in the instructions.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});

/**
 * hearsay-tools/cezarion#1004: the autosave report lives in its own section, so
 * the top of the Progress log stays the agent's own summary — the variant
 * compare column (`handoffProgressExcerpt`) and the draft-PR body read it.
 */
describe('appendHandoffAutosaveReport', () => {
  const RUN = 'run-1';
  const REPORT = 'run finalize: cezar autosave committed abc1234 on cez/run-1';
  let dataDir: string;
  const file = () => handoffPath(dataDir, RUN);
  const read = () => readFileSync(file(), 'utf8');
  /** Text of one `## Header` section, up to the next `## ` header. */
  const section = (header: string) => {
    const text = read();
    const start = text.indexOf(`${header}\n`);
    if (start < 0) return '';
    const rest = text.slice(start + header.length + 1);
    const next = rest.indexOf('\n## ');
    return next >= 0 ? rest.slice(0, next) : rest;
  };
  const seed = () => seedHandoffFile(dataDir, { id: RUN, title: 't', workflow: 'quick-task', task: 'do it', branch: 'cez/run-1' });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
    mkdirSync(join(dataDir, 'runs'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is not seeded: the section appears only when cezar first reports', () => {
    seed();
    expect(read()).not.toContain('## Autosave (cezar)');
  });

  it('creates the section right before the Progress log, keeping the agent line first there', () => {
    seed();
    appendHandoffHeartbeat(dataDir, RUN, 'implemented the change');

    appendHandoffAutosaveReport(dataDir, RUN, REPORT);

    const text = read();
    const autosave = text.indexOf('## Autosave (cezar)\n');
    expect(autosave).toBeGreaterThan(text.indexOf('## Goal\n'));
    expect(text.indexOf('## Progress log\n')).toBeGreaterThan(autosave);
    expect(section('## Autosave (cezar)')).toMatch(new RegExp(`^\\n- \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z — ${REPORT}\\n$`));
    expect(section('## Goal')).not.toContain(REPORT);
    expect(section('## Progress log')).not.toContain(REPORT);
    expect(handoffProgressExcerpt(text)).toMatch(/^- \S+ — implemented the change$/);
    expect(text.endsWith('## Resume notes\n')).toBe(true);
  });

  it('inserts newest first under an existing header', () => {
    seed();
    appendHandoffAutosaveReport(dataDir, RUN, 'first report');
    appendHandoffAutosaveReport(dataDir, RUN, 'second report');

    const lines = section('## Autosave (cezar)').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ — second report$/);
    expect(lines[1]).toMatch(/ — first report$/);
    expect(read().match(/^## Autosave \(cezar\)$/gm)).toHaveLength(1);
    expect(section('## Progress log')).not.toMatch(/report/);
  });

  it('finds an existing section wherever the agent moved it', () => {
    writeFileSync(file(), '# Handoff\n\n## Progress log\n\n- agent line\n\n## Autosave (cezar)\n\n- old report\n');

    appendHandoffAutosaveReport(dataDir, RUN, 'new report');

    expect(read()).toMatch(/## Autosave \(cezar\)\n\n- \S+ — new report\n- old report\n$/);
    expect(handoffProgressExcerpt(read())).toBe('- agent line');
  });

  it('appends the section at the end of a file without a Progress log', () => {
    writeFileSync(file(), '# Handoff\n\nfree-form notes');

    appendHandoffAutosaveReport(dataDir, RUN, REPORT);

    expect(read()).toMatch(new RegExp(`^# Handoff\\n\\nfree-form notes\\n\\n## Autosave \\(cezar\\)\\n\\n- \\S+ — ${REPORT}\\n$`));
  });

  it('is a no-op on a missing file', () => {
    expect(() => appendHandoffAutosaveReport(dataDir, RUN, REPORT)).not.toThrow();
    expect(() => readFileSync(file())).toThrow();
  });

  it('is the section the handoff instructions tell the agent to leave in place', () => {
    seed();
    appendHandoffAutosaveReport(dataDir, RUN, REPORT);
    const header = read().split('\n').find((line) => line.startsWith('## Autosave'));

    expect(HANDOFF_ONLY_INSTRUCTIONS).toContain(`"${header}"`);
    expect(HANDOFF_ONLY_INSTRUCTIONS).toMatch(/"## Autosave \(cezar\)" section[^\n]*leave it in place/);
  });
});

describe('handoffProgressExcerpt', () => {
  const log = (...lines: string[]) => `# Handoff\n\n## Progress log\n\n${lines.join('\n')}\n\n## Resume notes\n`;
  const agentLine = '- 2026-10-19T00:00:00.000Z — mock: implemented the change (dry run)';

  // The no-wait nudge adds a turn, and every turn end writes a lifecycle line at the top
  // (hearsay-tools/cezarion#1234): they must not push the agent's own summary out.
  it("shows the agent's own lines ahead of Cezar's lifecycle heartbeats", () => {
    const text = log(
      '- 2026-10-19T00:00:04.000Z — step "task" complete — status=done',
      '- 2026-10-19T00:00:03.000Z — turn complete — status=waiting',
      '- 2026-10-19T00:00:02.000Z — turn complete — status=running (no-wait nudge)',
      '- 2026-10-19T00:00:01.000Z — session idle-closed — status=waiting; Continue to resume',
      agentLine,
      '- 2026-10-18T23:59:00.000Z — picked from 2 variants',
    );
    expect(handoffProgressExcerpt(text)).toBe(`${agentLine}\n- 2026-10-18T23:59:00.000Z — picked from 2 variants`);
  });

  it('falls back to the heartbeats when the agent wrote nothing', () => {
    const lines = ['- 2026-10-19T00:00:02.000Z — turn complete — status=waiting', '- 2026-10-19T00:00:01.000Z — turn complete — status=running (no-wait nudge)'];
    expect(handoffProgressExcerpt(log(...lines))).toBe(lines.join('\n'));
  });
});

/**
 * hearsay-tools/cezarion#1004 review: the periodic timer's commits are reported too,
 * since a clean closing flush reports nothing. One line covers a run of consecutive
 * periodic commits on one branch, so a 90 s timer cannot bury the section.
 */
describe('recordHandoffPeriodicAutosave', () => {
  const RUN = 'run-1';
  const BRANCH = 'cez/run-1';
  let dataDir: string;
  const file = () => handoffPath(dataDir, RUN);
  const read = () => readFileSync(file(), 'utf8');
  const section = (header: string) => {
    const text = read();
    const start = text.indexOf(`${header}\n`);
    if (start < 0) return '';
    const rest = text.slice(start + header.length + 1);
    const next = rest.indexOf('\n## ');
    return next >= 0 ? rest.slice(0, next) : rest;
  };
  const lines = () => section('## Autosave (cezar)').split('\n').filter(Boolean);
  const periodic = (count: number, first: string, latest: string, branch = BRANCH, fold = `${latest}~1`) =>
    `periodic: ${count} cezar autosave commit(s) on ${branch}, first ${first}, latest ${latest}; ` +
    `to fold the latest into your own commits while it is HEAD, run \`git reset --soft ${fold}\``;
  const seed = () => seedHandoffFile(dataDir, { id: RUN, title: 't', workflow: 'quick-task', task: 'do it', branch: BRANCH });
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
    mkdirSync(join(dataDir, 'runs'));
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-10-16T10:00:00.000Z');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates the section right before the Progress log on the first periodic commit', () => {
    seed();
    appendHandoffHeartbeat(dataDir, RUN, 'implemented the change');

    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'abc1234', branch: BRANCH });

    const text = read();
    expect(text.indexOf('## Progress log\n')).toBeGreaterThan(text.indexOf('## Autosave (cezar)\n'));
    expect(section('## Autosave (cezar)')).toBe(`\n- 2026-10-16T10:00:00.000Z — ${periodic(1, 'abc1234', 'abc1234')}\n`);
    expect(section('## Progress log')).not.toContain('periodic');
    expect(handoffProgressExcerpt(text)).toMatch(/^- \S+ — implemented the change$/);
    expect(text.endsWith('## Resume notes\n')).toBe(true);
  });

  it('coalesces consecutive commits on the same branch into one line: count, first, latest, time', () => {
    seed();
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'aaa1111', branch: BRANCH });
    at('2026-10-16T10:01:30.000Z');
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'bbb2222', branch: BRANCH });
    at('2026-10-16T10:03:00.000Z');
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'ccc3333', branch: BRANCH });

    expect(lines()).toEqual([`- 2026-10-16T10:03:00.000Z — ${periodic(3, 'aaa1111', 'ccc3333')}`]);
    expect(read().match(/^## Autosave \(cezar\)$/gm)).toHaveLength(1);
    expect(handoffProgressExcerpt(read())).toBe('');
  });

  it('starts a new line on a different branch', () => {
    seed();
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'aaa1111', branch: BRANCH });
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'bbb2222', branch: 'fix/1004-x' });

    expect(lines()).toEqual([
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'bbb2222', 'bbb2222', 'fix/1004-x')}`,
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'aaa1111', 'aaa1111')}`,
    ]);
  });

  it('starts a new line after a turn-end or run-finalize report, which ends the run of commits', () => {
    seed();
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'aaa1111', branch: BRANCH });
    appendHandoffAutosaveReport(dataDir, RUN, 'turn end: cezar autosave committed bbb2222 on cez/run-1');
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'ccc3333', branch: BRANCH });

    expect(lines()).toEqual([
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'ccc3333', 'ccc3333')}`,
      '- 2026-10-16T10:00:00.000Z — turn end: cezar autosave committed bbb2222 on cez/run-1',
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'aaa1111', 'aaa1111')}`,
    ]);
  });

  it.each([
    ['a truncated line', `- 2026-10-16T09:00:00.000Z — periodic: 2 cezar autosave commit(s) on ${BRANCH}, first aaa1111, latest bbb2222`],
    ['a fold-back command that no longer names the latest', `- 2026-10-16T09:00:00.000Z — ${periodic(2, 'aaa1111', 'bbb2222', BRANCH, 'aaa1111~1')}`],
    ['trailing text', `- 2026-10-16T09:00:00.000Z — ${periodic(2, 'aaa1111', 'bbb2222')} (squashed)`],
    ['a count of zero', `- 2026-10-16T09:00:00.000Z — ${periodic(0, 'aaa1111', 'bbb2222')}`],
    ['no timestamp', `- ${periodic(2, 'aaa1111', 'bbb2222')}`],
  ])('starts a new line instead of guessing at an edited periodic line: %s', (_name, edited) => {
    writeFileSync(file(), `# Handoff\n\n## Autosave (cezar)\n\n${edited}\n\n## Progress log\n\n## Resume notes\n`);

    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'ccc3333', branch: BRANCH });

    expect(lines()).toEqual([`- 2026-10-16T10:00:00.000Z — ${periodic(1, 'ccc3333', 'ccc3333')}`, edited]);
  });

  it('counts a commit whose sha could not be read, folding back from HEAD', () => {
    seed();
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: null, branch: BRANCH });
    expect(lines()).toEqual([`- 2026-10-16T10:00:00.000Z — ${periodic(1, '(sha unavailable)', '(sha unavailable)', BRANCH, 'HEAD~1')}`]);

    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'bbb2222', branch: BRANCH });
    expect(lines()).toEqual([`- 2026-10-16T10:00:00.000Z — ${periodic(2, '(sha unavailable)', 'bbb2222')}`]);

    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: null, branch: BRANCH });
    expect(lines()).toEqual([`- 2026-10-16T10:00:00.000Z — ${periodic(3, '(sha unavailable)', '(sha unavailable)', BRANCH, 'HEAD~1')}`]);
  });

  it('names a detached HEAD and keeps it apart from a branch', () => {
    seed();
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'aaa1111', branch: null });
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'bbb2222', branch: null });
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'ccc3333', branch: BRANCH });

    expect(lines()).toEqual([
      `- 2026-10-16T10:00:00.000Z — ${periodic(1, 'ccc3333', 'ccc3333')}`,
      `- 2026-10-16T10:00:00.000Z — ${periodic(2, 'aaa1111', 'bbb2222', 'detached HEAD')}`,
    ]);
  });

  // Git refuses only ASCII space and control characters in a ref name, so a branch can
  // carry Unicode whitespace (`git check-ref-format --branch` accepts all three), and JS
  // `\s` matches the first two while `.` misses the line separator (round 7 on
  // hearsay-tools/cezarion#1111).
  it.each([
    ['U+00A0 no-break space', 'fix/a\u00a0b'],
    ['U+2003 em space', 'fix/a\u2003b'],
    ['U+2028 line separator', 'fix/a\u2028b'],
  ])('coalesces on a branch whose name holds Unicode whitespace: %s', (_name, branch) => {
    seed();
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'aaa1111', branch });
    at('2026-10-16T10:01:30.000Z');
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'bbb2222', branch });

    expect(lines()).toEqual([`- 2026-10-16T10:01:30.000Z — ${periodic(2, 'aaa1111', 'bbb2222', branch)}`]);
  });

  it('appends the section at the end of a file without a Progress log', () => {
    writeFileSync(file(), '# Handoff\n\nfree-form notes');

    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'aaa1111', branch: BRANCH });
    recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'bbb2222', branch: BRANCH });

    expect(read()).toBe(`# Handoff\n\nfree-form notes\n\n## Autosave (cezar)\n\n- 2026-10-16T10:00:00.000Z — ${periodic(2, 'aaa1111', 'bbb2222')}\n`);
  });

  it('is a no-op on a missing file', () => {
    expect(() => recordHandoffPeriodicAutosave(dataDir, RUN, { sha: 'aaa1111', branch: BRANCH })).not.toThrow();
    expect(() => readFileSync(file())).toThrow();
  });
});

// hearsay-tools/cezarion#1234: a session with cezar tools is taught the tools, not the lifecycle
// markers; a session without them keeps today's prompt.
describe('handoffInstructions', () => {
  it('the tool variant teaches cezar_done, cezar_ask and cezar_wait and no lifecycle marker', () => {
    for (const followups of [false, true]) {
      const text = handoffInstructions({ tools: true, followups });
      expect(text).toContain('Lifecycle tools (cezar): End every turn with a cezar tool call that says what happens next. When the goal is fully achieved and verified and you have no question for the user, call cezar_done, then end your turn.');
      expect(text).toContain('When you need the user — a decision only they can make, or missing input — call cezar_ask with up to four questions, then end your turn. Give a question 2–4 options to show them as choices, or leave its options out and the user types the answer.');
      expect(text).toContain('call cezar_wait with kind "ci" for a pull request\'s checks or kind "timer" to re-check later');
      expect(text).not.toContain('kind "human"');
      // A reply settles the question; only CI waits and timers wait for a result or a cancel.
      expect(text).toContain("A human message or any resolved wait wakes you. The user's reply answers your question; CI waits and timers stay open until they resolve or you cancel them with cezar_cancel_wait.");
      expect(text).toContain('Never call cezar_done while anything is unfinished or unverified.');
      for (const marker of ['CEZ:DONE', 'CEZ:MONITORING', 'CEZ:ASK']) expect(text).not.toContain(marker);
      expect(text).toContain('CEZ:PR=');
      expect(text).toContain('## Pasted attachments');
      expect(text).toMatch(/"## Autosave \(cezar\)" section[^\n]*leave it in place/);
      expect(text.includes('## Follow-ups (cezar)')).toBe(followups);
    }
  });

  it('the marker variant is unchanged', () => {
    expect(handoffInstructions({ tools: false, followups: false })).toBe(HANDOFF_ONLY_INSTRUCTIONS);
    expect(handoffInstructions({ tools: false, followups: true })).toBe(HANDOFF_INSTRUCTIONS);
  });

  // hearsay-tools/cezarion#1428: agents asked about drafts and findings they never sent, once
  // after a plain ask and once after the content lived only in rejected tool-call arguments.
  it('both variants require the full decision context as assistant text before the question', () => {
    for (const followups of [false, true]) {
      const tools = handoffInstructions({ tools: true, followups });
      expect(tools).toContain('Before you call cezar_ask, send everything the decision depends on (the full draft, every finding, what each option means) as assistant text in this turn.');
      expect(tools).toContain('The user sees only your assistant text and the question card. Your reasoning and the arguments of a tool call, a rejected call included, never reach them, so never call content "above" unless you sent it as assistant text.');
      const markers = handoffInstructions({ tools: false, followups });
      expect(markers).toContain('Before the CEZ:ASK line, send everything the decision depends on (the full draft, every finding, what each option means) as ordinary text in the same message.');
      expect(markers).toContain('The user sees only your message text and the chips. Your reasoning never reaches them, so never call content "above" unless you sent it as message text.');
    }
  });
});
