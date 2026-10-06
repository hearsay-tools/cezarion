// Shared responses only; each caller encodes its own native runner wire (#544).
// Per-process latch of the session's opening scenario, as mock-autonomous.mjs keeps `cap`.
let opened;

export const SILENT_TAIL_OPENING = 'Filing the issue now.';
export const SILENT_TAIL_REASONING =
  'Task complete. Summarize for the user. Emit CEZ:ISSUE=543, CEZ:TITLE, CEZ:DONE.CEZ:ISSUE=543';
export const SILENT_TAIL_DONE = 'Filed #543.\nCEZ:DONE';
export const TOOL_TAIL_OPENING = 'Inspecting the working tree.';
export const FINAL_MESSAGE_STANDING = 'Here is where things stand.';
export const FINAL_MESSAGE_NUDGE_PREFIX = 'Your last turn ended without a message to the user.';

export function noteSilentTailPrompt(prompt) {
  if (typeof prompt !== 'string' || isFinalMessageNudge(prompt)) return;
  if (prompt.includes('mock:silent-tail-again')) opened = 'silent-tail-again';
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

/** `done` only for mock:silent-tail; `silent` only for mock:silent-tail-again; else a plain visible line. */
export function finalMessageNudgeKind() {
  if (opened === 'silent-tail-again') return 'silent';
  if (opened === 'silent-tail') return 'done';
  return 'standing';
}
