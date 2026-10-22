/**
 * The dictated sentence as numbered words (hearsay-tools/cezarion#1463). The engine labels each word
 * with the part of the reply it belongs to; code copies the words back out of the sentence exactly as
 * said (spec 2026-10-21-voice-mode, "Answer the question card"). Pure string work; nothing here
 * decides anything.
 */

export interface VoiceWord {
  /** `W01`, `W02`, … as the engine sees it in `words`. */
  id: string;
  text: string;
  /** Where the word sits in the sentence: `sentence.slice(start, end) === text`. */
  start: number;
  end: number;
}

const ORDINAL = '(?:one|two|three|four|first|second|third|fourth|[1-4])';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the sentence names a question: by number ("to question first", "the second question") or by
 * its card header ("to Library", "for the Library question", "Library question").
 */
function questionAnchors(headers: string[]): RegExp {
  const named = [...headers]
    .filter((header) => header.trim() !== '')
    .sort((a, b) => b.length - a.length)
    .map((header) => {
      const h = `(?<!\\w)${escapeRegExp(header.trim())}(?!\\w)`;
      return `\\b(?:to|for)\\s+(?:the\\s+)?${h}(?:\\s+question\\b)?|(?:\\bthe\\s+)?${h}\\s+question\\b`;
    });
  const numbered = `(?:\\b(?:to|for)\\s+)?(?:\\bthe\\s+)?\\b(?:question\\s+${ORDINAL}|${ORDINAL}\\s+question)\\b`;
  return new RegExp([...named, numbered].join('|'), 'gi');
}

export function wordId(index: number): string {
  return `W${String(index + 1).padStart(2, '0')}`;
}

export function splitWords(sentence: string): VoiceWord[] {
  return [...sentence.matchAll(/\S+/g)].map((match, i) => ({
    id: wordId(i),
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** The indices of the words inside a question reference: they point at a question, they never answer it. */
export function questionReferenceWords(sentence: string, words: readonly VoiceWord[], headers: string[]): Set<number> {
  const found = new Set<number>();
  for (const anchor of sentence.matchAll(questionAnchors(headers))) {
    const from = anchor.index;
    const to = anchor.index + anchor[0].length;
    words.forEach((word, i) => {
      if (word.start < to && word.end > from) found.add(i);
    });
  }
  return found;
}

export function namesQuestion(sentence: string, headers: string[]): boolean {
  return questionAnchors(headers).test(sentence);
}

/** The words `first`..`last` exactly as said, without a trailing sentence mark or comma. */
export function copyRange(sentence: string, words: readonly VoiceWord[], first: number, last: number): string {
  const from = words[first];
  const to = words[last];
  if (from === undefined || to === undefined) return '';
  return sentence.slice(from.start, to.end).replace(/[\s.!?,]+$/, '');
}
