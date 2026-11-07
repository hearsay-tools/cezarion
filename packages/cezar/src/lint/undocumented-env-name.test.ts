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

it('derives both complete names from literal product helper suffixes', () => {
  const source = `productEnv('DRY_RUN'); productEnv("NEW_SETTING", env); // productEnv('COMMENT')
    const example = "productEnv('STRING')";`;
  expect(envNames(source)).toEqual(['CEZ_DRY_RUN', 'CEZ_NEW_SETTING', 'HSQ_DRY_RUN', 'HSQ_NEW_SETTING']);
  expect(undocumented(source, new Set(['CEZ_DRY_RUN', 'HSQ_DRY_RUN', 'CEZ_NEW_SETTING']))).toEqual(['HSQ_NEW_SETTING']);
});

it('keeps imported helper aliases and destructured env names documented', () => {
  expect(envNames(`import { productEnv as setting } from './product-env.ts';
    setting('NEW_FLAG'); setting?.('OPTIONAL'); const {CEZ_READ, HSQ_OTHER: other} = env;`))
    .toEqual(['CEZ_NEW_FLAG', 'CEZ_OPTIONAL', 'CEZ_READ', 'HSQ_NEW_FLAG', 'HSQ_OPTIONAL', 'HSQ_OTHER']);
});
