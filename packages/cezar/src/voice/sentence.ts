/**
 * Candidate spans of a dictated sentence: the pieces code offers the engine as options, so the engine
 * picks words and code copies them exactly as said (spec 2026-10-21-voice-mode, "Answer the question
 * card"). Pure string work; nothing here decides anything.
 */

const MAX_CANDIDATES = 20;

const ORDINAL = '(?:one|two|three|four|first|second|third|fourth|[1-4])';
/** Where dictated text starts: "tell it", "tell the agent to", "reply with", "say", "message it". */
const TELL_TRIGGER = /\b(?:tell\s+(?:it|the\s+agent|them)(?:\s+to)?|reply(?:\s+with)?|say|message(?:\s+it)?)\b/gi;

const CONNECTOR = /^(?:(?:answer|and|then|to|for)\b|[\s:,])+/i;
const FILLER = /^(?:um+|uh+|so|okay|ok)\b/i;
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

/**
 * No leading connector word, colon or comma, no trailing sentence mark. A leading filler ("um", "okay")
 * goes only when words remain after it, so a dictated "okay" or "so" is never cleaned away.
 */
function clean(text: string): string {
  let out = text.replace(TRAILING, '');
  for (let next = strip(out); next !== out; next = strip(out)) out = next;
  return out;
}

/** One step of cleaning: a connector off the front, else a filler when words remain after it. */
function strip(text: string): string {
  const connector = text.replace(CONNECTOR, '');
  if (connector !== text) return connector;
  const filler = text.replace(FILLER, '');
  return filler !== text && filler.replace(CONNECTOR, '') !== '' ? filler : text;
}

function unique(texts: string[]): string[] {
  return [...new Set(texts.filter((text) => text !== ''))].slice(0, MAX_CANDIDATES);
}

/** The text between question references, each neighbouring pair joined with ": ", and each part after a colon. */
export function candidateSpans(sentence: string, headers: string[] = []): string[] {
  const segments: string[] = [];
  let from = 0;
  for (const anchor of sentence.matchAll(questionAnchors(headers))) {
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
