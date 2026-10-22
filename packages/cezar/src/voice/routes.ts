import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Hono, type Context, type Next } from 'hono';
import {
  voiceDecideRequestSchema,
  voiceOutcomeRequestSchema,
  type VoiceDecideRequest,
} from '@open-mercato/cezar-contract/voice';
import { jsonZodValidator } from '../server/validators.ts';
import type { ProjectApiEnv } from '../server/server.ts';
import { appendVoiceLog, type RecentVoiceActions } from './decision-log.ts';
import { decideVoice, type VoiceScreen } from './decide.ts';
import { VoiceEngineError, type DecisionEngine } from './engine.ts';
import { readPendingHumanAsk } from './pending-ask.ts';

/** The one refusal both routes answer while voice mode is off (capability `voice`). */
export const VOICE_OFF = 'Voice mode is off: set CEZ_VOICE=1 and TYPESAFE_API_KEY, then restart cezar';

export interface VoiceRouteDeps {
  voiceEnabled(): boolean;
  /** Read per request, so the dry-run and key rules follow the live environment. */
  engine(): DecisionEngine;
  recent: RecentVoiceActions;
  uuid?: () => string;
}

/**
 * Voice mode routes (spec 2026-10-21-voice-mode, "Architecture"). One chained family, mounted in the
 * `v1` chain so they answer under `/api/v1/voice/*` and `/api/v1/p/:projectId/voice/*`. The gate runs
 * before validation, so an off server never validates, decides or writes.
 */
export function createVoiceRoutes(deps: VoiceRouteDeps) {
  const gate = async (c: Context, next: Next) => {
    if (!deps.voiceEnabled()) return c.json({ error: VOICE_OFF }, 409);
    await next();
  };

  return new Hono<ProjectApiEnv>()
    .use('/voice/*', gate)
    .post('/voice/decide', jsonZodValidator(voiceDecideRequestSchema), async (c) => {
      const project = c.get('project');
      const body = c.req.valid('json');
      // An id this project does not know is "no open task", not an error: the tab can outlive the run.
      // Its card id goes with it, so "no open task" wins over a stale card.
      const openRun = body.openRunId === undefined ? undefined : project.store.getRun(body.openRunId);
      const { openRunId: _unknown, askRequestId: _card, ...rest } = body;
      const request: VoiceDecideRequest = openRun ? body : rest;
      const screen: VoiceScreen = {
        project: basename(project.root),
        ...(openRun ? { openTask: { title: openRun.titleSummary ?? openRun.title, status: openRun.status } } : {}),
      };
      const ask = openRun ? readPendingHumanAsk(project.dataDir, openRun) : undefined;
      const decisionId = deps.uuid?.() ?? randomUUID();
      deps.recent.load(project.id, project.dataDir);
      const recent = deps.recent.last(project.id);
      const engine = deps.engine();
      try {
        const { decision, answers, latencyMs, state } = await decideVoice({
          request,
          ...(ask ? { ask } : {}),
          screen,
          recent,
          engine,
          decisionId,
          signal: c.req.raw.signal,
        });
        appendVoiceLog(project.dataDir, {
          type: 'decision',
          at: new Date().toISOString(),
          decisionId,
          sentence: request.text,
          ...(request.openRunId !== undefined ? { openRunId: request.openRunId } : {}),
          engine: engine.id,
          state,
          answers,
          decision,
          latencyMs,
        });
        deps.recent.record(project.id, decisionId, request.text, decision.action);
        return c.json(decision, 200);
      } catch (error) {
        // The caller's own abort and any bug go to Hono's error handler and write no line.
        if (!(error instanceof VoiceEngineError)) throw error;
        appendVoiceLog(project.dataDir, {
          type: 'decision-error',
          at: new Date().toISOString(),
          decisionId,
          sentence: request.text,
          code: error.code,
        });
        // Only the code leaves the server: never the engine's message, status or headers.
        return c.json({ error: `Voice decision unavailable (${error.code})` }, 503);
      }
    })
    .post('/voice/outcome', jsonZodValidator(voiceOutcomeRequestSchema), async (c) => {
      const project = c.get('project');
      const { decisionId, outcome } = c.req.valid('json');
      deps.recent.load(project.id, project.dataDir);
      appendVoiceLog(project.dataDir, { type: 'outcome', at: new Date().toISOString(), decisionId, outcome });
      deps.recent.settle(project.id, decisionId, outcome);
      return c.json({ ok: true as const }, 200);
    });
}
