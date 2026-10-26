import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exactLineIndex, HANDOFF_AUTOSAVE_RECORDS_MAX, nextLineIndex, type HandoffAutosaveRecord, type HandoffRecords } from '@open-mercato/cezar-contract/handoff';
import type { RunStore } from './runs/store.ts';

/**
 * Per-task handoff journal (spec 007): `.ai/cezar/runs/<runId>.handoff.md`,
 * next to the run's NDJSON events and outside the task worktree — it survives
 * worktree removal. Cez seeds the skeleton; the agent (told via
 * CEZ_HANDOFF_FILE + the system-prompt fragment below) keeps the "Progress log"
 * and "Resume notes" sections up to date. cezar's own records, the autosave
 * reports, live in the run store (`RunRecord.handoffRecords`) and reach the file
 * as ONE block that cezar rewrites whole (hearsay-tools/cezarion#1809), so cezar
 * never edits a line the agent writes. cezar writes no lifecycle line: the run
 * event log and the run status hold those facts. Everything here is best-effort:
 * the handoff is a journal, never a reason to fail a run.
 */

export function handoffPath(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}.handoff.md`);
}

export interface HandoffSeed {
  id: string;
  title: string;
  workflow: string;
  task: string;
  branch?: string | undefined;
  worktreePath?: string | undefined;
}

/** Create the handoff skeleton. Idempotent — an existing file (resume,
 *  continuation) is never overwritten. Returns the file path. */
export function seedHandoffFile(dataDir: string, run: HandoffSeed): string {
  const file = handoffPath(dataDir, run.id);
  if (existsSync(file)) return file;
  const header =
    `# Handoff — ${run.title}\n\n` +
    `**Task id:** ${run.id}\n` +
    `**Workflow:** ${run.workflow}\n` +
    (run.branch ? `**Branch:** ${run.branch}\n` : '') +
    (run.worktreePath ? `**Worktree:** ${run.worktreePath}\n` : '') +
    `\n## Goal\n\n${run.task.trim()}\n\n` +
    `## Progress log\n\n` +
    `## Resume notes\n`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, header, 'utf8');
  } catch {
    // best effort — a read-only data dir must not break the run
  }
  return file;
}

const RECORDS_BEGIN = '<!-- cezar:records — cezar rewrites this block whole from its run store; edits here are replaced -->';
const RECORDS_END = '<!-- /cezar:records -->';

/** The block that shows `records`, or '' when there is nothing to show. */
function recordsBlock(records: HandoffRecords | undefined): string {
  const autosave = records?.autosave ?? [];
  if (autosave.length === 0) return '';
  const lines = autosave.map((record) => `- ${record.at} — ${record.note}`);
  return [RECORDS_BEGIN, '## Cezar records', '', '### Autosave', '', ...lines, RECORDS_END, ''].join('\n');
}

/**
 * `text` with its records block replaced by the one for `records` (hearsay-tools/cezarion#1809).
 * The block runs from the first begin-marker line through the first end-marker line after it; a
 * begin marker with no end marker is that one line. Without a block, a new one goes right before
 * the seeded `## Goal` line, or at the start. No other part of `text` is read or changed, and an
 * empty `text` (no file) stays empty.
 */
export function renderHandoffRecords(text: string, records: HandoffRecords | undefined): string {
  if (!text) return text;
  const block = recordsBlock(records);
  const begin = exactLineIndex(text, RECORDS_BEGIN);
  if (begin >= 0) {
    const body = nextLineIndex(text, begin);
    const end = exactLineIndex(text.slice(body), RECORDS_END);
    const after = end < 0 ? body : nextLineIndex(text, body + end);
    return `${text.slice(0, begin)}${block}${text.slice(after)}`;
  }
  if (!block) return text;
  const at = Math.max(exactLineIndex(text, '## Goal'), 0);
  return `${text.slice(0, at)}${block}\n${text.slice(at)}`;
}

/** Show `records` in the run's handoff file. Missing file → no-op: seeding is `seedHandoffFile`'s job. */
function writeHandoffRecords(dataDir: string, runId: string, records: HandoffRecords | undefined): void {
  const file = handoffPath(dataDir, runId);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const next = renderHandoffRecords(text, records);
  if (next === text) return;
  try {
    writeFileSync(file, next, 'utf8');
  } catch {
    // best effort
  }
}

type HandoffStore = Pick<RunStore, 'getRun' | 'updateRun'>;

/** Show the store's records in the file again. Every session launch does, so its opening message
 *  carries them after a crash, an agent edit, or a deleted block or file. */
export function refreshHandoffRecords(store: HandoffStore, dataDir: string, runId: string): void {
  let records: HandoffRecords | undefined;
  try {
    records = store.getRun(runId)?.handoffRecords;
  } catch {
    return; // a closed store: the next launch shows them
  }
  writeHandoffRecords(dataDir, runId, records);
}

/**
 * Keep `next(current)` as the run's autosave records, newest first. `updateRun` commits a
 * `handoffRecords` patch at once and throws when the store refuses it; the file shows the records
 * only after that commit, so it never shows one that a crash would lose.
 */
function recordAutosave(store: HandoffStore, dataDir: string, runId: string,
  next: (current: HandoffAutosaveRecord[]) => HandoffAutosaveRecord[]): void {
  try {
    const run = store.getRun(runId);
    if (!run) return;
    const autosave = next(run.handoffRecords?.autosave ?? []).slice(0, HANDOFF_AUTOSAVE_RECORDS_MAX);
    writeHandoffRecords(dataDir, runId, store.updateRun(runId, { handoffRecords: { autosave } })?.handoffRecords);
  } catch {
    // The handoff is a journal, never a reason to fail; an uncommitted record stays out of the file.
  }
}

/** Cez's autosave report (hearsay-tools/cezarion#1004): a commit or a skip, newest first. The
 *  block shows it, never the Progress log, whose lines are the agent's own. */
export function recordHandoffAutosave(store: HandoffStore, dataDir: string, runId: string, note: string): void {
  recordAutosave(store, dataDir, runId, (current) => [{ at: new Date().toISOString(), note }, ...current]);
}

const SHA_UNAVAILABLE = '(sha unavailable)';

function periodicAutosaveNote({ count, branch, first, latest }: NonNullable<HandoffAutosaveRecord['periodic']>): string {
  return `periodic: ${count} cezar autosave commit(s) on ${branch ?? 'detached HEAD'}, first ${first ?? SHA_UNAVAILABLE}, latest ${latest ?? SHA_UNAVAILABLE}; ` +
    `to fold the latest into your own commits while it is HEAD, run \`git reset --soft ${latest ?? 'HEAD'}~1\``;
}

/**
 * The periodic timer's commit (hearsay-tools/cezarion#1004): a clean closing flush reports
 * nothing, so the timer reports its own commits, as ONE record per run of consecutive periodic
 * commits on one branch — a record every 90 s would bury the block. When the newest record is a
 * periodic one for `commit.branch`, it is replaced with the count + 1, its first sha, this sha as
 * the latest and a new time; any other newest record gets a new one above it. The merge reads the
 * record's fields, never the file, so an agent edit cannot restart the count. `sha: null` is a
 * commit whose hash could not be read back; `branch: null` is a detached HEAD.
 */
export function recordHandoffPeriodicAutosave(
  store: HandoffStore,
  dataDir: string,
  runId: string,
  commit: { sha: string | null; branch: string | null },
): void {
  recordAutosave(store, dataDir, runId, (current) => {
    const [newest, ...older] = current;
    const run = newest?.periodic && newest.periodic.branch === commit.branch ? newest.periodic : undefined;
    const periodic = run
      ? { ...run, count: run.count + 1, latest: commit.sha }
      : { branch: commit.branch, count: 1, first: commit.sha, latest: commit.sha };
    const record = { at: new Date().toISOString(), note: periodicAutosaveNote(periodic), periodic };
    return run ? [record, ...older] : [record, ...current];
  });
}

/** Full handoff markdown, or '' when the file doesn't exist (yet). */
export function readHandoff(dataDir: string, runId: string): string {
  try {
    return readFileSync(handoffPath(dataDir, runId), 'utf8');
  } catch {
    return '';
  }
}

export function deleteHandoff(dataDir: string, runId: string): void {
  try {
    rmSync(handoffPath(dataDir, runId), { force: true });
  } catch {
    // best effort
  }
}

const HANDOFF_AUTOSAVE_NOTE = `The "Cezar records" block near the top, when present, is cezar's record of autosave commits on your branch (with the command that folds one back) or of work it left uncommitted; cezar rewrites the whole block, so never edit it.`;
const HANDOFF_READ_STEP = `1. At the start of work, read it — "Resume notes" left by a previous session is your starting context. ${HANDOFF_AUTOSAVE_NOTE}`;
/** Step 1 when the launch's opening message already carries the file (hearsay-tools/cezarion#1584). */
const HANDOFF_INJECTED_STEP = `1. Its contents as of this launch open your first message for this session, in the cezar context block with id "handoff"; read the file again only when you need a later version. "Resume notes" left by a previous session is your starting context. ${HANDOFF_AUTOSAVE_NOTE}`;

const handoffJournal = (injected: boolean) => `## Handoff (cezar)

CEZ_HANDOFF_FILE (env) is the absolute path to this task's rolling handoff file. Treat it like a HANDOFF.md:
${injected ? HANDOFF_INJECTED_STEP : HANDOFF_READ_STEP}
2. After every meaningful milestone (passing tests, a commit, a PR, a scope decision), append one terse timestamped line under "## Progress log", newest at the top.
3. Before finishing or pausing, update "## Resume notes" with what's done, what's next and any blockers. Leave it empty only when the task is truly complete.`;

/** The lifecycle markers a session without cezar tools ends its turns with. */
const LIFECYCLE_MARKERS = `Task completion marker: when the task's goal is fully achieved and you have no question for the user, end your final message with a line containing exactly CEZ:DONE — cez then closes the session and marks the task finished. If you are waiting on the user (a question, a decision, missing input), just end your message normally; the session stays open for their reply. Never emit CEZ:DONE while anything is unfinished or unverified.

Still-working marker: if you end a turn while still working on your OWN downstream work — a sub-agent you dispatched, or a long-running command you're monitoring — and are NOT waiting on the user for anything, end your final message with a line containing exactly CEZ:MONITORING. cez then shows the task as "monitoring" (still working) instead of asking for your attention. Use CEZ:MONITORING only for that in-progress case; use CEZ:DONE when the goal is done; end plainly (no marker) only when you are genuinely waiting on the user. When the watched work is finished and the task goal is complete, end your final message with CEZ:DONE. If the watched work is still pending, end with CEZ:MONITORING. Never yield markerless for a monitoring wrap-up. A genuine question for the user still follows the question paths above and below. Never combine CEZ:MONITORING with CEZ:DONE.

Structured question marker: when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the code, or sensible defaults — and it comes down to a few concrete choices, end your turn with a single line CEZ:ASK <json> instead of asking in prose. Before the CEZ:ASK line, send everything the decision depends on (the full draft, every finding, what each option means) as ordinary text in the same message. The user sees only your message text and the chips. Your reasoning never reaches them, so never call content "above" unless you sent it as message text. cez renders it as clickable option chips in the cockpit so the user can answer in one tap. The <json> is ONE object on ONE line, the last thing in your message: {"questions":[{"header":"≤12-char label","question":"a clear question ending in ?","multiSelect":false,"options":[{"label":"short choice","description":"what it means / the trade-off"}]}]} — use only those keys (plus an optional non-empty "id" up to 64 characters per question, plus an optional "context" of up to 20000 characters of Markdown shown above the chips), with 1–4 questions, 2–4 options per question, unique question text and option labels, header 1–12 characters, question 1–400, option label 1–60, and description at most 280. The JSON must be syntactically valid — every brace and bracket closed, no trailing commas; re-read the line before you send it, because a payload cez cannot parse is shown to the user as raw JSON instead of chips. The user can always type a free-form reply, so never add an "Other" option. Prefer sensible defaults over asking; use CEZ:ASK only when the choice is truly the user's. Never combine CEZ:ASK with CEZ:DONE or CEZ:MONITORING.`;

/** hearsay-tools/cezarion#1234: the same lifecycle as tool calls, for a session that has them. */
const LIFECYCLE_TOOLS = `Lifecycle tools (cezar): End every turn with a cezar tool call that says what happens next. When the goal is fully achieved and verified and you have no question for the user, call cezar_done, then end your turn. When a user decision or missing input is needed, call cezar_ask with the complete decision context and short questions. Put the full draft, findings, evidence and option meanings in context. Cezar shows context as Markdown above the card. Reasoning and rejected calls are hidden. Give a question 2–4 options to show them as choices, or leave its options out and the user types the answer. Once the call accepts the context and questions, end the turn and wait for the user. When you are waiting on something else, call cezar_wait with kind "pr" for a pull request's checks or its merge, or kind "timer" to re-check later, then end your turn. A human message or any resolved wait wakes you. The user's reply answers your question; PR waits and timers stay open until they resolve or you cancel them with cezar_cancel_wait. Never call cezar_done while anything is unfinished or unverified.`;

const REFERENCES_AND_ATTACHMENTS = `Task reference markers: as soon as you know which GitHub pull request or issue this task is ABOUT (it was named in the task, or you just opened it), declare it by emitting, on its own line in your message text: CEZ:PR=<number> and/or CEZ:ISSUE=<number>. Declare each PR this task opens, even when it opens several. Earlier declarations remain associated with the task; the last declaration selects the current subject. For issues, an issue directly identified as the task subject in its prompt remains the primary attribution; later issue declarations and discovered links do not replace it. Re-emit with the new number if the subject changes (e.g. you open a PR later in the task). Declare only the task's own subject — never a PR/issue you merely mention, list, or compare against. You may also emit CEZ:TITLE=<terse gerund phrase, max 40 chars, e.g. "implementing comment threads"> once the work has a clearer shape than its current title; cez uses these instead of guessing from the transcript. Put markers in plain message text, never inside a code fence.

## Pasted attachments
User-attached screenshots and files (PDF, TXT, MD) are saved as real files; their absolute paths are listed in the message that carries them. Read a file from its path when you need its contents, and use the path when a task needs the file itself (saving, uploading, attaching to issues/PRs). An image also rides along inline, but that copy is for viewing only; a non-image attachment exists ONLY as the file at that path.`;

/** The rolling handoff journal and lifecycle guidance for sessions without cezar tools. */
export const HANDOFF_ONLY_INSTRUCTIONS = `${handoffJournal(false)}\n\n${LIFECYCLE_MARKERS}\n\n${REFERENCES_AND_ATTACHMENTS}`;

/**
 * The handoff contract for one agent session. With `tools` (the session has cezar's tools) the
 * lifecycle is taught as cezar_done, cezar_ask and cezar_wait calls; without them it is today's marker
 * variant, `HANDOFF_ONLY_INSTRUCTIONS`. The marker lines are parsed in
 * both cases. With `handoffInjected` the launch's opening message already carries the file
 * (hearsay-tools/cezarion#1584), so step 1 points there instead of asking for a read; the
 * writing duties never change.
 */
export function handoffInstructions(opts: { tools: boolean; handoffInjected?: boolean }): string {
  return `${handoffJournal(opts.handoffInjected ?? false)}\n\n${opts.tools ? LIFECYCLE_TOOLS : LIFECYCLE_MARKERS}\n\n${REFERENCES_AND_ATTACHMENTS}`;
}
