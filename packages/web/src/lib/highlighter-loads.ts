import type { HighlighterCore } from 'shiki/core'

/**
 * The in-flight load registry of the Shiki highlighter, kept in a leaf so the web test setup can
 * settle the loads without importing the highlighter. The highlighter registers its core boot
 * and grammar loads here.
 */
export const highlighterLoads: {
  core: Promise<HighlighterCore> | null
  langs: Map<string, Promise<void>>
} = {
  core: null,
  langs: new Map<string, Promise<void>>(),
}

/**
 * Test seam: resolve once the core boot and every in-flight grammar load have settled. A render
 * starts those loads un-awaited, so without this they run on past cleanup into the next case
 * (#601). Rejections are swallowed — callers already degrade a failed load to plaintext.
 */
export async function highlighterSettledForTests(): Promise<void> {
  await Promise.allSettled([highlighterLoads.core, ...highlighterLoads.langs.values()])
}
