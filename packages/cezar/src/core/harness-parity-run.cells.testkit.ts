import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { readMockRecords } from '../mock-records.testkit.ts';
import { hasPendingAsk, readPersistedRuns } from '../runs/run-store.testkit.ts';
import type { RunRecord } from '../runs/store.ts';
import { IDLE_TIMEOUT_MS } from '../workflows/run.ts';
import { exemptionFor, HARNESS_ADAPTERS, promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { driveObservedRun, openTimerWait, RUN_CRITERIA, runRows, TERMINAL, timerWakeOf } from './harness-parity-run-tier.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { driveRun, withOwnedInputRun, type RunObservation } from './workflow-parity-core.testkit.ts';

// #723: use the real RunManager on both event-handler construction paths.
async function continueDiagnosticRun(backend: RunnerId, prompt: string): Promise<RunObservation> {
  return driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
    async ({ store, manager, runId, idle }) => {
      await idle.advance(IDLE_TIMEOUT_MS);
      await waitFor(() => !manager.isActive(runId));
      expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
      await waitFor(() => TERMINAL.includes(store.getRun(runId)?.status ?? ''), 30_000);
    });
}

export const RUN_GROUPS = {
  diagnostics(r: HarnessRegistrar) {
    const { describeRunners, runners, it, scope, parityRow } = r;
    describeRunners('diagnostics', 'harness parity — recoverable skill diagnostics (hearsay-tools/cezarion#723, hearsay-tools/cezarion#1265)', () => {
      for (const backend of runners) {
        for (const continuation of [false, true]) {
          const id = continuation ? 'R45' : 'R44';
          parityRow<RunObservation>(backend, {
            id, name: `${id} ${continuation ? 'continued' : 'fresh'} skill warnings preserve successful completion`, scenario: 'skill-warning',
            assert: obs => {
              expect(['review', 'done']).toContain(obs.record?.status);
              expect(obs.record?.error).toBeFalsy();
              expect(obs.events.filter(e => e.type === 'error')).toEqual([]);
              for (const root of ['.claude', '.agents']) {
                expect(obs.events).toContainEqual(expect.objectContaining({ type: 'note',
                  message: `opencode: optional skill skipped: Failed to parse skill /home/agent/${root}/skills/pen-design/SKILL.md. Check that the skill file and any symlink target are readable; repair or reinstall the skill.`,
                }));
              }
              expect(obs.events).toContainEqual(expect.objectContaining({ type: 'note',
                message: 'opencode: optional skill skipped: /home/agent/.agents/skills/bad4/SKILL.md has invalid YAML frontmatter (unexpected end of the stream within a double quoted scalar at line 6, column 1: ^). Fix the frontmatter between the --- lines, for example by quoting values that contain a colon or a quote, or remove the skill.',
              }));
              expect(obs.events.filter(e => e.type === 'turn.completed').every(e => e.stopReason === 'end_turn')).toBe(true);
              expect(obs.events.some(e => e.type === 'turn.completed')).toBe(true);
            },
          }, () => continuation ? continueDiagnosticRun(backend, promptFor(backend, 'skill-warning'))
            : driveRun(backend, 'skill-warning', record => TERMINAL.includes(record?.status ?? '')));
        }
        it(`${backend} R46 continued provider failures stay fatal and actionable`, async () => {
          const obs = await continueDiagnosticRun(backend, promptFor(backend, 'provider-error'));
          expect(obs.record?.status).toBe('failed');
          expect(obs.record?.error?.trim()).toBeTruthy();
          expect(obs.events).toContainEqual(expect.objectContaining({ type: 'error' }));
        }, 45_000);
      }
      if (scope === 'once') {
        const fatalDetail: Record<string, string> = {
          'unscoped-provider-failure': 'restoring service',
          'scoped-skill-failure': '/skills/required/SKILL.md',
          'scoped-frontmatter-failure': '/skills/bad4/SKILL.md: Failed to parse YAML frontmatter',
        };
        for (const continuation of [false, true]) for (const [scenario, detail] of Object.entries(fatalDetail)) {
          it(`opencode ${continuation ? 'continued' : 'fresh'} ${scenario} remains fatal`, async () => {
            const prompt = `mock:${scenario}`;
            const obs = continuation ? await continueDiagnosticRun('opencode', prompt)
              : await driveRun('opencode', { prompt }, record => TERMINAL.includes(record?.status ?? ''));
            expect(obs.record?.status).toBe('failed');
            expect(obs.record?.error).toContain('provider');
            expect(obs.record?.error).toContain(detail);
          }, 45_000);
        }
      }
    }, true);
  },

  run(r: HarnessRegistrar) {
    const { describeRunners } = r;
    describeRunners('run', 'harness parity — run tier', () => runRows(r, RUN_CRITERIA.filter(row => row.id !== 'R17')));
  },

  // #121/#401: release native child frames only AFTER the manager has parked.
  // Waiting for the final wire-derived event prevents a green test that returned
  // before the late frames were read. OpenCode discards closed child scopes;
  // its passive usage barrier proves those frames crossed the SSE transport.
  child(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('child', 'harness parity — late child attention', () => {
      for (const backend of runners) {
        const exempt = exemptionFor('R15', backend);
        if (exempt) {
          it(`${backend} is exempt from R15 — ${exempt.reason}`, () => {
            expect(exempt.kind).toBe('scenario-unconstructible');
            expect(HARNESS_ADAPTERS[backend].scenarios['subagent-after-park']).toBeUndefined();
          });
          continue;
        }
        it(`${backend} R15 keeps its monitoring wake after post-park child items`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'cez-post-park-'));
          const release = join(dir, 'release');
          try {
            await driveRun(backend, { prompt: `${promptFor(backend, 'subagent-after-park')} parity-release=${release}` },
              record => record?.status === 'waiting', 30_000,
              async ({ store, runId }) => {
                expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting });
                const wake = timerWakeOf(store.getRun(runId));
                expect(wake).toBeDefined();
                const before = store.readEvents(runId).length;
                const changes: Array<{ status: string; monitoringWakeAt?: string | undefined }> = [];
                const recordChange = (record: NonNullable<RunObservation['record']>) => {
                  if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: timerWakeOf(record) });
                };
                store.on('run', recordChange);
                try {
                  writeFileSync(release, 'go');
                  await waitFor(() => store.readEvents(runId).slice(before).some(event =>
                    backend === 'opencode'
                      ? event.type === 'usage.updated' && (event.usage as { total?: number } | undefined)?.total === 424242
                      : JSON.stringify(event).includes('Post-park child update processed.')));
                  expect({ ...store.getRun(runId), monitoringWakeAt: timerWakeOf(store.getRun(runId)) }).toMatchObject({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                  for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                  const after = store.readEvents(runId).slice(before);
                  expect(after.some(event => event.type === 'turn.started')).toBe(false);
                  const childItems = (backend === 'opencode' ? store.readEvents(runId).slice(0, before) : after)
                    .filter(event => event.type.startsWith('item.') && event.item && (event.item as { parentItemId?: string }).parentItemId);
                  expect(childItems.length).toBeGreaterThan(0);
                  if (backend === 'opencode') expect(after.some(event => event.type.startsWith('item.'))).toBe(false);
                } finally { store.off('run', recordChange); }
              });
          } finally { rmSync(dir, { recursive: true, force: true }); }
        }, 60_000);
      }
    });
  },

  // #961: native hook frames reach the event log and nothing else. A hook that
  // completes after the run parked (Squeal's async `waiter`) must neither wake the
  // run, move its wake time, nor open a turn; the mid-turn hook must not end one.
  hooks(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('hooks', 'harness parity — hooks never move run state', () => {
      for (const backend of runners) {
        const exempt = exemptionFor('R77', backend);
        if (exempt) {
          it(`${backend} is exempt from R77 — ${exempt.reason}`, () => {
            expect(exempt.kind).toBe('scenario-unconstructible');
            expect(HARNESS_ADAPTERS[backend].scenarios['hook-after-park']).toBeUndefined();
          });
          continue;
        }
        it(`${backend} R77 keeps a parked run parked through mid-turn and late hook items`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'cez-hook-park-'));
          const release = join(dir, 'release');
          try {
            await driveRun(backend, { prompt: `${promptFor(backend, 'hook-after-park')} parity-release=${release}` },
              record => record?.status === 'waiting', 30_000,
              async ({ store, runId }) => {
                expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting });
                const wake = timerWakeOf(store.getRun(runId));
                expect(wake).toBeDefined();
                const before = store.readEvents(runId).length;
                const changes: Array<{ status: string; monitoringWakeAt?: string | undefined }> = [];
                const recordChange = (record: NonNullable<RunObservation['record']>) => {
                  if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: timerWakeOf(record) });
                };
                store.on('run', recordChange);
                try {
                  writeFileSync(release, 'go');
                  await waitFor(() => store.readEvents(runId).slice(before).some(event => JSON.stringify(event).includes('Late hook processed.')));
                  expect({ ...store.getRun(runId), monitoringWakeAt: timerWakeOf(store.getRun(runId)) }).toMatchObject({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                  for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                  expect(store.readEvents(runId).slice(before).some(event => event.type === 'turn.started')).toBe(false);
                  const hooks = store.readEvents(runId)
                    .filter(event => event.type === 'item.completed' && (event.item as { kind?: string } | undefined)?.kind === 'hook')
                    .map(event => (event.item as { id: string }).id);
                  expect(hooks).toHaveLength(2);
                  expect(new Set(hooks).size).toBe(2);
                } finally { store.off('run', recordChange); }
              });
          } finally { rmSync(dir, { recursive: true, force: true }); }
        }, 60_000);
      }
    });
  },

  // #398: a native answer's turn boundary must not ask the human to prompt again.
  // R6 deliberately tests markerless owned-input draining; it cannot prove completion.
  answer(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('answer', 'harness parity — answer to completion run tier', () => {
      for (const backend of runners) {
        const exempt = exemptionFor('R26', backend);
        if (exempt) {
          it(`${backend} is exempt from R26 — ${exempt.reason}`, () => {
            expect(exempt.kind).toBe('scenario-unconstructible');
            expect(HARNESS_ADAPTERS[backend].askResumeCases).toEqual([]);
            expect(HARNESS_ADAPTERS[backend].scenarios['ask-resume']).toBeUndefined();
          });
          continue;
        }
        for (const ask of HARNESS_ADAPTERS[backend].askResumeCases) {
          it(`${backend} R26 completes after ${ask.kind} without another needs-you park`, async () => {
            await withOwnedInputRun(backend, ask.scenario, async ({ store, manager, runId, answer }) => {
              manager.enqueueOwnedRun(runId);
              await waitFor(() => store.getRun(runId)?.status === 'waiting');
              expect(hasPendingAsk(store, runId)).toBe(true);
              // Check the real ask card too: relabelling the question fixture as a
              // plan fixture must not silently remove create_plan coverage.
              const expectedHeader = ask.kind === 'cursor/create_plan' ? 'Plan'
                : ask.kind === 'cursor/ask_question' ? 'Tests' : 'Library';
              expect(store.readEvents(runId).find(event => event.type === 'ask.requested')?.questions)
                .toMatchObject([{ header: expectedHeader }]);
              const statuses: string[] = [];
              const recordStatus = (run: { id: string; status: string }) => {
                if (run.id === runId) statuses.push(run.status);
              };
              store.on('run', recordStatus);
              try {
                // The parent answers (hearsay-tools/cezarion#2410): the parked worker takes it as a wake.
                await answer(ask.answer);
                await waitFor(() => store.getRun(runId)?.status !== 'waiting');
                statuses.length = 0;
                await waitFor(() => !manager.isActive(runId) || statuses.includes('waiting'));
                expect(statuses).not.toContain('waiting');
                expect(store.getRun(runId)?.status).toBe('done');
                expect(store.getRun(runId)?.steps[0]?.status).toBe('done');
                expect(hasPendingAsk(store, runId)).toBe(false);
              } finally {
                store.off('run', recordStatus);
              }
              const events = store.readEvents(runId);
              expect(events.filter(event => event.type === 'ask.requested')).toHaveLength(1);
              // The parent's answer is its conversation reply, never a human message.
              expect(events.filter(event => event.type === 'user-message')).toEqual([]);
              expect(events.filter(event => event.type === 'human-input-delivered')).toEqual([expect.objectContaining({ source: 'parent' })]);
            });
          }, 45_000);
        }
      }
    });
  },

  // #399 incident: issue Agent context, run 3a3c1ffa (original history unavailable).
  // Prompt delivery is the contract under test; these offline wires cannot prove
  // that a live model follows the instruction. Markerless output must still wait.
  // hearsay-tools/cezarion#1234: every runner honors cezarTools, so every session here is taught
  // the lifecycle tools instead of the markers.
  monitoring(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('monitoring', 'harness parity — monitoring wrap-up contract (#399)', () => {
      const promptRules = [
        'When the goal is fully achieved and verified and you have no question for the user, call cezar_done, then end your turn.',
        'call cezar_wait with kind "pr" for a pull request\'s checks or its merge, or kind "timer" to re-check later, then end your turn.',
      ];
      type Wire = {
        userText?: string; method?: string; url?: string; prompt?: string;
        params?: { input?: { text?: string }[]; prompt?: { text?: string }[] };
        body?: { parts?: { text?: string }[] };
      };
      const records = (path: string) => readMockRecords<Wire | string[]>(path);
      // Print carries its combined prompt on stdin; Claude/Pi/OMP keep the system prompt in argv.
      const stdinWire = (backend: RunnerId) => backend === 'claude' || backend === 'pi' || backend === 'omp';
      const stdinRowText = (row: Wire): string[] => row.userText === undefined ? [] : [row.userText];
      const cursorCombinedRowText = (backend: RunnerId, row: string[]): string[] =>
        backend === 'cursor' && row.at(-1)?.includes('\n\n---\n\n') ? [row.at(-1)!] : [];
      // The per-backend prompt carrier: Codex turn input, Cursor session prompts, OpenCode body parts.
      const providerRowParts = (backend: RunnerId, row: Wire) =>
        backend === 'codex' && row.method === 'turn/start' ? row.params?.input
          : backend === 'cursor' && row.method === 'session/prompt' ? row.params?.prompt
          : backend === 'opencode' && /\/(message|prompt_async)$/.test(row.url ?? '') ? row.body?.parts : undefined;
      const joinRowParts = (parts: { text?: string }[]): string => parts.map(part => part.text ?? '').join('\n');
      const messages = (backend: RunnerId, dir: string): string[] => {
        const channel = stdinWire(backend) ? 'stdin' : 'args';
        const wire = backend === 'cursor' ? [...records(join(dir, 'args')), ...records(join(dir, 'stdin'))]
          : records(join(dir, channel));
        return wire.flatMap(row => {
          if (Array.isArray(row)) return cursorCombinedRowText(backend, row);
          if (stdinWire(backend)) return stdinRowText(row);
          if (backend === 'cursor' && row.method === 'cursor-print/stdin' && row.prompt !== undefined) return [row.prompt];
          const parts = providerRowParts(backend, row);
          return parts ? [joinRowParts(parts)] : [];
        });
      };
      const systemPrompt = (backend: RunnerId, dir: string): string => {
        if (!stdinWire(backend)) return messages(backend, dir)[0] ?? '';
        const argv = records(join(dir, 'args')).find(Array.isArray) ?? [];
        const index = argv.indexOf('--append-system-prompt');
        expect(index).toBeGreaterThanOrEqual(0);
        return argv[index + 1] ?? '';
      };
      const assertRules = (text: string, rules: readonly string[]) => {
        for (const rule of rules) expect(text).toContain(rule);
        expect(text).not.toContain('CEZ:MONITORING');
      };
      const recording = async (body: (dir: string) => Promise<void>) => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-monitoring-prompt-'));
        vi.stubEnv('CEZ_MOCK_ARGS_FILE', join(dir, 'args'));
        vi.stubEnv('CEZ_MOCK_STDIN_FILE', join(dir, 'stdin'));
        try { await body(dir); }
        finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
      };
      const clearRecording = (dir: string) => {
        for (const channel of ['args', 'stdin']) writeFileSync(join(dir, channel), '');
      };

      for (const backend of runners) {
        for (const continued of [false, true]) {
          it(`${backend} ${continued ? 'R37 Continue' : 'R36 fresh'} receives the shared monitoring wrap-up contract`, async () => {
            await recording(async dir => {
              await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
                async ({ store, manager, runId, idle }) => {
                  if (continued) {
                    await idle.advance(IDLE_TIMEOUT_MS);
                    await waitFor(() => !manager.isActive(runId));
                    clearRecording(dir);
                    expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                    await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                  }
                  assertRules(systemPrompt(backend, dir), promptRules);
                  expect(systemPrompt(backend, dir)).toContain('When a user decision or missing input is needed, call cezar_ask');
                });
            });
          }, 60_000);
        }

        it(`${backend} R38 restart recovery receives the shared monitoring wrap-up contract`, async () => {
          await recording(async dir => {
            await withOwnedInputRun(backend, 'cezar-wait', async fixture => {
              fixture.manager.enqueueOwnedRun(fixture.runId);
              await waitFor(() => fixture.store.getRun(fixture.runId)?.status === 'waiting' && !!timerWakeOf(fixture.store.getRun(fixture.runId)));
              clearRecording(dir);
              const wakeClock = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
              const { manager } = await fixture.restart();
              // hearsay-tools/cezarion#1233: recovery re-arms the park's persisted monitoring timer
              // instead of resuming at once; its wake starts the recovered session.
              expect(wakeClock.pending).toBe(1);
              wakeClock.fire(0);
              await waitFor(() => manager.isActive(fixture.runId) && messages(backend, dir).length > 0);
              assertRules(systemPrompt(backend, dir), promptRules);
            });
          });
        }, 60_000);

        // A cezar_wait timer's wake reaches each native message channel as its result text with the
        // next-step instruction, never as a user message (hearsay-tools/cezarion#2397: the marker
        // monitoring park this cell drove is gone; MONITORING_WAKE_NUDGE now answers only Claude's
        // ScheduleWakeup and the live-workers timer).
        it(`${backend} R39 a timer wake delivers its result and next-step instruction on the native message channel`, async () => {
          await recording(async dir => {
            const wakeClock = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
            await driveRun(backend, 'cezar-wait', record => record?.status === 'waiting' && !!timerWakeOf(record), 30_000,
              async ({ store, runId }) => {
                const waitId = openTimerWait(store.getRun(runId))!.id;
                expect(wakeClock.pending).toBe(1);
                wakeClock.fire(0);
                await waitFor(() => messages(backend, dir).length > 1);
                const wake = messages(backend, dir)[1]!;
                expect(wake).toContain(`Timer ${waitId} fired: Re-check the downstream work.`);
                expect(wake).toContain('Continue toward the task goal; register another wait if you are still waiting.');
                expect(store.readEvents(runId).some(event => event.type === 'user-message')).toBe(false);
              });
          });
        }, 60_000);

        it(`${backend} R40 completion prose without a marker still parks waiting`, async () => {
          await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
            async ({ store, manager, runId }) => {
              const prose = 'The PR merged. No further monitoring is needed. Everything is complete.';
              expect(manager.sendMessage(runId, [{ type: 'text', text: `mock:agent-echo ${prose}` }])).toBe(true);
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(prose)));
              await waitFor(() => store.getRun(runId)?.status === 'waiting');
              expect(manager.isActive(runId)).toBe(true);
            });
        }, 60_000);
      }
    });
  },

  // hearsay-tools/cezarion#922: every task-owned declaration, through each native runner wire.
  prs(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('prs', 'harness parity — multi-pr collection', () => {
      for (const backend of runners) {
        for (const continuation of [false, true]) {
          it(`${backend} ${continuation ? 'PR2' : 'PR1'} multi-pr retains fresh and continued declarations`, async () => {
            let dataDir = '';
            const observed = await driveRun(backend, 'multi-pr-refs', record => record?.status === 'done', 60_000,
              async ({ store, manager, runId }) => {
                expect(store.getRun(runId)?.pullRequests?.map(pr => pr.number)).toEqual([812, 813, 814, 815, 816]);
                expect(store.getRun(runId)?.markerRefs?.pr).toBe(816);
                if (continuation) {
                  await waitFor(() => !manager.isActive(runId));
                  expect(manager.continueRun(runId, { text: 'mock:multi-pr-refs-continue' }).ok).toBe(true);
                  await waitFor(() => !manager.isActive(runId) && store.getRun(runId)?.status === 'done', 60_000);
                  expect(store.getRun(runId)?.markerRefs?.pr).toBe(817);
                }
                store.flush();
                expect(readPersistedRuns(dataDir).find(run => run.id === runId)?.pullRequests?.map((pr: NonNullable<RunRecord['pullRequests']>[number]) => pr.number))
                  .toEqual(continuation ? [812, 813, 814, 815, 816, 817] : [812, 813, 814, 815, 816]);
              }, { beforeStart: ({ repoRoot }) => { dataDir = join(repoRoot, '.ai/cezar'); } });
            expect(observed.record?.pullRequests?.some(pr => pr.number === 999)).toBe(false);
          }, 150_000);
        }
      }
    });
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the run part's cells for one runner: `harness-<runner>-run-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('run', RUN_GROUPS, scope, registration);
}
