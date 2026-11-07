import { expect, it } from 'vitest';
import { documentedNames, envNames, undocumented } from './undocumented-env-name.ts';

it('requires HSQ documentation for property reads, writes and dynamic literal names', () => {
  const source = `const a = process.env.HSQ_HOME; env.HSQ_NEW = 'yes'; env['HSQ_DYNAMIC']; const old = env.CEZ_HOME;`;
  expect(envNames(source)).toEqual(['CEZ_HOME', 'HSQ_DYNAMIC', 'HSQ_HOME', 'HSQ_NEW']);
  expect(undocumented(source, new Set(['CEZ_HOME', 'HSQ_HOME']))).toEqual(['HSQ_DYNAMIC', 'HSQ_NEW']);
  expect(documentedNames().has('HSQ_HOME')).toBe(true);
});

it('keeps conservative literal-key scanning and ignores HSQ comments', () => {
  expect(envNames(`// env.HSQ_COMMENT\nconst x = 'HSQ_EXAMPLE'; /* env.HSQ_COMMENT2 */`)).toEqual(['HSQ_EXAMPLE']);
  expect(envNames(`// env.HSQ_COMMENT\nconst x = 'other text HSQ_EXAMPLE';`)).toEqual([]);
});
