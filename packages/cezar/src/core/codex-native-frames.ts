import { isSignalTerminationExit } from './agent-runner.ts';
import type { CodexAppServerMessage } from './codex-app-server-transport.ts';

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

/** A non-zero exit that is not cezar's own signal teardown still carries stderr. */
export function sessionStderrIsUnexpected(exitCode: number | null, timedOut: boolean, terminatedByCezar: boolean): boolean {
  return !timedOut && exitCode !== 0 && exitCode !== null && !(terminatedByCezar && isSignalTerminationExit(exitCode));
}

/** Startup died on a real non-signal exit, so the drained stderr owns the failure text. */
export function startupCrashOwnsFailure(
  session: { startupComplete: boolean; timedOut: boolean; terminatedByCezar: boolean },
  stderr: string,
  exitCode: number | null,
): boolean {
  return !session.startupComplete && !session.timedOut && !!stderr.trim() && exitCode !== null && exitCode !== 0
    && !(session.terminatedByCezar && isSignalTerminationExit(exitCode));
}

/** 143/137, or a signal with no code, is the teardown cezar asked for. */
export function cezarAskedForExit(exitCode: number | null, signalCode: NodeJS.Signals | null): boolean {
  return isSignalTerminationExit(exitCode) || (exitCode === null && signalCode !== null);
}

export type SessionExitKind = 'timeout' | 'cezar-teardown' | 'signal' | 'nonzero' | 'clean';

/** Which exit branch owns the result, in the order the runner checks them. */
export function sessionExitKind(exit: {
  timedOut: boolean;
  terminatedByCezar: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): SessionExitKind {
  if (exit.timedOut) return 'timeout';
  if (exit.terminatedByCezar && cezarAskedForExit(exit.exitCode, exit.signalCode)) return 'cezar-teardown';
  if (exit.exitCode === null && exit.signalCode !== null) return 'signal';
  if (exit.exitCode !== 0 && exit.exitCode !== null) return 'nonzero';
  return 'clean';
}
