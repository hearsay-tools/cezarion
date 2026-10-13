/**
 * Full command text for an expanded exec card.
 *
 * Collapsed titles go through toolDisplay (oneLine + 120-char cap). The
 * expanded body must read the raw input.command instead: a string stays
 * verbatim, an argv list keeps each argument's boundaries.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SAFE_ARGV = /^[A-Za-z0-9_./:=+,@%-]+$/

function escapeSingleQuotes(arg: string): string {
  return arg.replaceAll('\u0027', `\u0027\\\u0027\u0027`)
}

/** POSIX-quote an argv member so spaces and operators stay one argument. */
export function quoteExecArg(arg: string): string {
  if (arg === '') return "''"
  if (SAFE_ARGV.test(arg)) return arg
  return `\u0027${escapeSingleQuotes(arg)}\u0027`
}

/** Raw command from a runner's item.input, or undefined when none exists. */
export function fullExecCommand(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const command = input.command
  if (typeof command === 'string' && command !== '') return command
  if (Array.isArray(command)) {
    const argv = command.filter((part): part is string => typeof part === 'string')
    if (argv.length > 0) return argv.map(quoteExecArg).join(' ')
  }
  return undefined
}
