import { COMMAND_LABEL, MESSAGE_LABEL, QUESTION_IDS, keyText, questionLabel, textKey, type DecisionEngine, type EngineAnswer, type EngineQuestion, type VoiceEngineState } from './engine.ts';
import { copyRange, splitWords, type VoiceWord } from './sentence.ts';

/**
 * The dry-run engine (`CEZ_DRY_RUN=1`): deterministic, offline, and small on purpose. It reads a
 * fixed phrase set — "open <position> <status>", "answer <choice | the Nth answer | words> to
 * question <N>", "answer that <words>", "tell it: <text>", "reply <text>", "say <text>",
 * "yes, confirmed", "no" / "cancel" — which is exactly what the browser E2E says. It is not a second
 * engine: anything else reads as "not a command".
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
/** The command words a reply starts with, after any filler; what follows is the reply. */
const REPLY_PREFIX = /^(?:(?:um+|uh+|so|okay|ok)\b[\s,]*)*(?:answer(?:\s+that)?|tell\s+(?:it|the\s+agent|them)(?:\s+that)?|reply(?:\s+with)?|say(?:\s+that)?|message\s+it)\b[\s:,]*/i;
/** Words that join a reply's parts: "and", "then", a dangling "to"/"for". */
const CONNECTOR = /^(?:and|then|to|for)[,.]?$/i;

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
  const words = splitWords(state.sentence);
  const wordLabels = labelWords(state, words, action);
  const labelsOf = (i: number) => state.card?.[i]?.options?.map((o) => o.label) ?? [];
  /** The words labelled with question `i`, as said. */
  const answerOf = (i: number) => {
    const own = wordLabels.flatMap((label, k) => (label === questionLabel(i) ? [k] : []));
    return own.length === 0 ? undefined : copyRange(state.sentence, words, own[0]!, own[own.length - 1]!);
  };

  return {
    choose(id, options) {
      if (id === QUESTION_IDS.scope) {
        if (action === 'open') return 'project';
        return action === 'none' ? 'none' : 'session';
      }
      if (id === QUESTION_IDS.projectAction) return action === 'open' ? 'open' : 'none';
      if (id === QUESTION_IDS.sessionAction) return action === 'confirm' || action === 'cancel' || action === 'respond' ? action : 'none';
      if (id === QUESTION_IDS.position) return positionOf(lower, options);
      if (id === QUESTION_IDS.status) return statusOf(lower, options);
      const word = /^w(\d+)$/.exec(id);
      if (word) return wordLabels[Number(word[1])];
      const option = /^q(\d+)_option$/.exec(id);
      if (!option) return undefined;
      const answer = answerOf(Number(option[1]));
      return answer === undefined ? 'other' : choiceOf(answer, labelsOf(Number(option[1])));
    },
    noul(id) {
      if (id === QUESTION_IDS.isCommand) return action === 'none' ? 0.05 : 0.95;
      const option = /^q(\d+)_opt(\d+)$/.exec(id);
      if (!option) return 0;
      const answer = answerOf(Number(option[1]));
      const label = labelsOf(Number(option[1]))[Number(option[2])];
      return answer !== undefined && label !== undefined && answer.toLowerCase().includes(label.toLowerCase()) ? 1 : 0;
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
  if (/^open\b/.test(lower)) return 'open';
  if (REPLY_PREFIX.test(lower) && REPLY_PREFIX.exec(lower)![0].trim() !== '') return 'respond';
  return 'none';
}

/**
 * One label per word: the reply's leading command words, question references and joining words are
 * `command`; with a card, the words before the reference that names question N are `qN`, and without
 * a reference a one-question card takes them all; without a card they are the message.
 */
function labelWords(state: VoiceEngineState, words: VoiceWord[], action: string): string[] {
  const labels = words.map(() => COMMAND_LABEL);
  if (action !== 'respond') return labels;
  const prefixEnd = REPLY_PREFIX.exec(state.sentence.trimStart())?.[0].length ?? 0;
  const replyStart = state.sentence.length - state.sentence.trimStart().length + prefixEnd;
  const inReply = (word: VoiceWord) => word.start >= replyStart;
  if (state.card === undefined) {
    words.forEach((word, k) => {
      if (inReply(word)) labels[k] = MESSAGE_LABEL;
    });
    return labels;
  }
  const anchors = [...state.sentence.matchAll(QUESTION_ANCHOR)];
  if (anchors.length === 0) {
    if (state.card.length === 1) {
      words.forEach((word, k) => {
        if (inReply(word)) labels[k] = questionLabel(0);
      });
    }
    return labels;
  }
  let from = replyStart;
  for (const anchor of anchors) {
    const n = ordinalValue(anchor[1] ?? anchor[2] ?? '');
    words.forEach((word, k) => {
      if (n >= 1 && word.start >= from && word.end <= anchor.index && !CONNECTOR.test(word.text)) labels[k] = questionLabel(n - 1);
    });
    from = anchor.index + anchor[0].length;
  }
  return labels;
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
