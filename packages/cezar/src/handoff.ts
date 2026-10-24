import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-task handoff journal (spec 007): `.ai/cezar/runs/<runId>.handoff.md`,
 * next to the run's NDJSON events and outside the task worktree — it survives
 * worktree removal. Cez seeds the skeleton, appends heartbeats and owns the
 * `## Autosave (cezar)` section (hearsay-tools/cezarion#1004); the agent (told
 * via CEZ_HANDOFF_FILE + the system-prompt fragment below) keeps the
 * "Progress log" and "Resume notes" sections up to date. Everything here is
 * best-effort: the handoff is a journal, never a reason to fail a run.
 */

export function handoffPath(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}.handoff.md`);
}

export interface HandoffSeed {
  id: string;
  title: string;
  workflow: string;
  task: string;
  branch?: string;
  worktreePath?: string;
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

/**
 * Cez's own heartbeat (the janitor pattern): insert `- <ISO ts> — <note>`
 * right under the `## Progress log` header (newest at the top), so the file
 * stays current even when the agent forgets to write. Missing header →
 * append at the end of the file; missing file → no-op.
 */
export function appendHandoffHeartbeat(dataDir: string, runId: string, note: string): void {
  const file = handoffPath(dataDir, runId);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // not seeded — nothing to heartbeat
  }
  const line = `- ${new Date().toISOString()} — ${note}\n`;
  const marker = '## Progress log\n';
  const idx = text.indexOf(marker);
  const next =
    idx >= 0
      ? `${text.slice(0, idx + marker.length)}\n${line}${text.slice(idx + marker.length).replace(/^\n+/, '')}`
      : `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${line}`;
  try {
    writeFileSync(file, next, 'utf8');
  } catch {
    // best effort
  }
}

const AUTOSAVE_HEADER = '## Autosave (cezar)\n';

/** Index of `marker` at the start of a line, or -1. */
function lineStart(text: string, marker: string): number {
  if (text.startsWith(marker)) return 0;
  const idx = text.indexOf(`\n${marker}`);
  return idx < 0 ? -1 : idx + 1;
}

/**
 * Put `- <ISO ts> — <note>` on top of the `## Autosave (cezar)` section, the one
 * placement every autosave report shares. `entry` sees the newest line under the
 * header (`undefined` when there is none) and names the note, and whether it
 * replaces that line instead of going above it.
 */
function writeAutosaveSection(
  dataDir: string,
  runId: string,
  entry: (newest: string | undefined) => { note: string; replace: boolean },
): void {
  const file = handoffPath(dataDir, runId);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // not seeded — nothing to report into
  }
  const lineFor = (note: string) => `- ${new Date().toISOString()} — ${note}\n`;
  const header = lineStart(text, AUTOSAVE_HEADER);
  const progress = lineStart(text, '## Progress log\n');
  let next: string;
  if (header >= 0) {
    const end = header + AUTOSAVE_HEADER.length;
    const rest = text.slice(end).replace(/^\n+/, '');
    const eol = rest.indexOf('\n');
    const first = eol < 0 ? rest : rest.slice(0, eol);
    const newest = first.startsWith('- ') ? first : undefined;
    const { note, replace } = entry(newest);
    const kept = replace && newest !== undefined ? rest.slice(first.length + 1) : rest;
    next = `${text.slice(0, end)}\n${lineFor(note)}${kept}`;
  } else {
    const line = lineFor(entry(undefined).note);
    next = progress >= 0
      ? `${text.slice(0, progress)}${AUTOSAVE_HEADER}\n${line}\n${text.slice(progress)}`
      : `${text === '' ? '' : text.replace(/\n*$/, '\n\n')}${AUTOSAVE_HEADER}\n${line}`;
  }
  try {
    writeFileSync(file, next, 'utf8');
  } catch {
    // best effort
  }
}

/**
 * Cez's autosave report (hearsay-tools/cezarion#1004): insert `- <ISO ts> — <note>`
 * right under the `## Autosave (cezar)` header (newest at the top), never in the
 * Progress log, whose top lines are the agent's own summary (variant compare
 * column, draft-PR body). The first report creates the section right before
 * `## Progress log`, so an agent rewriting the end of the file (Resume notes)
 * leaves it alone; no Progress log → end of the file; missing file → no-op.
 */
export function appendHandoffAutosaveReport(dataDir: string, runId: string, note: string): void {
  writeAutosaveSection(dataDir, runId, () => ({ note, replace: false }));
}

const SHA_UNAVAILABLE = '(sha unavailable)';
const PERIODIC_SHA = String.raw`[0-9a-f]+|\(sha unavailable\)`;
/** A whole periodic line as `periodicAutosaveNote` writes it; anything else is not one.
 *  The branch slot takes anything but a line break: Git accepts Unicode whitespace in a ref
 *  name, which `\S` and `.` refuse, and the exact re-render check rejects any line that is
 *  not cezar's own. */
const PERIODIC_LINE = new RegExp(
  String.raw`^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z — (periodic: ([1-9]\d*) cezar autosave commit\(s\) on ([^\r\n]+?), ` +
    String.raw`first (${PERIODIC_SHA}), latest (${PERIODIC_SHA}); .*)$`,
);

function periodicAutosaveNote(count: number, branch: string, first: string | null, latest: string | null): string {
  return `periodic: ${count} cezar autosave commit(s) on ${branch}, first ${first ?? SHA_UNAVAILABLE}, latest ${latest ?? SHA_UNAVAILABLE}; ` +
    `to fold the latest into your own commits while it is HEAD, run \`git reset --soft ${latest ?? 'HEAD'}~1\``;
}

/**
 * The periodic timer's commit (hearsay-tools/cezarion#1004): a clean closing flush
 * reports nothing, so the timer reports its own commits, as ONE line per run of
 * consecutive periodic commits on one branch — a line every 90 s would bury the
 * section. When the newest line is such a line for `branch`, it is rewritten with
 * the count + 1, its first sha, this `sha` as the latest and a new timestamp. Any
 * other newest line (a turn-end or run-finalize report, another branch, a line
 * someone edited) gets a new line above it, placed as `appendHandoffAutosaveReport`
 * places one. `sha: null` is a commit whose hash could not be read back; `branch:
 * null` is a detached HEAD. Missing file → no-op.
 */
export function recordHandoffPeriodicAutosave(
  dataDir: string,
  runId: string,
  commit: { sha: string | null; branch: string | null },
): void {
  const branch = commit.branch ?? 'detached HEAD';
  writeAutosaveSection(dataDir, runId, (newest) => {
    const match = newest === undefined ? null : PERIODIC_LINE.exec(newest);
    if (match) {
      const [, note, count, lineBranch, first, latest] = match;
      const sha = (value: string) => (value === SHA_UNAVAILABLE ? null : value);
      // Only a line exactly as cezar wrote it is continued: an edit starts a new one.
      if (lineBranch === branch && note === periodicAutosaveNote(Number(count), branch, sha(first!), sha(latest!))) {
        return { note: periodicAutosaveNote(Number(count) + 1, branch, sha(first!), commit.sha), replace: true };
      }
    }
    return { note: periodicAutosaveNote(1, branch, commit.sha, commit.sha), replace: false };
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

/** A turn or step lifecycle line cez writes at every turn end (`appendHandoffHeartbeat`). */
const LIFECYCLE_HEARTBEAT = /^- \S+ — (?:turn complete|step ".*" complete|session idle-closed) — /;

/**
 * First few non-empty lines under "## Progress log" (spec 010 — the variant
 * comparison columns). Stops at the next `## ` header; '' when there's no
 * Progress log section or it's empty. The agent's own lines win: cez's
 * lifecycle heartbeats show only when the agent wrote none, so the extra turns
 * of a no-wait nudge (hearsay-tools/cezarion#1234) never push its summary out
 * of the column.
 */
export function handoffProgressExcerpt(text: string, maxLines = 3): string {
  const marker = '## Progress log';
  const idx = text.indexOf(marker);
  if (idx < 0) return '';
  const own: string[] = [];
  const lifecycle: string[] = [];
  for (const line of text.slice(idx + marker.length).split('\n')) {
    if (line.startsWith('## ')) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    (LIFECYCLE_HEARTBEAT.test(trimmed) ? lifecycle : own).push(trimmed);
    if (own.length >= maxLines) break;
  }
  return (own.length ? own : lifecycle).slice(0, maxLines).join('\n');
}

export function deleteHandoff(dataDir: string, runId: string): void {
  try {
    rmSync(handoffPath(dataDir, runId), { force: true });
  } catch {
    // best effort
  }
}

const HANDOFF_AUTOSAVE_NOTE = `A "## Autosave (cezar)" section, when present, is cezar's record of an autosave commit on your branch (with the command that folds it back) or of work it left uncommitted; leave it in place.`;
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
