import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceDecision } from '@open-mercato/cezar-contract/voice';
import { RunStore } from '../runs/store.ts';
import { RecentVoiceActions } from '../voice/decision-log.ts';
import { VoiceEngineError, type DecisionEngine } from '../voice/engine.ts';
import { createVoiceRoutes, VOICE_OFF } from '../voice/routes.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ProjectApiEnv } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * Voice mode routes (spec 2026-10-21-voice-mode): gated on `CEZ_VOICE=1` plus a key (or dry run),
 * `409` before any validation or write when off; `200 VoiceDecision` or `503 (<code>)` otherwise.
 * The full-server cases run the dry-run fake, so nothing here reaches the network.
 */

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const readLog = (dataDir: string): Array<Record<string, unknown>> =>
  readFileSync(join(dataDir, 'voice', 'decisions.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('voice routes', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-voice-api-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    vi.stubEnv('CEZ_VOICE', '');
    vi.stubEnv('CEZ_DRY_RUN', '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('CEZ_REMOTE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  const dryRun = () => {
    vi.stubEnv('CEZ_VOICE', '1');
    vi.stubEnv('CEZ_DRY_RUN', '1');
  };
  const decide = (body: unknown, path = '/api/v1/voice/decide') => apiRequest(app(), path, post(body));

  /** A run whose history holds one unanswered question card. */
  const runWithCard = (): { runId: string; requestId: string } => {
    const runId = store.createRun({ title: 'card', workflow: 'quick-task', task: 'card', steps: [] }).id;
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const event = {
      seq: 1,
      ts: '2026-10-21T10:00:00.000Z',
      type: 'ask.requested',
      requestId: 'req-1',
      questions: [
        { header: 'First', question: 'Which runner?', options: [{ label: 'Vitest' }, { label: 'Jest' }] },
      ],
    };
    writeFileSync(join(dataDir, 'runs', `${runId}.ndjson`), `${JSON.stringify(event)}\n`);
    return { runId, requestId: 'req-1' };
  };

  describe('off (the default)', () => {
    it('answers 409 on both routes when voice is off', async () => {
      for (const path of ['/api/v1/voice/decide', '/api/v1/p/default/voice/decide']) {
        const res = await decide({ text: 'open next finished', sidebarView: 'active' }, path);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe(VOICE_OFF);
      }
      for (const path of ['/api/v1/voice/outcome', '/api/v1/p/default/voice/outcome']) {
        const res = await apiRequest(app(), path, post({ decisionId: crypto.randomUUID(), outcome: 'executed' }));
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain('CEZ_VOICE');
      }
      expect(existsSync(join(dataDir, 'voice'))).toBe(false);
    });

    it('refuses before it validates: an invalid body is still 409', async () => {
      const res = await decide({ nonsense: true });
      expect(res.status).toBe(409);
    });

    it('stays off with the flag but no key and no dry run', async () => {
      vi.stubEnv('CEZ_VOICE', '1');
      expect((await decide({ text: 'open next finished', sidebarView: 'active' })).status).toBe(409);
    });

    it('leaves its neighbours alone', async () => {
      expect((await apiRequest(app(), '/api/v1/health')).status).toBe(200);
      expect((await apiRequest(app(), '/api/v1/runs')).status).toBe(200);
    });
  });

  describe('on (dry run, no key)', () => {
    beforeEach(dryRun);

    it('decides under dry run without a key, under both spellings', async () => {
      const body = { text: 'open next finished', sidebarView: 'active' };
      const boot = await decide(body);
      expect(boot.status).toBe(200);
      const first = (await boot.json()) as VoiceDecision;
      expect(first).toMatchObject({ action: 'open', status: 'finished', position: 'next' });
      const scoped = await decide(body, '/api/v1/p/default/voice/decide');
      expect(scoped.status).toBe(200);
      expect(((await scoped.json()) as VoiceDecision).action).toBe('open');
      const lines = readLog(dataDir);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ type: 'decision', engine: 'fake', sentence: 'open next finished', decision: first });
    });

    it("answers from the open task's pending card", async () => {
      const { runId, requestId } = runWithCard();
      const res = await decide({ text: 'answer Vitest to question first', sidebarView: 'active', openRunId: runId });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        action: 'answer',
        runId,
        askRequestId: requestId,
        answers: [{ question: 0, kind: 'option', labels: ['Vitest'] }],
      });
      expect(readLog(dataDir)[0]).toMatchObject({ openRunId: runId });
    });

    it('treats an unknown run as no open task', async () => {
      const res = await decide({ text: 'tell it: hello there', sidebarView: 'active', openRunId: 'no-such-run' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ action: 'none', reason: 'no-open-task' });
      expect(readLog(dataDir)[0]).not.toHaveProperty('openRunId');
    });

    it('records a none decision too', async () => {
      const res = await decide({ text: 'lovely weather today', sidebarView: 'active' });
      expect(((await res.json()) as VoiceDecision).action).toBe('none');
      expect(readLog(dataDir)[0]).toMatchObject({ type: 'decision', decision: { action: 'none' } });
    });

    it('refuses bad bodies', async () => {
      const extra = await decide({ text: 'open next finished', sidebarView: 'active', extra: 1 });
      expect(extra.status).toBe(400);
      const long = await decide({ text: 'x'.repeat(501), sidebarView: 'active' });
      expect(long.status).toBe(400);
      const outcome = await apiRequest(app(), '/api/v1/voice/outcome', post({ decisionId: 'nope', outcome: 'executed' }));
      expect(outcome.status).toBe(400);
      expect(existsSync(join(dataDir, 'voice'))).toBe(false);
    });

    it('records outcomes, also for an unknown decision', async () => {
      const decisionId = crypto.randomUUID();
      const res = await apiRequest(app(), '/api/v1/voice/outcome', post({ decisionId, outcome: 'executed' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(readLog(dataDir).at(-1)).toMatchObject({ type: 'outcome', decisionId, outcome: 'executed' });
    });
  });

  describe('engine failures', () => {
    // The full server selects its engine from the environment; a stub needs the family alone, with
    // the project the scope resolver would have put on the context.
    const family = (engine: DecisionEngine, recent = new RecentVoiceActions()) => {
      const project = { id: 'p1', root: repoRoot, dataDir, store };
      return new Hono<ProjectApiEnv>()
        .use('*', async (c, next) => {
          c.set('project', project as never);
          await next();
        })
        .route('/', createVoiceRoutes({ voiceEnabled: () => true, engine: () => engine, recent, uuid: () => '00000000-0000-4000-8000-000000000001' }));
    };
    const body = { text: 'open next finished', sidebarView: 'active' };

    it('answers 503 when the engine fails, and logs a decision-error line', async () => {
      const engine: DecisionEngine = {
        id: 'jev',
        decide: () => Promise.reject(new VoiceEngineError('http', 529, 'secret-ish detail')),
      };
      const res = await apiRequest(family(engine) as unknown as Hono, '/voice/decide', post(body));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Voice decision unavailable (http)' });
      expect(readLog(dataDir)).toEqual([
        expect.objectContaining({
          type: 'decision-error',
          decisionId: '00000000-0000-4000-8000-000000000001',
          sentence: 'open next finished',
          code: 'http',
        }),
      ]);
      expect(JSON.stringify(readLog(dataDir))).not.toContain('secret-ish');
    });

    it('rethrows anything that is not an engine error and logs nothing', async () => {
      const engine: DecisionEngine = { id: 'jev', decide: () => Promise.reject(new Error('boom')) };
      const res = await apiRequest(family(engine) as unknown as Hono, '/voice/decide', post(body));
      expect(res.status).toBe(500);
      expect(existsSync(join(dataDir, 'voice'))).toBe(false);
    });

    it('hands the engine the decisions made before this one, newest last, with outcomes', async () => {
      const seen: string[][] = [];
      const engine: DecisionEngine = {
        id: 'fake',
        decide: async ({ state, questions }) => {
          seen.push(state.recent.map((r) => `${r.sentence}|${r.action}|${r.outcome ?? ''}`));
          return {
            answers: Object.fromEntries(
              Object.entries(questions).map(([id, q]) => [
                id,
                q.type === 'noul'
                  ? { type: 'noul' as const, noul: 0 }
                  : { type: 'choice' as const, choice: 'none', confidence: 1, probabilities: { none: 1 } },
              ]),
            ),
          };
        },
      };
      const recent = new RecentVoiceActions();
      const routes = family(engine, recent) as unknown as Hono;
      const first = await apiRequest(routes, '/voice/decide', post(body));
      const { decisionId } = (await first.json()) as VoiceDecision;
      await apiRequest(routes, '/voice/outcome', post({ decisionId, outcome: 'abandoned' }));
      await apiRequest(routes, '/voice/decide', post({ ...body, text: 'again' }));
      expect(seen).toEqual([[], ['open next finished|none|abandoned']]);
    });
  });
});
