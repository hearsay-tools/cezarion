import { z } from 'zod';
import { onceStatusSchema } from './automations.ts';
import { zonedParts } from './zoned-time.ts';
import { isRealOnceAt, onceInstant } from './automation-schedule.ts';

/**
 * The two session tools for one-time scheduled tasks (hearsay-tools/cezarion#1465):
 * `cezar_schedule_task` creates one, `cezar_scheduled_tasks` lists and changes them. An agent
 * reaches them through the bundled MCP adapter, which relays raw arguments over the session's
 * private tool socket; the run and project come from the session, never from these arguments,
 * which is why every request object is strict. A one-time schedule IS an automation
 * (`schedule.type: 'once'`); these shapes are the agent's view of it.
 */

/**
 * Request and answer sizes of the two tools: a 100 000-character prompt and a list of 50. The
 * request cap is in bytes: one UTF-16 unit of the prompt can take six bytes on the wire (`\u0001`
 * escaped, or a lone surrogate), so 600 000 for the prompt plus the short fields fits 1 MiB.
 */
export const SCHEDULED_TASK_LIMITS = { prompt: 100_000, list: 50, wireBytes: 1_048_576 } as const;

const DURATION = /^(\d+)\s*([mhd])$/;
const durationField = z.string().regex(DURATION, 'a duration such as 30m, 6h or 7d');

/** `30m`, `6h`, `7d` (d = 24 h of elapsed time) as minutes. Throws on anything else. */
export function parseDurationMinutes(value: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`"${value}" is not a duration; use 30m, 6h or 7d`);
  const n = Number(match[1]);
  return match[2] === 'd' ? n * 1_440 : match[2] === 'h' ? n * 60 : n;
}

/**
 * `delay` after `nowMs`, as the `at` wall time (`YYYY-MM-DDTHH:MM`) in `timeZone`, rounded UP to
 * the minute so the resolved time is never earlier than asked. The delay is elapsed time: seven
 * days across a DST change lands one wall-clock hour away from the starting hour.
 */
export function resolveDelay(delay: string, nowMs: number, timeZone: string): string {
  const target = Math.ceil((nowMs + parseDurationMinutes(delay) * 60_000) / 60_000) * 60_000;
  const pad = (n: number) => String(n).padStart(2, '0');
  // A wall time names one instant of a clock overlap (the one `onceInstant` picks). When the
  // target is the other one, the first later minute whose wall time reads back at or after the
  // target is used: never earlier than asked, at most the overlap's length later (#1465 review).
  for (let minute = 0; minute <= 1_440; minute += 1) {
    const parts = zonedParts(target + minute * 60_000, timeZone);
    if (!parts) throw new Error(`unknown time zone "${timeZone}"; use an IANA name such as Europe/Warsaw`);
    const at = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
    if ((onceInstant({ type: 'once', at, timeZone }) ?? target) >= target) return at;
  }
  throw new Error(`no wall time in ${timeZone} reads back at or after the delay`);
}

/** The fields a create and an update share. */
const scheduleFields = {
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'a local wall time YYYY-MM-DDTHH:MM').refine(isRealOnceAt, 'not a real date and time').optional(),
  delay: durationField.optional(),
  time_zone: z.string().min(1).max(100).optional(),
  latest_start: durationField.optional(),
  workflow: z.string().trim().min(1).max(200).optional(),
  runner: z.string().trim().min(1).max(32).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(32).optional(),
};

const notBoth = (value: { at?: string | undefined; delay?: string | undefined }) => !(value.at && value.delay);

/** `cezar_schedule_task`. */
export const scheduleTaskRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    prompt: z.string().min(1).max(SCHEDULED_TASK_LIMITS.prompt),
    ...scheduleFields,
    enable: z.boolean().optional(),
  })
  .strict()
  .refine(notBoth, { message: 'give at or delay, not both', path: ['delay'] })
  .refine((value) => Boolean(value.at || value.delay), { message: 'give at (with time_zone) or delay', path: ['at'] });
export type ScheduleTaskRequest = z.infer<typeof scheduleTaskRequestSchema>;

const idField = z.string().min(1).max(100);

/** `cezar_scheduled_tasks`: one action per call. */
export const scheduledTasksRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), archived: z.enum(['include', 'only']).optional() }).strict(),
  z.object({ action: z.literal('show'), id: idField }).strict(),
  z.object({
    action: z.literal('update'),
    id: idField,
    name: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().min(1).max(SCHEDULED_TASK_LIMITS.prompt).optional(),
    ...scheduleFields,
  }).strict().refine(notBoth, { message: 'give at or delay, not both', path: ['delay'] }),
  z.object({ action: z.literal('pause'), id: idField }).strict(),
  z.object({ action: z.literal('enable'), id: idField }).strict(),
  z.object({ action: z.literal('cancel'), id: idField }).strict(),
]);
export type ScheduledTasksRequest = z.infer<typeof scheduledTasksRequestSchema>;

/** One one-time schedule as the agent sees it. */
export const scheduledTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: onceStatusSchema,
  /** The local wall time and its zone, as stored. */
  due_at: z.string(),
  time_zone: z.string(),
  /** The same moment as a UTC ISO instant. */
  resolved_instant: z.string(),
  latest_start_minutes: z.number().optional(),
  /** The task it launched, once archived with one. */
  run_id: z.string().optional(),
  /** The cockpit page of the schedule, when the cockpit's address is known. */
  url: z.string().optional(),
});
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export const scheduledTaskRefusalCodeSchema = z.enum(['invalid_request', 'unavailable', 'not_found', 'conflict', 'automations_off']);
export type ScheduledTaskRefusalCode = z.infer<typeof scheduledTaskRefusalCodeSchema>;
const refusal = z.object({ ok: z.literal(false), code: scheduledTaskRefusalCodeSchema, message: z.string() });

/** The note every create answer carries: Cezarion has no daemon, so it must be running. */
export const SCHEDULED_TASK_NOTE = 'Cezarion must be running at the due time, or start again before the latest start, for this task to launch.';

export const scheduleTaskAnswerSchema = z.union([
  z.object({ ok: z.literal(true), task: scheduledTaskSchema, note: z.string() }),
  refusal,
]);
export type ScheduleTaskAnswer = z.infer<typeof scheduleTaskAnswerSchema>;

export const scheduledTasksAnswerSchema = z.union([
  z.object({ ok: z.literal(true), tasks: z.array(scheduledTaskSchema).max(SCHEDULED_TASK_LIMITS.list) }),
  z.object({ ok: z.literal(true), task: scheduledTaskSchema }),
  refusal,
]);
export type ScheduledTasksAnswer = z.infer<typeof scheduledTasksAnswerSchema>;
