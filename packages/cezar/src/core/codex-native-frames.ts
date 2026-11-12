import { isSignalTerminationExit } from './agent-runner.ts';
import type { CodexAppServerMessage } from './codex-app-server-transport.ts';
import { productName } from '../home/display.ts';

/** Pure reads of native Codex app-server frames, for the session's stdout reader. */

/** Notifications that only collect output; never dispatch control after close. */
const PASSIVE_OUTPUT_METHODS = new Set([
  'item/started', 'item/updated', 'item/completed', 'item/agentMessage/delta',
  'item/reasoning/textDelta', 'item/reasoning/summaryDelta', 'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta', 'thread/tokenUsage/updated', 'turn/plan/updated',
  'hook/started', 'hook/completed',
]);

/** One native NDJSON line, or undefined when it is not JSON. */
export function parseNativeLine(line: string): CodexAppServerMessage | undefined {
  try { return JSON.parse(line) as CodexAppServerMessage; }
  catch { return undefined; }
}

export function isServerRequest(msg: CodexAppServerMessage): boolean {
  return typeof msg.method === 'string' && (typeof msg.id === 'number' || typeof msg.id === 'string');
}

function isTurnOutcome(method: string | undefined): boolean {
  return method === 'turn/completed' || method === 'turn/failed';
}

/** After close, only passive output and, after natural exit, the final
 *  outcome are drained, without restoring input authority. */
export function drainsAfterClose(msg: CodexAppServerMessage, exitedWithInputOpen: () => boolean): boolean {
  if (msg.id !== undefined) return false;
  if (PASSIVE_OUTPUT_METHODS.has(msg.method ?? '')) return true;
  return exitedWithInputOpen() && isTurnOutcome(msg.method);
}

export function isStaleTurnOutcome(msg: CodexAppServerMessage, activeTurnId: string | undefined): boolean {
  if (!isTurnOutcome(msg.method) || !activeTurnId) return false;
  const turnId = turnIdOf(msg.params ?? {});
  return !!turnId && turnId !== activeTurnId;
}

export function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

export function turnIdOf(obj: Record<string, unknown>): string | undefined {
  const turn = obj.turn as { id?: unknown } | undefined;
  return typeof turn?.id === 'string' ? turn.id : stringField(obj, 'turnId');
}

/** A non-zero exit that is not Squawk's own signal teardown still carries stderr. */
export function sessionStderrIsUnexpected(exitCode: number | null, timedOut: boolean, terminatedBySquawk: boolean): boolean {
  return !timedOut && exitCode !== 0 && exitCode !== null && !(terminatedBySquawk && isSignalTerminationExit(exitCode));
}

/** Startup died on a real non-signal exit, so the drained stderr owns the failure text. */
export function startupCrashOwnsFailure(
  session: { startupComplete: boolean; timedOut: boolean; terminatedBySquawk: boolean },
  stderr: string,
  exitCode: number | null,
): boolean {
  return !session.startupComplete && !session.timedOut && !!stderr.trim() && exitCode !== null && exitCode !== 0
    && !(session.terminatedBySquawk && isSignalTerminationExit(exitCode));
}

/** 143/137, or a signal with no code, is the teardown Squawk asked for. */
export function squawkAskedForExit(exitCode: number | null, signalCode: NodeJS.Signals | null): boolean {
  return isSignalTerminationExit(exitCode) || (exitCode === null && signalCode !== null);
}

export interface SessionExit {
  timedOut: boolean;
  terminatedBySquawk: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  limitMs: number;
  stderrSummary: string;
}

/** The one event a settled exit emits before `done`, or the error it throws. `undefined` is a clean exit. */
export function sessionExitEvent(exit: SessionExit): { event: 'error' | 'note'; message: string } | { failure: string } | undefined {
  if (exit.timedOut) {
    const mins = Math.round((exit.limitMs / 60_000) * 10) / 10;
    return { event: 'error', message: `codex app-server timed out after ${mins}m and was killed` };
  }
  // Our own EOF watchdog / cancel signal coming back as 143/137 — the
  // teardown Squawk asked for, not a codex failure (#703).
  if (exit.terminatedBySquawk && squawkAskedForExit(exit.exitCode, exit.signalCode)) {
    const how = exit.exitCode === null ? exit.signalCode : `code ${exit.exitCode}`;
    return { event: 'note', message: `codex app-server did not exit on its own after close; terminated by ${productName('Cezar')} (${how})` };
  }
  if (exit.exitCode === null && exit.signalCode !== null) return { failure: `codex app-server was killed by signal ${exit.signalCode}` };
  if (exit.exitCode !== 0 && exit.exitCode !== null) {
    return { failure: `codex app-server exited with code ${exit.exitCode}${exit.stderrSummary ? ` — ${exit.stderrSummary}` : ''}` };
  }
  return undefined;
}
