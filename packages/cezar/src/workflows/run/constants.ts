/** An interactive session that hears nothing from the user closes itself. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;

/** #505: a worker question routed to its parent is answered there until it falls back. */
export const ROUTED_QUESTION_REFUSAL = 'This question was sent to the parent task; answer it there.';

/** #505: a real steer is read at the harness's next model step; a quiet boundary this long
 * with input still unread means the harness will not read it without help. */
export const UNREAD_INPUT_GRACE_MS = 30_000;

/** Bound a no-wait nudge that is ACKed but never produces a turn (#544,
 *  hearsay-tools/cezarion#1234). OpenCode heartbeats re-arm the managed-session no-progress
 *  guard, so this is the DEFAULT-path exit when the agent stays silent. Overridable on RunManager. */
export const NO_WAIT_NUDGE_REPLY_MS = 5 * 60_000;

/** A root's done blocked at a turn end is answered with the refusal `cezar_done` gives, as one
 *  automatic turn (hearsay-tools/cezarion#1301). The nudge adds this sentence when live workers block
 *  it; the mid-turn answer never does. */
export const COMPLETION_WILL_WAIT = 'If you end your turn with done again while these workers are live, Cezar will wait on them for you and wake you when they have all settled.';

/** Bound one unattended session; an explicit Continue starts a new budget. */
export const MAX_AUTO_CONTINUES = 40;

/** Claude's `ScheduleWakeup` accepts at most an hour (hearsay-tools/cezarion#1233). */
export const SCHEDULE_WAKEUP_MAX_SECONDS = 3600;

/**
 * Consecutive failed automatic attempts to deliver a run's wait results (hearsay-tools/cezarion#1233):
 * each is a session that failed, or closed cleanly, while the results were still owed, counted across
 * the replacement sessions that retry them. At the bound the run settles `failed` and keeps the
 * results for a human. The count is in memory, per manager, so a restart starts it again, like the
 * per-session wake budget. A delivery acknowledgement, human input, Continue, Stop, Finish and
 * cancel reset it; a usage-limit failure is not counted, because its own hold and automatic resume
 * take it.
 */
export const MAX_WAKE_DELIVERY_ATTEMPTS = 3;
export const WAKE_DELIVERY_CAP_NOTE = `could not deliver wait results after ${MAX_WAKE_DELIVERY_ATTEMPTS} attempts — continue this task to retry`;
/** The error of a session that closed cleanly while it still owed wait results. */
export const WAKE_SESSION_CLOSED_ERROR = 'the session closed before the wait results were delivered';
/** Stop on a failed run that held wait results: the results and the open waits are gone. */
export const WAITS_DISCARDED_NOTE = 'Stop discarded the waits this task held and their results; the task stays failed';
/** Stop on a failed run that only owed a completion refusal (hearsay-tools/cezarion#1301). */
export const REFUSAL_DISCARDED_NOTE = 'Stop discarded the completion refusal this task still owed; the task stays failed';

/**
 * How often the queue checks that it is not wedged.
 *
 * A hold is the only thing in the engine that can make an idle queue CORRECT, so it is also the
 * only thing that can make a wedged one look correct. This tick is the way out: cheap (a few
 * in-memory checks), unref'd, and it only ever acts when idling has no justification left.
 */
export const QUEUE_WATCHDOG_MS = 60_000;

/** How often a project with no usable repository re-probes Git while queued work waits behind the
 *  one-task fallback (hearsay-tools/cezarion#2257). Half a minute starts that work within 60 s. */
export const REPO_REDISCOVERY_MS = 30_000;

export const RESTART_CONTINUATION_PROMPT =
  'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';
