/** At most `max` UTF-16 units, never ending inside a surrogate pair. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/** The first line that is not blank, trimmed and clamped; undefined when there is none. */
export function firstLine(text: string | undefined, max: number): string | undefined {
  const line = text?.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  return line === undefined ? undefined : clampText(line, max);
}
