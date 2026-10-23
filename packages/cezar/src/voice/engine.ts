import type { z } from 'zod';
import type { VoiceView, voiceSidebarViewSchema } from '@open-mercato/cezar-contract/voice';
import { FakeVoiceEngine } from './fake-engine.ts';
import { JevVoiceEngine } from './jev-engine.ts';

/**
 * Typed decision-engine seam: one request carries the sentence’s questions. Consume applicable
 * answers only; keep Jev and dry-run implementations inside this folder.
 */

export type EngineQuestion =
  | { type: 'choice'; instructions: string; options: Record<string, string | null> }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } };

export type EngineAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number };

/**
 * What the engine is told besides the questions: Jev has no memory between calls. `words` numbers the
 * sentence (`W01 answer`) so a question can ask about one word where it stands; `screen` is what the
 * user sees (hearsay-tools/cezarion#1463).
 */
export interface VoiceEngineState {
  sentence: string;
  words: string[];
  screen: {
    page: VoiceView | 'unknown';
    sidebarView: z.infer<typeof voiceSidebarViewSchema>;
    project: string;
    openTask?: { title: string; status: string };
  };
  pendingProposal?: 'answer' | 'tell';
  card?: {
    number: number;
    header: string;
    question: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
  }[];
  recent: { sentence: string; action: string; outcome?: string }[];
}

export interface DecisionEngine {
  readonly id: 'jev' | 'fake';
  /**
   * Answers every question it is given. Rejects with `VoiceEngineError` when the engine fails, and
   * with the caller signal's own reason when the caller aborts.
   */
  decide(
    input: { state: VoiceEngineState; questions: Record<string, EngineQuestion> },
    signal: AbortSignal,
  ): Promise<{ answers: Record<string, EngineAnswer>; inputTokens?: number }>;
}

/**
 * The question ids code and engines agree on. A card question adds its 0-based index; a word adds
 * its 0-based position in the sentence.
 */
export const QUESTION_IDS = {
  isCommand: 'is_command',
  scope: 'scope',
  projectAction: 'project_action',
  sessionAction: 'session_action',
  status: 'status',
  position: 'position',
  word: (k: number) => `w${k}`,
  option: (i: number) => `q${i}_option`,
  optionSelected: (i: number, j: number) => `q${i}_opt${j}`,
} as const;

/** The label of a word that is no part of a reply. Targets are `q1`…`qN` with a card, else `message`. */
/** Words said to the cockpit rather than the agent. Not `command`: Jev read an instruction for the
 *  agent ("ask me one more question") as a command (hearsay-tools/cezarion#1463 live testing). */
export const COMMAND_LABEL = 'routing';
export const MESSAGE_LABEL = 'message';
export const questionLabel = (i: number) => `q${i + 1}`;

/**
 * Option keys that carry user or card text are wrapped in curly quotes, so they can never equal a bare
 * key the code owns (`none`, `other`, an action, status or position id). "none" said as an answer is
 * the key `“none”`; the sentinel stays `none`. The text inside is read back with `keyText`.
 */
export function textKey(text: string): string {
  return `\u201c${text}\u201d`;
}

/** The text inside a `textKey`, or undefined when the key is not one. */
export function keyText(key: string): string | undefined {
  return key.length >= 2 && key.startsWith('\u201c') && key.endsWith('\u201d') ? key.slice(1, -1) : undefined;
}

/**
 * An engine failure. The message is fixed text and the error carries no request, header or cause,
 * so the API key cannot travel in it.
 */
export class VoiceEngineError extends Error {
  constructor(
    readonly code: 'http' | 'timeout' | 'invalid-answer' | 'network',
    readonly status?: number,
    detail?: string,
  ) {
    super(detail ? `Voice engine ${code}: ${detail}` : `Voice engine ${code}`);
    this.name = 'VoiceEngineError';
  }
}

/**
 * `CEZ_DRY_RUN=1` always gets the fake, even with a key, so a dry run never reaches the network.
 * Otherwise Jev; its constructor throws without a key, which the capability gate in front of the
 * route has already ruled out.
 */
export function selectVoiceEngine(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): DecisionEngine {
  if (env.CEZ_DRY_RUN === '1') return new FakeVoiceEngine();
  return new JevVoiceEngine({ apiKey: env.TYPESAFE_API_KEY ?? '', ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
