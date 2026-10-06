// Shared responses only; each caller encodes its own native runner wire (#544).
// Per-process latch of the session's opening scenario, as mock-autonomous.mjs keeps `cap`.
let opened;

export const SILENT_TAIL_OPENING = 'Filing the issue now.';
export const SILENT_TAIL_REASONING =
  'Task complete. Summarize for the user. Emit CEZ:ISSUE=543, CEZ:TITLE, CEZ:DONE.CEZ:ISSUE=543';
export const SILENT_TAIL_DONE = 'Filed #543.\nCEZ:DONE';
export const TOOL_TAIL_OPENING = 'Inspecting the working tree.';
export const FINAL_MESSAGE_STANDING = 'Here is where things stand.';
export const SLOW_DONE_PREFIX = 'Working on the wrap-up.';
export const FINAL_MESSAGE_NUDGE_PREFIX = 'Your last turn ended without a message to the user.';
/** Bound in F9 is 300 ms; reply after expiry. */
export const LATE_REPLY_MS = 500;
/** Bound in F10 is 300 ms; first content is immediate, turn-end after this. */
export const SLOW_DONE_TAIL_MS = 400;

export function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function noteSilentTailPrompt(prompt) {
  if (typeof prompt !== 'string' || isFinalMessageNudge(prompt)) return;
  if (prompt.includes('mock:silent-tail-no-reply')) opened = 'silent-tail-no-reply';
  else if (prompt.includes('mock:silent-tail-late-reply')) opened = 'silent-tail-late-reply';
  else if (prompt.includes('mock:silent-tail-slow-done')) opened = 'silent-tail-slow-done';
  else if (prompt.includes('mock:silent-tail-again')) opened = 'silent-tail-again';
  else if (prompt.includes('mock:silent-tail')) opened = 'silent-tail';
}

export function isSilentTailScenario(prompt) {
  return typeof prompt === 'string' && prompt.includes('mock:silent-tail');
}

export function isToolTailScenario(prompt) {
  return typeof prompt === 'string' && prompt.includes('mock:tool-tail');
}

export function isFinalMessageNudge(prompt) {
  return typeof prompt === 'string' && prompt.includes(FINAL_MESSAGE_NUDGE_PREFIX);
}

/** `done` only for mock:silent-tail; `silent` only for mock:silent-tail-again;
 *  `ack-only` ACKs the nudge and never opens a turn (OpenCode keeps heartbeats);
 *  `late` ACKs then replies after LATE_REPLY_MS; `slow-done` starts content at
 *  once and ends after SLOW_DONE_TAIL_MS. */
export function finalMessageNudgeKind() {
  if (opened === 'silent-tail-no-reply') return 'ack-only';
  if (opened === 'silent-tail-late-reply') return 'late';
  if (opened === 'silent-tail-slow-done') return 'slow-done';
  if (opened === 'silent-tail-again') return 'silent';
  if (opened === 'silent-tail') return 'done';
  return 'standing';
}

export function isAckOnlyNudge(prompt) {
  return isFinalMessageNudge(prompt) && finalMessageNudgeKind() === 'ack-only';
}

export function isLateNudge(prompt) {
  return isFinalMessageNudge(prompt) && finalMessageNudgeKind() === 'late';
}

export function isSlowDoneNudge(prompt) {
  return isFinalMessageNudge(prompt) && finalMessageNudgeKind() === 'slow-done';
}
