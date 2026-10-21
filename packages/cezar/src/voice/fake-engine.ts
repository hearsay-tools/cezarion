import { QUESTION_IDS, keyText, textKey, type DecisionEngine, type EngineAnswer, type EngineQuestion, type VoiceEngineState } from './engine.ts';

/**
 * The dry-run engine (`CEZ_DRY_RUN=1`): deterministic, offline, and small on purpose. It reads a
 * fixed phrase set — "open <position> <status>", "answer <choice | the Nth answer | words> to
 * question <N>", "tell it: <text>", "yes, confirmed", "no" / "cancel" — which is exactly what the
 * browser E2E says. It is not a second engine: anything else reads as "not a command".
 */

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const CARDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const ORD = `(?:${[...ORDINALS, ...CARDINALS].join('|')}|\\d+(?:st|nd|rd|th)?)`;

/** "second", "two", "2nd", "2" ⇒ 2. */
function ordinalValue(word: string): number {
  const w = word.toLowerCase();
  const named = ORDINALS.indexOf(w) + 1 || CARDINALS.indexOf(w) + 1;
  return named || Number.parseInt(w, 10);
}

/** `questions` named in a sentence: "to question first", "for the second question", "question 2". */
const QUESTION_ANCHOR = new RegExp(`(?:(?:to|for)\\s+)?(?:the\\s+)?(?:question\\s+(${ORD})|(${ORD})\\s+question)\\b`, 'gi');
const ORDINAL_CHOICE = [
  new RegExp(`^(?:the\\s+)?(${ORD})\\s+(?:answer|option|choice|one)$`, 'i'),
  new RegExp(`^(?:option|choice|answer)\\s+(${ORD})$`, 'i'),
];
const TELL_PREFIX = /^(?:tell it|tell the agent|reply|say)\b/i;

export class FakeVoiceEngine implements DecisionEngine {
  readonly id = 'fake';

  // Offline and instant: the signal has nothing to stop.
  async decide(
    input: { state: VoiceEngineState; questions: Record<string, EngineQuestion> },
    _signal: AbortSignal,
  ): Promise<{ answers: Record<string, EngineAnswer> }> {
    const reading = read(input.state);
    const answers: Record<string, EngineAnswer> = {};
    for (const [id, question] of Object.entries(input.questions)) {
      answers[id] =
        question.type === 'choice'
          ? choiceAnswer(Object.keys(question.options), reading.choose(id, Object.keys(question.options)))
          : { type: 'noul', noul: reading.noul(id) };
    }
    return { answers };
  }
}

function choiceAnswer(options: string[], choice: string | undefined): EngineAnswer {
  const picked = choice !== undefined && options.includes(choice) ? choice : fallback(options);
  return {
    type: 'choice',
    choice: picked,
    confidence: 1,
    probabilities: Object.fromEntries(options.map((option) => [option, option === picked ? 1 : 0])),
  };
}

/** What an id the fake has no rule for gets: `none` when offered, else the first option. */
function fallback(options: string[]): string {
  return options.includes('none') ? 'none' : (options[0] ?? '');
}

function read(state: VoiceEngineState): {
  choose(id: string, options: string[]): string | undefined;
  noul(id: string): number;
} {
  const sentence = clean(state.sentence);
  const lower = sentence.toLowerCase();
  const action = actionOf(lower);
  const segments = questionSegments(sentence);
  const labelsOf = (i: number) => state.card?.[i]?.options?.map((o) => o.label) ?? [];

  return {
    choose(id, options) {
      if (id === QUESTION_IDS.action) return action;
      if (id === QUESTION_IDS.position) return positionOf(lower, options);
      if (id === QUESTION_IDS.status) return statusOf(lower, options);
      if (id === QUESTION_IDS.tellStart) return tellStartOf(sentence, options) ?? options[0];
      const indexed = /^q(\d+)_(span|choice)$/.exec(id);
      if (!indexed) return undefined;
      const segment = segments.get(Number(indexed[1]));
      if (segment === undefined) return undefined; // not addressed: `none`
      if (indexed[2] === 'span') return options.find((o) => keyText(o)?.trim().toLowerCase() === segment.toLowerCase());
      return choiceOf(segment, labelsOf(Number(indexed[1])));
    },
    noul(id) {
      if (id === QUESTION_IDS.isCommand) return action === 'none' ? 0.05 : 0.95;
      const option = /^q(\d+)_opt(\d+)$/.exec(id);
      if (!option) return 0;
      const segment = segments.get(Number(option[1]));
      const label = labelsOf(Number(option[1]))[Number(option[2])];
      return segment !== undefined && label !== undefined && segment.toLowerCase().includes(label.toLowerCase()) ? 1 : 0;
    },
  };
}

/** Leading fillers and trailing sentence marks off; the case stays, since Other copies it as said. */
function clean(sentence: string): string {
  return sentence
    .trim()
    .replace(/^(?:(?:um+|uh+|so|okay|ok)\b[\s,]*)+/i, '')
    .replace(/[\s.!?]+$/, '');
}

function actionOf(lower: string): string {
  const bare = lower.replace(/[,.!?]/g, '').trim();
  if (/^(?:yes(?: confirmed)?|confirm(?:ed)?|send it)$/.test(bare)) return 'confirm';
  if (/^(?:no|cancel|stop|never ?mind)$/.test(bare)) return 'cancel';
  if (TELL_PREFIX.test(lower)) return 'tell';
  if (/^open\b/.test(lower)) return 'open';
  if (/^answer\b/.test(lower)) return 'answer';
  return 'none';
}

function positionOf(lower: string, options: string[]): string | undefined {
  const found = new RegExp(`\\b(next|previous|last|${ORD})\\b`).exec(lower)?.[1];
  if (!found) return undefined;
  if (['next', 'previous', 'last'].includes(found)) return found;
  const n = ordinalValue(found);
  return [String(n), ...(n === 1 ? ['first'] : [])].find((o) => options.includes(o));
}

/** Longest id first, so "waiting for ci" wins over any shorter id inside it. */
function statusOf(lower: string, options: string[]): string | undefined {
  const spaced = options.filter((o) => o !== 'none').map((id) => ({ id, words: id.replace(/-/g, ' ') }));
  spaced.sort((a, b) => b.words.length - a.words.length);
  return spaced.find(({ words }) => new RegExp(`\\b${words}\\b`).test(lower.replace(/-/g, ' ')))?.id;
}

function tellStartOf(sentence: string, options: string[]): string | undefined {
  const colon = sentence.indexOf(':');
  const text = (colon >= 0 ? sentence.slice(colon + 1) : sentence.replace(TELL_PREFIX, '')).trim();
  const spoken = [text, text.replace(/[.!?]+$/, '')].map((t) => t.toLowerCase());
  return options.find((o) => spoken.includes(keyText(o)?.trim().toLowerCase() ?? ''));
}

/** The question each stretch of the sentence belongs to: the words before the anchor that names it. */
function questionSegments(sentence: string): Map<number, string> {
  const segments = new Map<number, string>();
  let from = 0;
  for (const anchor of sentence.matchAll(QUESTION_ANCHOR)) {
    const n = ordinalValue(anchor[1] ?? anchor[2] ?? '');
    if (n >= 1) segments.set(n - 1, trimSegment(sentence.slice(from, anchor.index)));
    from = anchor.index + anchor[0].length;
  }
  return segments;
}

function trimSegment(text: string): string {
  let out = text.trim();
  for (let next = out.replace(/^(?:(?:answer|and|then|to|for)\b|[:,])\s*/i, ''); next !== out; ) {
    out = next;
    next = out.replace(/^(?:(?:answer|and|then|to|for)\b|[:,])\s*/i, '');
  }
  return out.replace(/[\s.!?,]+$/, '');
}

/** The choice's own words first, then "the second answer"; anything else is the user's own words. */
function choiceOf(segment: string, labels: string[]): string {
  const byLabel = labels.find((label) => label.toLowerCase() === segment.toLowerCase());
  if (byLabel !== undefined) return textKey(byLabel);
  for (const pattern of ORDINAL_CHOICE) {
    const word = pattern.exec(segment)?.[1];
    const label = word === undefined ? undefined : labels[ordinalValue(word) - 1];
    if (label !== undefined) return textKey(label);
  }
  return 'other';
}
