import { z } from 'zod';

/**
 * The handoff journal (`.ai/cezar/runs/<runId>.handoff.md`, spec 007) as the server and the
 * cockpit both read it. The agent writes the file; cezar keeps its own records in the run store
 * and writes them into the file as one block that it rewrites whole (hearsay-tools/cezarion#1809).
 */

/** How many autosave records a run keeps, newest first. */
export const HANDOFF_AUTOSAVE_RECORDS_MAX = 20;

/** One autosave report. `note` is the line as the block shows it; `periodic` holds the fields that
 *  consecutive timer commits on one branch are merged on (`branch: null` is a detached HEAD, a
 *  `null` sha one that could not be read back). */
export const handoffAutosaveRecordSchema = z.object({
  at: z.string(),
  note: z.string(),
  periodic: z.object({
    branch: z.string().nullable(),
    count: z.number().int().positive(),
    first: z.string().nullable(),
    latest: z.string().nullable(),
  }).optional(),
});
export type HandoffAutosaveRecord = z.infer<typeof handoffAutosaveRecordSchema>;

/** `RunRecord.handoffRecords`: cezar's own records for the run's handoff file, newest first. */
export const handoffRecordsSchema = z.object({ autosave: z.array(handoffAutosaveRecordSchema) });
export type HandoffRecords = z.infer<typeof handoffRecordsSchema>;

/** Index of the first line of `text` that is exactly `line`, or -1. Every handoff header lookup
 *  goes through it, so a Goal that quotes a header is never taken for one
 *  (hearsay-tools/cezarion#1147). A line ends at LF or CRLF: an agent or an editor can save the
 *  file with CRLF endings. */
export function exactLineIndex(text: string, line: string): number {
  const padded = `\n${text}\n`;
  for (let at = padded.indexOf(`\n${line}`); at >= 0; at = padded.indexOf(`\n${line}`, at + 1)) {
    const end = at + 1 + line.length;
    if (padded[end] === '\n' || padded.startsWith('\r\n', end)) return at;
  }
  return -1;
}

/** Index just past the line that starts at `index`: after its LF or CRLF, or the end of `text`. */
export function nextLineIndex(text: string, index: number): number {
  const end = text.indexOf('\n', index);
  return end < 0 ? text.length : end + 1;
}
