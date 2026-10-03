// Shared responses only; each caller encodes its own native runner wire (#426).
let cap = false;
export function autonomousReply(prompt) {
  if (prompt.includes('mock:autonomous-cap')) cap = true;
  if (prompt.startsWith('Continue working autonomously until the task is fully complete.')) {
    return cap ? 'Still working.' : 'Autonomous work finished.\nCEZ:DONE';
  }
  return 'Still working.';
}
