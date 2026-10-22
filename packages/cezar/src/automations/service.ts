import { z } from 'zod';
import { automationKindSchema, type AutomationKind, type AutomationListQuery, type OnceStatus } from '@open-mercato/cezar-contract/automations';
import { automationScheduleSchema, nextOccurrence, ONCE_PAST_DUE_MESSAGE, onceInstant } from '@open-mercato/cezar-contract/automation-schedule';
import { SCHEDULED_TASK_NOTE } from '@open-mercato/cezar-contract/scheduled-tasks';
import { MODEL_DISCOVERY_RUNNERS, type ModelDiscoveryRunner } from '@open-mercato/cezar-contract/workspace';
import { loadConfig } from '../config.ts';
import { missingModelChoices, type HostDiscovery } from '../discovery/catalog.ts';
import type { RunStore } from '../runs/store.ts';
import type { ForgeAvailability } from '../server/forge/index.ts';
import type { RunManager } from '../workflows/run.ts';
import { githubBaselineState } from './github-baseline.ts';
import { SCHEDULE_LEASE_HELD_REASON, ScheduleRunner, type ScheduleRunnerHandle } from './schedule-runner.ts';
import type { AutomationStore } from './store.ts';
import { validateAutomationPrompt } from './task-template.ts';
import {
  automationEventSchema,
  automationFiltersSchema,
  automationTaskSchema,
  isGithubAutomation,
  isOnceSchedule,
  isScheduleAutomation,
  type AutomationDefinition,
  type AutomationRuntimeState,
} from './types.ts';

/**
 * The automations family's behavior, shared by the HTTP routes and the session tools
 * (hearsay-tools/cezarion#1465): one place decides what a create, an edit or a toggle does, so
 * the cockpit, `cez automation` and the MCP tools cannot disagree. The routes stay thin and keep
 * their wire shapes; `contract-parity.automations.test.ts` checks them.
 *
 * One-time schedules add three rules on top of the repeating ones: their writes take the project
 * lease (a launch holds it, so a write never races one — Cancelled always means no task was
 * created); every write heals the archive invariant first (`ScheduleRunner.healArchive`); and a
 * due time in the past is refused wherever a body sets one.
 */

export const ONCE_PAST_DUE = ONCE_PAST_DUE_MESSAGE;
export const ONCE_ARCHIVED = 'this one-time schedule is archived';
export const ONCE_LAUNCH_IN_PROGRESS = 'a launch of this schedule is in progress; try again in a moment';
export const ONCE_ONLY_CANCEL = 'only a one-time schedule can be cancelled; pause or delete it instead';

/**
 * The editable body of both kinds. Every kind-specific key is optional here because which ones a
 * body must (or must not) carry depends on the kind, and on `PUT` the kind is the STORED one when
 * the body omits it — `resolveAutomationKind` below owns those rules.
 */
export const automationEditableSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().optional(),
    kind: automationKindSchema.optional(),
    events: z.array(automationEventSchema).min(1).max(4).optional(),
    intervalSeconds: z.number().int().min(60).max(86_400).optional(),
    filters: automationFiltersSchema.optional(),
    schedule: automationScheduleSchema.optional(),
    task: automationTaskSchema,
  })
  .strict();
export type AutomationEditable = z.infer<typeof automationEditableSchema>;
export const automationCreateSchema = automationEditableSchema.extend({ enable: z.boolean().optional() });
export const automationUpdateSchema = automationEditableSchema.extend({ expectedRevision: z.number().int().positive() });

/** What a project offers the service: its stores, its manager and where it lives. */
export interface AutomationServiceProject {
  id: string;
  root: string;
  automationStore: AutomationStore;
  store: RunStore;
  manager: RunManager;
}

export interface AutomationServiceDeps {
  /** The zone the repeating schedules run in: the server's own. */
  timeZone: () => string;
  /** Host model discovery; absent = explicit models are never refused at save. */
  discovery?: HostDiscovery;
  scheduleHandle: (project: AutomationServiceProject) => ScheduleRunnerHandle;
  emitChange: (project: AutomationServiceProject, automationId: string, revision: number, deleted?: boolean) => void;
  changed: () => void;
  /** The forge's settled availability for the list; never throws. */
  githubAvailability: (root: string) => Promise<ForgeAvailability>;
  /** Whether a GitHub automation could poll this project at all. */
  hasGithubRemote: (root: string) => Promise<boolean>;
  now?: () => number;
}

export type ServiceFailure = { ok: false; status: 400 | 404 | 409; error: string };
export type ServiceSuccess<T, S extends 200 | 201 | 202 | 204> = { ok: true; status: S; body: T };
const fail = (status: 400 | 404 | 409, error: string): ServiceFailure => ({ ok: false, status, error });

/** Where a one-time schedule stands; `undefined` for any other automation. */
export function onceStatus(definition: AutomationDefinition, state: AutomationRuntimeState | undefined): OnceStatus | undefined {
  if (!isOnceSchedule(definition)) return undefined;
  if (definition.archived) return 'archived';
  if (state?.onceOutcome) return state.onceOutcome;
  return definition.enabled ? 'waiting' : 'paused';
}

/** enable/pause carry no client revision, so a conflict is a race inside the write: 409, never 500. */
function toggleFailure(error: unknown): ServiceFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'automation not found') return fail(404, 'not found');
  if (message === 'automation revision conflict') return fail(409, 'the automation changed elsewhere; reload and try again');
  throw error;
}

function editableAutomation(definition: AutomationDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    enabled: definition.enabled,
    kind: definition.kind,
    ...(definition.events ? { events: definition.events } : {}),
    ...(definition.intervalSeconds !== undefined ? { intervalSeconds: definition.intervalSeconds } : {}),
    ...(definition.filters ? { filters: definition.filters } : {}),
    ...(definition.schedule ? { schedule: definition.schedule } : {}),
    task: definition.task,
  };
}

/**
 * Which kind a create/update body is, and whether its keys fit it (spec
 * 2026-10-02-scheduled-automations § Data model). A body without `kind` is `github` on create —
 * every pre-schedule client — and the STORED kind on update, so an old client editing a schedule
 * edits a schedule. Changing the kind is refused: receipts and cursors are kind-specific.
 */
function resolveAutomationKind(
  body: AutomationEditable,
  stored?: AutomationDefinition,
): { kind: AutomationKind } | ServiceFailure {
  const kind = body.kind ?? stored?.kind ?? 'github';
  if (stored && kind !== stored.kind) return fail(409, 'change the kind by creating a new automation');
  if (kind === 'schedule') {
    if (body.events !== undefined || body.intervalSeconds !== undefined || body.filters !== undefined) {
      return fail(400, 'a scheduled automation has no GitHub filter');
    }
    if (!body.schedule) return fail(400, 'a scheduled automation needs a schedule');
  } else {
    if (body.schedule !== undefined) return fail(400, 'a GitHub automation has no schedule');
    if (!body.events || body.intervalSeconds === undefined || !body.filters) {
      return fail(400, 'a GitHub automation needs events, intervalSeconds and filters');
    }
  }
  return { kind };
}

function sameSchedule(a: AutomationDefinition['schedule'], b: AutomationDefinition['schedule']): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The due time alone: a change of `latestStartMinutes` keeps the instant a one-time schedule fires at. */
function sameDueTime(a: AutomationDefinition['schedule'], b: AutomationDefinition['schedule']): boolean {
  if (a?.type === 'once' && b?.type === 'once') return a.at === b.at && a.timeZone === b.timeZone;
  return sameSchedule(a, b);
}

export function createAutomationService(deps: AutomationServiceDeps) {
  const now = () => deps.now?.() ?? Date.now();

  /**
   * The `nextRunAt` a schedule definition arms with: its next occurrence from now when enabled,
   * cleared when paused. Passed to the store's `create`/`update` as `arm`, which writes it BEFORE
   * the definition, so another cockpit's timer never pairs the new definition with the old instant.
   */
  const armAutomationFromNow = (definition: AutomationDefinition) => {
    if (isGithubAutomation(definition)) {
      return definition.enabled ? githubBaselineState(definition) : { nextCheckAt: undefined };
    }
    if (!isScheduleAutomation(definition)) return undefined;
    const next = definition.enabled ? nextOccurrence(definition.schedule, now(), deps.timeZone()) : null;
    return { nextRunAt: next === null ? undefined : new Date(next).toISOString() };
  };

  /** An explicit model the fresh host catalog does not list, for a one-time schedule's task. */
  const modelRefusal = async (root: string, task: AutomationEditable['task']): Promise<string | undefined> => {
    if (!deps.discovery || !task.model) return undefined;
    const runner = task.runner ?? (await loadConfig(root)).defaultRunner;
    if (!(MODEL_DISCOVERY_RUNNERS as readonly string[]).includes(runner)) return undefined;
    const choices = await missingModelChoices(deps.discovery, runner as ModelDiscoveryRunner, task.model);
    if (!choices) return undefined;
    const available = choices.availableModels.map((row) => row.id).join('; ');
    const others = choices.otherRunners.join(', ') || 'none';
    return `Model "${task.model}" is not in the ${runner} catalog. Available models: ${available.slice(0, 1200)}. Other runners listing "${task.model}": ${others}.`;
  };

  /** `body.schedule` as a once whose instant has passed: the refusal, else `undefined`. */
  const pastDue = (schedule: AutomationEditable['schedule']): string | undefined => {
    if (schedule?.type !== 'once') return undefined;
    const instant = onceInstant(schedule);
    return instant !== null && instant <= now() ? ONCE_PAST_DUE : undefined;
  };

  /**
   * A write to a one-time schedule: under the project lease, after re-reading it and healing the
   * archive invariant. `allowArchived` admits delete, the one write an archived schedule takes.
   */
  const underOnceLease = async <T>(
    project: AutomationServiceProject,
    id: string,
    write: (current: AutomationDefinition) => Promise<T | ServiceFailure> | T | ServiceFailure,
    allowArchived = false,
  ): Promise<T | ServiceFailure> => {
    const store = project.automationStore;
    let lease = store.acquireLease();
    if (lease && !lease.isCurrent()) {
      lease.release();
      lease = undefined;
    }
    if (!lease) return fail(409, ONCE_LAUNCH_IN_PROGRESS);
    try {
      store.reload();
      const current = store.get(id);
      if (!current) return fail(404, 'not found');
      // Settle first: a crash-left reservation may already have a task (archive, refuse) or none
      // (Failed). Either way the write below acts on what settling left.
      if (isOnceSchedule(current)) await new ScheduleRunner(deps.scheduleHandle(project)).settleOnce(current);
      const fresh = store.get(id);
      if (!fresh) return fail(404, 'not found');
      if (fresh.archived && !allowArchived) return fail(409, ONCE_ARCHIVED);
      return await write(fresh);
    } finally {
      lease.release();
    }
  };

  const changed = (project: AutomationServiceProject, automation: AutomationDefinition) => {
    deps.emitChange(project, automation.id, automation.revision);
    deps.changed();
  };

  return {
    async list(project: AutomationServiceProject, query: AutomationListQuery) {
      const { root, automationStore, store } = project;
      const availability = await deps.githubAvailability(root);
      const archived = query.archived;
      const automations = automationStore.list()
        .filter((automation) => archived === 'include' || (archived === 'only' ? Boolean(automation.archived) : !automation.archived))
        .map((automation) => {
          const logs = automationStore.logs({ automationId: automation.id, limit: 100 });
          const state = automationStore.state(automation.id);
          const latestLog = logs[0];
          // Enabled only: a paused definition's stored instant is stale, not a next run.
          const nextRunAt = automation.enabled
            ? (automation.kind === 'schedule' ? state?.nextRunAt : state?.nextCheckAt)
            : undefined;
          const status = onceStatus(automation, state);
          return {
            ...automation,
            // Spread conditionally, never `state: maybeUndefined`: the latter types the key as
            // always-present while `JSON.stringify` drops it from the wire, so the contract would
            // have to describe a key consumers never receive.
            ...(state ? { state } : {}),
            ...(latestLog ? { latestLog } : {}),
            ...(nextRunAt ? { nextRunAt } : {}),
            ...(status ? { onceStatus: status } : {}),
            counts: {
              matches: logs.filter((row) => row.result === 'launched' || row.result === 'duplicate').length,
              launched: store.countAutomationRuns(automation.id),
              duplicates: logs.filter((row) => row.result === 'duplicate').length,
              errors: logs.filter((row) => row.result === 'error' || row.result === 'rate-limited' || row.result === 'failed').length,
            },
          };
        });
      // The scheduler describes the project, not this page: an `archived` filter must not hide
      // the active schedules from it.
      const active = automationStore.list().filter((automation) => automation.enabled);
      const nextDue = active
        .map((automation) => (automation.kind === 'schedule' ? automationStore.state(automation.id)?.nextRunAt : automationStore.state(automation.id)?.nextCheckAt))
        .filter(Boolean).sort()[0];
      return {
        ...availability,
        timeZone: deps.timeZone(),
        scheduler: {
          // `as const` on both arms: in an object literal a conditional of two string literals
          // widens to `string`, which would erase the two states this key can hold.
          state: active.length > 0 ? ('scheduled' as const) : ('idle' as const),
          ...(nextDue ? { nextDue } : {}),
        },
        automations,
      };
    },

    get(project: AutomationServiceProject, id: string) {
      const { automationStore } = project;
      const automation = automationStore.get(id);
      if (!automation) return fail(404, 'not found');
      const state = automationStore.state(automation.id);
      const latestLog = automationStore.logs({ automationId: automation.id, limit: 1 })[0];
      const status = onceStatus(automation, state);
      return {
        ok: true as const,
        body: {
          automation,
          ...(state ? { state } : {}),
          ...(latestLog ? { latestLog } : {}),
          ...(status ? { onceStatus: status } : {}),
        },
      };
    },

    async create(project: AutomationServiceProject, body: z.infer<typeof automationCreateSchema>) {
      const { root, automationStore } = project;
      const resolved = resolveAutomationKind(body);
      if ('error' in resolved) return resolved;
      const promptIssue = validateAutomationPrompt(body.task.prompt, resolved.kind);
      if (promptIssue) return fail(400, promptIssue);
      // A poll needs a GitHub remote to poll; a schedule needs nothing but this project.
      if (resolved.kind === 'github' && !await deps.hasGithubRemote(root)) return fail(400, 'No GitHub remote is configured');
      if (body.schedule?.type === 'once') {
        const refusal = pastDue(body.schedule) ?? await modelRefusal(root, body.task);
        if (refusal) return fail(400, refusal);
      }
      const { enable, ...input } = body;
      try {
        const automation = automationStore.create({ ...input, kind: resolved.kind, enabled: enable === true }, undefined, enable ? armAutomationFromNow : undefined);
        changed(project, automation);
        return { ok: true as const, automation };
      } catch (error) {
        return fail(400, error instanceof Error ? error.message : String(error));
      }
    },

    async update(project: AutomationServiceProject, id: string, body: z.infer<typeof automationUpdateSchema>) {
      const { automationStore } = project;
      const { expectedRevision, ...input } = body;
      const stored = automationStore.get(id);
      if (!stored) return fail(404, 'not found');
      const resolved = resolveAutomationKind(input, stored);
      if ('error' in resolved) return resolved;
      const promptIssue = validateAutomationPrompt(input.task.prompt, resolved.kind);
      if (promptIssue) return fail(400, promptIssue);
      const write = async (previousOnDisk?: AutomationDefinition) => {
        if (previousOnDisk && isOnceSchedule(previousOnDisk) || input.schedule?.type === 'once') {
          const previous = previousOnDisk ?? stored;
          const moved = !sameDueTime(previous.schedule, input.schedule);
          const enabling = (input.enabled ?? false) && !previous.enabled;
          if (moved || enabling) {
            const refusal = pastDue(input.schedule);
            if (refusal) return fail(400, refusal);
          }
          if (input.task.model !== previous.task.model || input.task.runner !== previous.task.runner) {
            const refusal = await modelRefusal(project.root, input.task);
            if (refusal) return fail(400, refusal);
          }
        }
        try {
          // The armed instant belongs to the schedule it was computed from, and to an enabled
          // definition: a new schedule, or a resume through PUT, re-arms from now — never a catch-up
          // of an occurrence that passed while it was paused. Pausing clears it in the same write, so
          // another cockpit never reads the still-enabled definition beside a due instant. Armed in
          // the request, as `enable` does, rather than left to the timer: the list refetched on the
          // change event must already see it. Compared with the definition on disk, not the one read above.
          // An edit of a one-time schedule also clears why it stopped (#1465): Failed and Missed become Paused.
          const automation = automationStore.update(id, expectedRevision, { ...input, kind: resolved.kind, enabled: input.enabled ?? false }, (next, previous) => {
            const once = isOnceSchedule(next) ? { onceOutcome: undefined } : undefined;
            if (previous && (!sameSchedule(previous.schedule, next.schedule) || previous.enabled !== next.enabled
              || (next.enabled && Boolean(previous.filters?.includeExisting) !== Boolean(next.filters?.includeExisting)))) return { ...armAutomationFromNow(next), ...once };
            // A continuation belongs to its query. Ordinary edits retain the successful cursor,
            // but a changed query must start a fresh bounded scan rather than reuse page offsets.
            if (isGithubAutomation(next) && previous && (JSON.stringify(previous.filters) !== JSON.stringify(next.filters)
              || JSON.stringify(previous.events) !== JSON.stringify(next.events))) return { historyScan: undefined };
            return once;
          });
          changed(project, automation);
          return { ok: true as const, automation };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return fail(message.includes('conflict') ? 409 : 400, message);
        }
      };
      if (isOnceSchedule(stored)) return underOnceLease(project, id, (current) => write(current));
      return write();
    },

    remove(project: AutomationServiceProject, id: string) {
      const store = project.automationStore;
      const current = store.get(id);
      if (!current) return fail(404, 'not found');
      const remove = (definition: AutomationDefinition) => {
        if (!store.delete(id)) return fail(404, 'not found');
        deps.emitChange(project, id, definition.revision, true);
        deps.changed();
        return { ok: true as const };
      };
      if (isOnceSchedule(current)) return underOnceLease(project, id, remove, true);
      return remove(current);
    },

    async enable(project: AutomationServiceProject, id: string) {
      const store = project.automationStore;
      // No client revision: the toggle applies to what is on disk now, not to this store's last read.
      store.reload();
      const current = store.get(id);
      if (!current) return fail(404, 'not found');
      try {
        if (isOnceSchedule(current)) {
          return await underOnceLease(project, id, (fresh) => {
            if (!isOnceSchedule(fresh)) return fail(409, 'the automation changed elsewhere; reload and try again');
            const instant = onceInstant(fresh.schedule);
            if (instant === null || instant <= now()) return fail(400, ONCE_PAST_DUE);
            const automation = store.update(fresh.id, fresh.revision, { ...editableAutomation(fresh), enabled: true }, (next) => ({ ...armAutomationFromNow(next), onceOutcome: undefined }));
            changed(project, automation);
            return { ok: true as const, automation };
          });
        }
        if (isScheduleAutomation(current)) {
          // A schedule has no backlog to baseline against: it arms its next occurrence from now.
          const automation = store.update(current.id, current.revision, { ...editableAutomation(current), enabled: true }, armAutomationFromNow);
          changed(project, automation);
          return { ok: true as const, automation };
        }
        if (!isGithubAutomation(current)) return fail(409, 'automation definition is incomplete');
        const automation = store.update(current.id, current.revision, { ...editableAutomation(current), enabled: true }, armAutomationFromNow);
        await store.appendLog({ automationId: automation.id, revision: automation.revision, result: 'baseline', reason: current.filters.includeExisting ? 'Enabled with existing matches within the lookback; prior receipts prevent duplicate launches.' : 'Enabled from a current-time baseline; existing records were not launched.' });
        changed(project, automation);
        return { ok: true as const, automation };
      } catch (error) {
        return toggleFailure(error);
      }
    },

    async pause(project: AutomationServiceProject, id: string) {
      const store = project.automationStore;
      store.reload();
      const current = store.get(id);
      if (!current) return fail(404, 'not found');
      const pause = (definition: AutomationDefinition) => {
        try {
          const automation = store.update(definition.id, definition.revision, { ...editableAutomation(definition), enabled: false }, armAutomationFromNow);
          changed(project, automation);
          return { ok: true as const, automation };
        } catch (error) {
          return toggleFailure(error);
        }
      };
      if (isOnceSchedule(current)) return underOnceLease(project, id, pause);
      return pause(current);
    },

    /** One-time schedules only: archive without a task. Cancelled always means no task was created. */
    async cancel(project: AutomationServiceProject, id: string) {
      const store = project.automationStore;
      store.reload();
      const current = store.get(id);
      if (!current) return fail(404, 'not found');
      if (!isOnceSchedule(current)) return fail(409, ONCE_ONLY_CANCEL);
      return underOnceLease(project, id, (fresh) => {
        const automation = store.archive(fresh.id, { at: new Date(now()).toISOString(), outcome: 'cancelled' });
        if (!automation) return fail(409, ONCE_ARCHIVED);
        changed(project, automation);
        return { ok: true as const, automation };
      });
    },

    /** Run now: a schedule fired once by hand, paused or not, outside the timer and under the same lease. */
    async runNow(project: AutomationServiceProject, id: string) {
      const store = project.automationStore;
      const automation = store.get(id);
      if (!automation) return fail(404, 'not found');
      if (!isScheduleAutomation(automation)) return fail(409, 'a GitHub automation runs on its events; use check with mode execute');
      if (automation.archived) return fail(409, ONCE_ARCHIVED);
      const outcome = await new ScheduleRunner(deps.scheduleHandle(project)).runNow(automation);
      // Gone, or no longer a schedule, once re-read under the lease: nothing was launched.
      if (outcome.result === 'skipped') return fail(404, 'not found');
      if (outcome.result === 'manual') {
        deps.emitChange(project, automation.id, store.get(automation.id)?.revision ?? automation.revision);
        return { ok: true as const, runId: outcome.runId };
      }
      if (outcome.result === 'lease-held') return fail(409, SCHEDULE_LEASE_HELD_REASON);
      if (store.get(automation.id)?.archived) return fail(409, ONCE_ARCHIVED);
      const reason = store.logs({ automationId: automation.id, limit: 1 })[0]?.reason;
      return fail(409, reason ?? 'the run could not be launched');
    },
  };
}

export type AutomationService = ReturnType<typeof createAutomationService>;

/** A one-time schedule's create answer beyond its definition (#1465): what every create surface reports. */
export function onceCreateAnswer(automation: AutomationDefinition): { dueAt: string; timeZone: string; resolvedInstant: string; note: string } | undefined {
  if (!isOnceSchedule(automation)) return undefined;
  const instant = onceInstant(automation.schedule);
  if (instant === null) return undefined;
  return { dueAt: automation.schedule.at, timeZone: automation.schedule.timeZone, resolvedInstant: new Date(instant).toISOString(), note: SCHEDULED_TASK_NOTE };
}

