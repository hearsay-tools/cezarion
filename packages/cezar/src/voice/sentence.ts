/**
 * Candidate spans of a dictated sentence: the pieces code offers the engine as options, so the engine
 * picks words and code copies them exactly as said (spec 2026-10-21-voice-mode, "Answer the question
 * card"). Pure string work; nothing here decides anything.
 */

const MAX_CANDIDATES = 20;

const ORDINAL = '(?:one|two|three|four|first|second|third|fourth|[1-4])';
/** Where dictated text starts: "tell it", "tell the agent to", "reply with", "say", "message it". */
const TELL_TRIGGER = /\b(?:tell\s+(?:it|the\s+agent|them)(?:\s+to)?|reply(?:\s+with)?|say|message(?:\s+it)?)\b/gi;

const CONNECTOR = /^(?:answer|and|then|to|for)\b/i;
const FILLER = /^(?:um+|uh+|so|okay|ok)\b/i;
const LEADING = /^[\s:,]+/;
const TRAILING = /[\s.!?,]+$/;

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

/** The words as said: only surrounding space, a leading colon or comma and a trailing sentence mark go. */
function literal(text: string): string {
  return text.replace(LEADING, '').replace(/[\s.!?]+$/, '');
}

/**
 * The words without the command syntax around them: no leading connector word ("and", "then", "answer"),
 * filler ("um", "okay"), colon or comma, no trailing sentence mark. A step that would leave nothing is
 * not taken, so a dictated "and" or "okay" is never cleaned away.
 */
function clean(text: string): string {
  let out = text.replace(TRAILING, '').replace(LEADING, '');
  for (;;) {
    const next = out.replace(CONNECTOR, '').replace(LEADING, '');
    const step = next !== out ? next : out.replace(FILLER, '').replace(LEADING, '');
    if (step === out || step === '') return out;
    out = step;
  }
}

/**
 * Each candidate as said, then cleaned when that differs (spec 2026-10-21-voice-mode: dictated text is
 * copied exactly; the cleaned form is the alternative for a stray leading "and").
 */
function forms(text: string): string[] {
  return [literal(text), clean(text)];
}

function unique(texts: string[]): string[] {
  return [...new Set(texts.filter((text) => text !== ''))].slice(0, MAX_CANDIDATES);
}

/** The text between question references, each neighbouring pair joined with ": ", and each part after a colon. */
export function candidateSpans(sentence: string, headers: string[] = []): string[] {
  const segments: string[] = [];
  let from = 0;
  for (const anchor of sentence.matchAll(questionAnchors(headers))) {
    segments.push(sentence.slice(from, anchor.index));
    from = anchor.index + anchor[0].length;
  }
  segments.push(sentence.slice(from));
  const named = segments.filter((segment) => literal(segment) !== '');
  const spans: string[] = named.flatMap(forms);
  for (let i = 0; i + 1 < named.length; i++) {
    const [a, b] = [named[i]!, named[i + 1]!];
    spans.push(`${literal(a)}: ${literal(b)}`, `${clean(a)}: ${clean(b)}`);
  }
  for (const segment of named) {
    const colon = segment.indexOf(':');
    if (colon >= 0) spans.push(...forms(segment.slice(colon + 1)));
  }
  return unique(spans);
}

/** The text after the first colon, and after each tell-it trigger. */
export function tellStarts(sentence: string): string[] {
  const starts: string[] = [];
  const colon = sentence.indexOf(':');
  if (colon >= 0) starts.push(...forms(sentence.slice(colon + 1)));
  for (const trigger of sentence.matchAll(TELL_TRIGGER)) starts.push(...forms(sentence.slice(trigger.index + trigger[0].length)));
  return unique(starts);
}
