// Cezar's no-wait nudge (hearsay-tools/cezarion#1234). Every native mock answers it the way an agent
// should, by rewriting it into the mocks' own scenario prompts after the prompt is recorded: a
// session with cezar tools calls cezar_ask with a card (`mock:cezar-tool`), and one taught the
// markers ends with the ask line. CEZ_MOCK_NUDGE_REPLY=plain answers in plain text instead, so a
// test can reach the no-wait fallback. CEZ_MOCK_COMPLETION_REPLY, when set, is the mock prompt that
// answers Cezar's completion refusal nudge (hearsay-tools/cezarion#1301), so a test can choose the
// reply turn; unset, the refusal gets the mocks' ordinary reply. `mock:ack-only` is a reply every
// native mock understands: the harness acknowledges the prompt on its own wire (and reports it read
// where that wire can) and opens no turn until more input arrives.
import { FINAL_MESSAGE_NUDGE_PREFIX as NUDGE, silentTailOpened } from './mock-silent-tail.mjs';

export const NO_WAIT_NUDGE_PREFIX = NUDGE;
const QUESTIONS = [{ header: 'Next step', question: 'How should I continue?', options: [{ label: 'Keep going' }, { label: 'Stop here' }] }];
// hearsay-tools/cezarion#1458: cezar_ask requires the context the user reads above the card.
const CONTEXT = 'The task stopped without a next step.';

const messages = (texts) => `mock:turn-messages:${Buffer.from(JSON.stringify(texts)).toString('base64')}`;
const base64url = (text) => Buffer.from(text).toString('base64url');

/** A session that opened a silent-tail or tool-tail scenario answers the nudge in that scenario. */
export function silentNudge(prompt) {
  return typeof prompt === 'string' && prompt.includes(NUDGE) && silentTailOpened();
}

/** Every completion refusal ends with this, whichever check refused it. */
const COMPLETION_REFUSAL = 'then call cezar_done again.';
const completionReply = (prompt) => process.env.CEZ_MOCK_COMPLETION_REPLY && [COMPLETION_REFUSAL, 'Requests are still open:', 'Requests are unanswered:'].some(text => prompt.includes(text)) ? process.env.CEZ_MOCK_COMPLETION_REPLY : undefined;

export function answerNudge(prompt) {
  if (typeof prompt !== 'string') return prompt;
  const completion = completionReply(prompt);
  if (completion) return completion;
  if (!prompt.includes(NUDGE) || silentTailOpened()) return prompt;
  if (process.env.CEZ_MOCK_NUDGE_REPLY === 'plain') return messages(['Nothing more to add.']);
  if (prompt.includes('CEZ:ASK')) return messages([`I need your call on the next step.\n\nCEZ:ASK ${JSON.stringify({ questions: QUESTIONS })}`]);
  return `mock:cezar-tool cezar_ask ${base64url(JSON.stringify({ context: CONTEXT, questions: QUESTIONS }))} mock:then ${base64url('I asked how to continue.')}`;
}

/** OpenCode's prompt body: its text parts, joined, are the prompt. */
export function answerNudgeBody(body) {
  if (!body || ((!body.includes(NUDGE) || silentTailOpened()) && !completionReply(body))) return body;
  const parsed = JSON.parse(body);
  const text = (parsed.parts ?? []).map((part) => part.text ?? '').join('\n');
  return JSON.stringify({ ...parsed, parts: [{ type: 'text', text: answerNudge(text) }] });
}
