// Shared responses only; each caller encodes its own native runner wire (#426).
let cap = false;
export function autonomousReply(prompt) {
  const askCap = prompt.includes('mock:autonomous-ask-cap') || prompt.includes('mock:autonomous-readiness-idle');
  if (prompt.includes('mock:autonomous-cap') || askCap) cap = true;
  if (askCap) return 'CEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}';
  if (prompt.startsWith('Continue working autonomously until the task is fully complete.')) {
    return cap ? 'Still working.' : 'Autonomous work finished.\nCEZ:DONE';
  }
  return 'Still working.';
}
