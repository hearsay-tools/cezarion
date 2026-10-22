// The voice replay set against the live Jev engine (hearsay-tools/cezarion#1463). Not part of any
// test run: it costs API calls and needs TYPESAFE_API_KEY in the environment. From packages/cezar:
//
//   node --import tsx scripts/voice-replay.ts
//
// For each case it prints the expected and actual decision, each target's min and mean word
// confidence, the latency and the input tokens, and exits 1 on any mismatch. It never prints the key.
import { JevVoiceEngine } from '../src/voice/jev-engine.ts';
import type { DecisionEngine } from '../src/voice/engine.ts';
import { REPLAY_CASES, mismatch, replayDecision, targetConfidences } from '../src/voice/replay-set.testkit.ts';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set.');
  process.exit(2);
}
const jev = new JevVoiceEngine({ apiKey });

let failed = 0;
const latencies: number[] = [];
for (const replay of REPLAY_CASES) {
  let inputTokens: number | undefined;
  const engine: DecisionEngine = {
    id: jev.id,
    async decide(input, signal) {
      const result = await jev.decide(input, signal);
      inputTokens = result.inputTokens;
      return result;
    },
  };
  try {
    const { decision, answers, latencyMs } = await replayDecision(replay, engine);
    latencies.push(latencyMs);
    const wrong = mismatch(replay.expect, decision);
    if (wrong) failed += 1;
    console.log(`${wrong ? 'FAIL' : 'ok  '} ${replay.name} — "${replay.sentence}" (${latencyMs} ms, ${inputTokens ?? '?'} in-tokens)`);
    if (wrong) console.log(`     ${wrong}`);
    const { decisionId: _id, ...shown } = decision;
    console.log(`     decision: ${JSON.stringify(shown)}`);
    for (const [label, { min, mean }] of Object.entries(targetConfidences(replay.sentence, answers))) {
      console.log(`     ${label}: min ${min.toFixed(2)}, mean ${mean.toFixed(2)}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${replay.name} — ${error instanceof Error ? error.message : 'engine error'}`);
  }
}
const range = latencies.length ? `${Math.min(...latencies)}–${Math.max(...latencies)} ms` : 'n/a';
console.log(`\n${REPLAY_CASES.length - failed}/${REPLAY_CASES.length} cases passed; latency ${range}`);
process.exit(failed === 0 ? 0 : 1);
