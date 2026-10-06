// Shared responses only; each caller encodes its own native runner wire (#544).
let again = false;

export const SILENT_TAIL_OPENING = 'Filing the issue now.';
export const SILENT_TAIL_REASONING =
  'Task complete. Summarize for the user. Emit CEZ:ISSUE=543, CEZ:TITLE, CEZ:DONE.CEZ:ISSUE=543';
export const SILENT_TAIL_DONE = 'Filed #543.\nCEZ:DONE';
export const FINAL_MESSAGE_NUDGE_PREFIX = 'Your last turn ended without a message to the user.';

export function noteSilentTailPrompt(prompt) {
  if (typeof prompt === 'string' && prompt.includes('mock:silent-tail-again')) again = true;
}

export function isSilentTailScenario(prompt) {
  return typeof prompt === 'string' && prompt.includes('mock:silent-tail');
}

export function isFinalMessageNudge(prompt) {
  return typeof prompt === 'string' && prompt.includes(FINAL_MESSAGE_NUDGE_PREFIX);
}

export function silentTailNudgeAgain() {
  return again;
}
