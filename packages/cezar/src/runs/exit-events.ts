/**
 * The lifecycle events run exits write (Table B row B12 of
 * .ai/specs/2026-11-03-run-store-owns-exits.md): one `run cancelled` per cancellation. `RunStore`
 * keeps one of these and asks it, at each exit it applies, whether that write owes the event.
 */
import { logPrefix } from '../home/display.ts';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { exitEvent, RUN_CANCELLED, settlesRun, type ExitCall, type RunExitId } from './run-exits.ts';

export class ExitEvents {
  /** Runs whose execution wrote its event: a later exit back to cancelled in the same teardown (a
   *  worker Stop, its failed Continue session, then the late Stop) writes none, until an exit to a
   *  live status starts another execution. */
  private readonly written = new Set<string>();
  /** Runs a load cancelled: their event waits until transcripts are readable. */
  private readonly loaded: string[] = [];

  constructor(private readonly append: (id: string, event: { type: 'lifecycle'; message: string }) => unknown) {}

  /** The event the write that applies `exit` to run `id` at `from` owes, if any. */
  owed(id: string, exit: RunExitId, from: RunStatus, call: ExitCall = {}): string | undefined {
    const event = this.written.has(id) ? undefined : exitEvent(exit, from, call);
    if (!settlesRun(exit)) this.written.delete(id);
    return event;
  }

  /** A worker continuation applied its exit inside its own commit: another execution starts. */
  started(id: string): void { this.written.delete(id); }

  /** Run `id`'s load moved it into cancelled. */
  loadCancelled(id: string): void { this.loaded.push(id); }

  /** The event of each run a load cancelled, as a cancel exit writes it. */
  writeLoaded(): void { for (const id of this.loaded.splice(0)) this.write(id, RUN_CANCELLED); }

  /** An exit's event, after its write committed. Best-effort: a transcript that cannot be written
   *  (ENOSPC) never undoes or interrupts a status change that already happened, such as a Stop that
   *  still has to interrupt its session, and never stops the store from opening. */
  write(id: string, message: string): void {
    this.written.add(id);
    try { this.append(id, { type: 'lifecycle', message }); } catch (error) { console.warn(`${logPrefix()} run ${id}: lifecycle event "${message}" not written: ${String(error)}`); }
  }
}
