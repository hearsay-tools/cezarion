/**
 * "Which option?" read from a spoken or typed reply: `2`, `two`, `number two`, `the second`,
 * `second one`. Returns the 0-based index, or `null` for anything else and for a number outside
 * `1..count`. One to ten only, which is what the contract's position field allows too.
 */

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']

const PICK = new RegExp(`^(?:the\\s+)?(?:number\\s+)?(\\d{1,2}|${[...WORDS, ...ORDINALS].join('|')})(?:\\s+one)?$`)

export function parseNumberedPick(text: string, count: number): number | null {
  const token = PICK.exec(text.toLowerCase().trim().replace(/[.!?]$/, '').trim())?.[1]
  if (token === undefined) return null
  const number = /^\d+$/.test(token) ? Number(token) : Math.max(WORDS.indexOf(token), ORDINALS.indexOf(token)) + 1
  return number >= 1 && number <= Math.min(10, count) ? number - 1 : null
}
