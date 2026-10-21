/**
 * Candidate spans of a dictated sentence: the pieces code offers the engine as options, so the engine
 * picks words and code copies them exactly as said (spec 2026-10-21-voice-mode, "Answer the question
 * card"). Pure string work; nothing here decides anything.
 */

const MAX_CANDIDATES = 20;

const ORDINAL = '(?:one|two|three|four|first|second|third|fourth|[1-4])';
/** "to question first", "for the second question", "question 2": where the sentence names a question. */
const QUESTION_ANCHOR = new RegExp(
  `(?:\\b(?:to|for)\\s+)?(?:\\bthe\\s+)?\\b(?:question\\s+${ORDINAL}|${ORDINAL}\\s+question)\\b`,
  'gi',
);
/** Where dictated text starts: "tell it", "tell the agent to", "reply with", "say", "message it". */
const TELL_TRIGGER = /\b(?:tell\s+(?:it|the\s+agent|them)(?:\s+to)?|reply(?:\s+with)?|say|message(?:\s+it)?)\b/gi;

const LEADING = /^(?:(?:um+|uh+|so|okay|ok|answer|and|then|to|for)\b|[\s:,])+/i;
const TRAILING = /[\s.!?,]+$/;

/** No leading filler word or colon, no trailing sentence mark. */
function clean(text: string): string {
  return text.replace(LEADING, '').replace(TRAILING, '');
}

function unique(texts: string[]): string[] {
  return [...new Set(texts.filter((text) => text !== ''))].slice(0, MAX_CANDIDATES);
}

/** The text between question references, each neighbouring pair joined with ": ", and each part after a colon. */
export function candidateSpans(sentence: string): string[] {
  const segments: string[] = [];
  let from = 0;
  for (const anchor of sentence.matchAll(QUESTION_ANCHOR)) {
    segments.push(clean(sentence.slice(from, anchor.index)));
    from = anchor.index + anchor[0].length;
  }
  segments.push(clean(sentence.slice(from)));
  const named = segments.filter((segment) => segment !== '');
  const spans: string[] = [...named];
  for (let i = 0; i + 1 < named.length; i++) spans.push(`${named[i]}: ${named[i + 1]}`);
  for (const segment of named) {
    const colon = segment.indexOf(':');
    if (colon >= 0) spans.push(clean(segment.slice(colon + 1)));
  }
  return unique(spans);
}

/** The text after the first colon, and after each tell-it trigger. */
export function tellStarts(sentence: string): string[] {
  const starts: string[] = [];
  const colon = sentence.indexOf(':');
  if (colon >= 0) starts.push(clean(sentence.slice(colon + 1)));
  for (const trigger of sentence.matchAll(TELL_TRIGGER)) starts.push(clean(sentence.slice(trigger.index + trigger[0].length)));
  return unique(starts);
}
