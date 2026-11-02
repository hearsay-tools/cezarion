/** Shared content only; each adapter emits it through its own native wire. The turn finishes
 *  through `lifecycle(DONE)`, the caller's cezar_done call. */
import { DONE } from './mock-ci-tool.mjs';
export async function multiPrText(prompt, lifecycle) {
  const refs = prompt.includes('mock:multi-pr-refs-continue')
    ? 'CEZ:PR=813\nCEZ:PR=817'
    : 'CEZ:PR=812\nCEZ:PR=813\nCEZ:PR=814\nCEZ:PR=815\nCEZ:PR=812\nCEZ:PR=816';
  return refs + await lifecycle(DONE);
}
export const unrelatedPr = 'CEZ:PR=999\nCreated a PR: https://github.com/other/repo/pull/999';
