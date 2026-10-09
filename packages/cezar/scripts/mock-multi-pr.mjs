/** Shared content only; each adapter emits it through its own native wire. */
export function multiPrText(prompt) {
  return prompt.includes('mock:multi-pr-refs-continue')
    ? 'CEZ:PR=813\nCEZ:PR=817\nCEZ:DONE'
    : 'CEZ:PR=812\nCEZ:PR=813\nCEZ:PR=814\nCEZ:PR=815\nCEZ:PR=812\nCEZ:PR=816\nCEZ:DONE';
}
export const unrelatedPr = 'CEZ:PR=999\nCreated a PR: https://github.com/other/repo/pull/999';
