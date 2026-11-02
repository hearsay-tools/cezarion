import { defined } from './defined.ts';
import type { UiAskQuestion } from './ui-events.ts';
/**
 * AskUser payload — the structured multiple-choice question an agent asks the
 * user, so the cockpit can render clickable option chips instead of the prose
 * fallback ("AskUserQuestion isn't available…"). See the spec
 * `.ai/specs/2026-07-18-askuser-across-runners.md`.
 *
 * An agent raises it with the `cezar_ask` lifecycle tool; Codex and OpenCode
 * native questions map onto the same shape (`parseAskRequest`). The shape is
 * modeled 1:1 on Claude Code's built-in `AskUserQuestion` (1–4 questions, 2–4
 * options each, `header` ≤12 chars, unique question texts and unique option
 * labels). A free-text "Other" is always available via the composer, so it is
 * never an explicit option. The retired `CEZ:ASK` text marker is plain text
 * (hearsay-tools/cezarion#2397).
 */
import { askRequestSchema, type AskRequest } from '@open-mercato/cezar-contract/ask-schema';
export { askOptionSchema, askQuestionSchema, askRequestSchema, type AskOption, type AskQuestion, type AskRequest } from '@open-mercato/cezar-contract/ask-schema';

/**
 * Parse a value into a validated `AskRequest`, or `null` when it does not match
 * (bad counts, over-length header, non-unique labels/questions, extra keys).
 * Callers degrade to plain text on `null` — the feature never makes the prose
 * fallback worse.
 */
export function parseAskRequest(value: unknown): AskRequest | null {
  const parsed = askRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Project validated asks to the SSE shape with absent optional fields. */
export function uiAskQuestions(questions: AskRequest['questions']): UiAskQuestion[] {
  return questions.map(question => defined({
    ...question,
    options: question.options?.map(option => defined(option)),
  }));
}
