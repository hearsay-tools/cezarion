// Shared responses only; each caller encodes its own native runner wire (#426).
// `lifecycle([name, args])` makes the caller's cezar tool call and returns a note for the text.
import { DONE, ask } from './mock-ci-tool.mjs';
let cap = false;
export async function autonomousReply(prompt, lifecycle) {
  const askCap = prompt.includes('mock:autonomous-cezar-ask-cap');
  if (prompt.includes('mock:autonomous-cap') || askCap) cap = true;
  if (askCap) return 'Pick one.' + await lifecycle(ask());
  if (prompt.startsWith('Continue working autonomously until the task is fully complete.')) {
    return cap ? 'Still working.' : 'Autonomous work finished.' + await lifecycle(DONE);
  }
  return 'Still working.';
}
