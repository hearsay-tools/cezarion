import { describe, expect, it } from 'vitest';
import { exactLineIndex, nextLineIndex } from './handoff.ts';

/**
 * The handoff header lookups (hearsay-tools/cezarion#1147, hearsay-tools/cezarion#1809). A header
 * counts only as a whole line, and a line ends at LF or CRLF: an agent or an editor can save the
 * file with CRLF endings.
 */
describe('exactLineIndex', () => {
  it.each([
    ['LF', '# Handoff\n\n## Goal\n\ndo it\n', 11],
    ['CRLF', '# Handoff\r\n\r\n## Goal\r\n\r\ndo it\r\n', 13],
    ['the first line', '## Goal\ndo it\n', 0],
    ['the last line, without an ending', 'do it\n## Goal', 6],
    ['the last line, ending in CR LF', 'do it\r\n## Goal\r\n', 7],
  ])('finds the header on its own line: %s', (_case, text, index) => {
    expect(exactLineIndex(text, '## Goal')).toBe(index);
  });

  it.each([
    ['quoted inside a line', 'Fix the "## Goal" lookup\n'],
    ['as the start of a longer line', '## Goals\n'],
    ['followed by a bare CR', '## Goal\rdo it\n'],
    ['absent', '# Handoff\n'],
  ])('finds no header %s', (_case, text) => {
    expect(exactLineIndex(text, '## Goal')).toBe(-1);
  });

  it('skips a quoted header and finds the real one after it', () => {
    const text = 'Fix the "## Goal" line\r\n## Goal\r\n';
    expect(exactLineIndex(text, '## Goal')).toBe(text.indexOf('## Goal\r'));
  });
});

describe('nextLineIndex', () => {
  it.each([
    ['LF', 'a\nb', 0, 2],
    ['CRLF', 'a\r\nb', 0, 3],
    ['the last line', 'a\nb', 2, 3],
  ])('steps past the line and its ending: %s', (_case, text, index, next) => {
    expect(nextLineIndex(text, index)).toBe(next);
  });
});
