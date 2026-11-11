/**
 * An exemption reason says what the runner's wire cannot carry. "Not implemented yet" is never a
 * reason: that is a failing row, and the fix is the runner, not the exemption table. Every
 * exemption table of the parity kits holds its reasons to this check.
 */

/**
 * Wording that says the work is undone or put off, not that the wire cannot carry the row. Any
 * "yet" is refused, whatever stands between it and its negation ("not supported yet").
 */
const PUT_OFF = /\b(?:not\s+(?:yet\s+)?implemented|unimplemented|yet|to-?do|tbd|later|for\s+now)\b/i;

/** What is wrong with an exemption reason, or `undefined` when it may stand. */
export function exemptionReasonProblem(reason: string): string | undefined {
  if (reason.trim() === '') return 'the reason is empty';
  const wording = PUT_OFF.exec(reason)?.[0];
  return wording === undefined ? undefined : `"${wording}" says the work is put off; name what the wire cannot carry`;
}
