/** A source-only deadline request. The caller supplies the delay it sampled, including a
 *  worker checkpoint retry's explicit delay, so scheduling keeps that exact clock sample. */
export interface DeadlineRequest { deadline: string | undefined; delay: number }
export interface DeadlineObservation { outcome: 'deadline' }

/** Report a due deadline in the timer callback itself. There is deliberately no Promise hop:
 *  ordinary overdue deadlines are handled by the engine before it arms this adapter, while
 *  worker deadlines always arm it, including at zero delay. */
export function watchDeadline(request: DeadlineRequest, signal: AbortSignal, observe: (result: DeadlineObservation) => void): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (!signal.aborted) observe({ outcome: 'deadline' });
  }, request.delay);
  timer.unref?.();
  return timer;
}
