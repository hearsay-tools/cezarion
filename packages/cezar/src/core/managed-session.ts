import type { AgentEvent, AgentRunner, AgentRunSpec, AgentSession, SessionOptions } from './agent-runner.ts';
import { DEFAULT_NO_PROGRESS_TIMEOUT_MS } from './runner-runtime.ts';

/** Wall-clock limits and open-turn liveness are independent. Native stream
 * activity refreshes this guard even when a mapper/coalescer emits no UI event.
 * Turn boundaries and human questions park it; starting/answering a turn rearms it.
 * Standalone runner users retain their existing deadline policy. */
export function startManagedSession(
  runner: Pick<AgentRunner, 'startSession'>,
  spec: AgentRunSpec,
  onEvent: (event: AgentEvent) => void,
  opts: SessionOptions,
): AgentSession {
  let session: AgentSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let turnOpen = true;
  let stopped = false;
  let phase = 0;
  const pause = (): void => {
    phase += 1;
    turnOpen = false;
    clearTimeout(timer);
    timer = undefined;
  };
  const stop = (): void => { stopped = true; pause(); };
  const activity = (): void => {
    if (stopped || !turnOpen) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      onEvent({ type: 'error', message: `Agent made no progress for ${DEFAULT_NO_PROGRESS_TIMEOUT_MS / 60_000} minutes during an open turn and was terminated` });
      session?.interrupt();
    }, DEFAULT_NO_PROGRESS_TIMEOUT_MS);
    timer.unref?.();
  };
  const begin = (): void => { if (!stopped) { phase += 1; turnOpen = true; activity(); } };
  // Includes a backend that accepts the opening prompt but never announces a turn.
  begin();
  try {
    session = runner.startSession(spec, event => {
      if (event.type === 'turn-end') pause();
      if (event.type === 'error' || event.type === 'done') stop();
      onEvent(event);
    }, {
      ...opts,
      onActivity: () => { activity(); opts.onActivity?.(); },
      onUiEvent: event => {
        if (event.type === 'turn.started') begin();
        if (event.type === 'ask.requested') pause();
        opts.onUiEvent?.(event);
      },
    });
  } catch (error) { stop(); throw error; }
  const live = session;
  const result = live.result.then(value => { stop(); return value; }, error => { stop(); throw error; });
  return {
    result,
    get pid() { return live.pid; },
    get open() { return live.open; },
    sendMessage(content) {
      const wasOpen = turnOpen;
      if (!wasOpen) begin(); // Native question answers resume the same turn ID.
      const accepted = live.sendMessage(content);
      if (!accepted && !wasOpen) pause();
      return accepted;
    },
    sendAgentMessage(content, ids) {
      const wasOpen = turnOpen;
      if (!wasOpen) begin();
      const admissionPhase = phase;
      const rollback = (): void => { if (!wasOpen && phase === admissionPhase) pause(); };
      try {
        const accepted = live.sendAgentMessage(content, ids);
        if (accepted === false) { rollback(); return false; }
        // Do not rearm after an ACK: a synchronous turn-end or ask may already
        // have parked the session. Only a refused reservation rolls back.
        return accepted.catch(error => { rollback(); throw error; });
      } catch (error) { rollback(); throw error; }
    },
    discardQueuedMessages: () => live.discardQueuedMessages(),
    end: () => { stop(); live.end(); },
    interrupt: () => { stop(); live.interrupt(); },
  };
}
