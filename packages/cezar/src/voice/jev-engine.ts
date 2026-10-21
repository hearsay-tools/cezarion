import { z } from 'zod';
import { VoiceEngineError, type DecisionEngine, type EngineAnswer, type EngineQuestion, type VoiceEngineState } from './engine.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** Pinned: the confidence thresholds are tuned against one model version (see jev-issue-intake.cjs). */
const MODEL = 'jev-1.13.0';
/** Per call, no retries: the palette falls back to today's behavior on an error. */
const TIMEOUT_MS = 5000;

const unit = z.number().min(0).max(1);
// Loose objects on purpose: Jev may add keys; only what we read is checked. The envelope leaves
// answer values unknown: an answer nobody asked for is dropped, so it is never validated.
const envelopeSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.unknown().optional() }).optional(),
});
const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: unit, probabilities: z.record(z.string(), unit) }),
  z.object({ type: z.literal('noul'), noul: unit }),
]);

/** Jev (TypeSafe) behind the engine seam. Plain `fetch`: no SDK dependency. */
export class JevVoiceEngine implements DecisionEngine {
  readonly id = 'jev';
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: { apiKey: string; fetch?: typeof fetch }) {
    if (!options.apiKey) throw new Error('TYPESAFE_API_KEY is not set');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async decide(
    input: { state: VoiceEngineState; questions: Record<string, EngineQuestion> },
    signal: AbortSignal,
  ): Promise<{ answers: Record<string, EngineAnswer>; inputTokens?: number }> {
    if (signal.aborted) throw signal.reason;
    // Our own timer rather than AbortSignal.timeout, so a test drives it with fake timers.
    const timeout = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, TIMEOUT_MS);
    try {
      let body: unknown;
      try {
        const response = await this.#fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
          body: JSON.stringify({ model: MODEL, state: input.state, questions: wireQuestions(input.questions) }),
          signal: AbortSignal.any([signal, timeout.signal]),
        });
        if (!response.ok) throw new VoiceEngineError('http', response.status);
        body = await response.json().catch((error: unknown) => {
          if (signal.aborted || timedOut) throw error;
          throw new VoiceEngineError('invalid-answer', undefined, 'the response is not JSON');
        });
      } catch (error) {
        // The caller's abort wins: the route tells a closed request from an engine failure.
        if (signal.aborted) throw signal.reason;
        if (timedOut) throw new VoiceEngineError('timeout');
        if (error instanceof VoiceEngineError) throw error;
        throw new VoiceEngineError('network');
      }
      return parse(body, input.questions);
    } finally {
      clearTimeout(timer);
    }
  }
}

function wireQuestions(questions: Record<string, EngineQuestion>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [
      id,
      q.type === 'choice'
        ? { type: 'choice', instructions: q.instructions, criteria: q.options }
        : { type: 'noul', instructions: q.instructions, criteria: q.criteria },
    ]),
  );
}

/** Checks every asked question against its answer; answers nobody asked for are dropped. */
function parse(
  body: unknown,
  questions: Record<string, EngineQuestion>,
): { answers: Record<string, EngineAnswer>; inputTokens?: number } {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) throw new VoiceEngineError('invalid-answer', undefined, 'the response has the wrong shape');
  const answers: Record<string, EngineAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = parsed.data.answers[id];
    if (raw === undefined) throw new VoiceEngineError('invalid-answer', undefined, `no answer for "${id}"`);
    const checked = answerSchema.safeParse(raw);
    if (!checked.success) throw new VoiceEngineError('invalid-answer', undefined, `"${id}" has the wrong shape`);
    const answer = checked.data;
    if (answer.type !== question.type) {
      throw new VoiceEngineError('invalid-answer', undefined, `"${id}" has the wrong answer type`);
    }
    if (answer.type === 'choice' && question.type === 'choice') {
      const offered = Object.keys(question.options);
      if (!offered.includes(answer.choice) || Object.keys(answer.probabilities).some((key) => !offered.includes(key))) {
        throw new VoiceEngineError('invalid-answer', undefined, `"${id}" names an option that was not offered`);
      }
    }
    answers[id] = answer;
  }
  const tokens = parsed.data.usage?.input_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) ? { answers, inputTokens: tokens } : { answers };
}
