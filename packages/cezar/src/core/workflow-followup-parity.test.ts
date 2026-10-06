/**
 * Mid-turn human follow-up parity — hearsay-tools/cezarion#486.
 *
 * A follow-up sent while a turn is running must survive that turn's CEZ:DONE
 * (H1), must be dropped when the same turn parks on CEZ:ASK (H2), and must not
 * park or nudge between a markerless hold-style turn and the follow-up (H3).
 * Each RUNNER_IDS backend is driven through its own HARNESS_ADAPTERS native mock.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveRun, exemptionFor, FOLLOWUP_CRITERIA, promptFor, waitFor } from './harness-parity.testkit.ts';

const KEEP = 'followup-486-keep';
const DROP = 'followup-486-drop';
const COALESCE_BIN = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/mock-codex-coalesce-steer.mjs');
const REVERSE_BIN = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/mock-codex-reverse-steer.mjs');

function mockLog(files: readonly string[]): string {
  return files.map(file => {
    try { return readFileSync(file, 'utf8'); } catch { return ''; }
  }).join('\n');
}

function rpcLines(files: readonly string[]): Record<string, unknown>[] {
  return mockLog(files).split('\n').flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try { return [JSON.parse(trimmed) as Record<string, unknown>]; } catch { return []; }
  });
}

function turnStartCarriesKeep(files: readonly string[]): boolean {
  return rpcLines(files).some(msg => msg.method === 'turn/start' && JSON.stringify(msg.params ?? {}).includes(KEEP));
}

function turnStartsCarryingKeep(files: readonly string[]): number {
  return rpcLines(files).filter(msg => msg.method === 'turn/start' && JSON.stringify(msg.params ?? {}).includes(KEEP)).length;
}

/** Reverse-order rows must not `release()` until `turn/steer` is on the mock wire.
 *  sendMessage only queues the RPC; releasing first lets hold-gated complete with
 *  no pending steer, after which the reverse wrapper held the late error forever. */
async function waitForHumanSteer(files: readonly string[]): Promise<void> {
  await waitFor(() => rpcLines(files).some(msg =>
    msg.method === 'turn/steer' && JSON.stringify(msg.params ?? {}).includes(KEEP)));
}

function followUpTurnStartedIndex(
  events: readonly { type: string }[],
): number {
  let seen = 0;
  return events.findIndex(e => {
    if (e.type !== 'turn.started') return false;
    seen += 1;
    return seen >= 2;
  });
}

function followUpConsumedBeforeClose(
  events: readonly { type: string; message?: unknown; text?: unknown }[],
): void {
  const closed = events.findIndex(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved — session closed'));
  const textKeep = events.findIndex(e => e.type === 'text' && String(e.text).includes(KEEP));
  const followUpStarted = followUpTurnStartedIndex(events);
  // A mock turn/start log is not consumption: KEEP must echo, or a follow-up
  // turn.started must land, before the DONE close.
  const keepBeforeClose = textKeep >= 0 && (closed < 0 || textKeep < closed);
  const startedBeforeClose = followUpStarted >= 0 && (closed < 0 || followUpStarted < closed);
  expect(keepBeforeClose || startedBeforeClose).toBe(true);
  if (closed >= 0) {
    expect(events.slice(closed + 1).some(e => e.type === 'turn.started')).toBe(false);
  }
}


function assertCloseAfterLastTurn(events: readonly { type: string; message?: unknown; text?: unknown }[]): void {
  const closed = events.findIndex(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved — session closed'));
  expect(closed).toBeGreaterThanOrEqual(0);
  // A follow-up turn must not start after the DONE close (Claude without the
  // fix closed at seq 15 then ran the follow-up at 16..24). A trailing v1
  // turn-end from process teardown is not a new turn.
  expect(events.slice(closed + 1).some(e => e.type === 'turn.started')).toBe(false);
  const followUpText = events.findIndex(e => e.type === 'text' && (
    String(e.text).includes(KEEP) || String(e.text).includes('parity done') || String(e.text).includes('parity hold-done')));
  expect(followUpText).toBeGreaterThanOrEqual(0);
  expect(followUpText).toBeLessThan(closed);
}

function withMockLogs<T>(body: (files: {
  argsFile: string; stdinFile: string; releaseFile: string; files: string[];
  release: () => void;
}) => Promise<T>): Promise<T> {
  const argsFile = join(tmpdir(), `cez-486-args-${randomUUID()}.ndjson`);
  const stdinFile = join(tmpdir(), `cez-486-stdin-${randomUUID()}.ndjson`);
  const releaseFile = join(tmpdir(), `cez-486-release-${randomUUID()}`);
  writeFileSync(argsFile, '');
  writeFileSync(stdinFile, '');
  return body({
    argsFile, stdinFile, releaseFile, files: [argsFile, stdinFile],
    release: () => writeFileSync(releaseFile, ''),
  }).finally(() => {
    rmSync(argsFile, { force: true });
    rmSync(stdinFile, { force: true });
    rmSync(releaseFile, { force: true });
  });
}

describe('mid-turn human follow-up parity — #486', () => {
  for (const backend of RUNNER_IDS) {
    for (const row of FOLLOWUP_CRITERIA) {
      const exemption = exemptionFor(row.id, backend);
      if (exemption) {
        it(`${backend} ${row.id} exemption — ${exemption.reason}`, async () => {
          await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
            await driveRun(backend, row.scenario, run =>
              run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''), 30_000,
              async ({ store, runId }) => {
                expect(mockLog(files)).toContain(DROP);
                if (row.id === 'H2') expect(store.getRun(runId)?.status).toBe('waiting');
              }, {
                env: { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile },
                during: async ({ manager, runId, store }) => {
                  await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
                  expect(manager.sendMessage(runId, [{ type: 'text', text: DROP }])).toBe(true);
                  release();
                },
              });
          });
        }, 30_000);
        continue;
      }
      const modes = row.id === 'H3' ? ['fresh', 'continuation'] as const : ['fresh'] as const;
      for (const mode of modes) it(`${backend} ${row.id} ${row.name}${modes.length > 1 ? ` (${mode})` : ''}`, async () => {
        await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
          const env = { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile };
          if (row.id === 'H1') {
            await driveRun(backend, 'hold-done', run =>
              ['done', 'review', 'failed'].includes(run?.status ?? ''), 30_000,
              async ({ store, runId }) => {
                const events = store.readEvents(runId);
                expect(mockLog(files)).toContain(KEEP);
                expect(['done', 'review']).toContain(store.getRun(runId)?.status);
                // Queueing wires (and Codex) must not start a follow-up turn after the DONE close.
                // Pi/OMP acks land before turn-end, so a late native turn.started can trail end().
                if (backend !== 'pi' && backend !== 'omp') assertCloseAfterLastTurn(events);
              }, {
                env,
                during: async ({ manager, runId, store }) => {
                  await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
                  expect(manager.sendMessage(runId, [{ type: 'text', text: `${KEEP} mock:done` }])).toBe(true);
                  release();
                },
              });
            return;
          }
          if (row.id === 'H3') {
            const noNudge = (events: readonly { type: string; message?: unknown }[]) => {
              expect(mockLog(files)).toContain(KEEP);
              expect(events.some(e => e.type === 'note' && String(e.message).includes('continuing without pausing'))).toBe(false);
            };
            const noParkBetween = (statuses: readonly string[]) => {
              const parked = statuses.filter(s => s === 'waiting');
              const last = statuses.at(-1);
              if (last === 'waiting') expect(parked).toEqual(['waiting']);
              else expect(parked).toEqual([]);
              expect(statuses).not.toContain('monitoring');
            };
            if (mode === 'continuation') {
              await driveRun(backend, 'hold-gated', run => run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''), 30_000,
                async ({ store, manager, runId }) => {
                  expect(store.getRun(runId)?.status).toBe('waiting');
                  manager.finish(runId);
                  await waitFor(() => !manager.isActive(runId));
                  rmSync(releaseFile, { force: true });
                  const startSeq = store.readEvents(runId).length;
                  const statuses: string[] = [];
                  const continued = manager.continueRun(runId, { text: promptFor(backend, 'hold-gated') });
                  expect(continued.ok).toBe(true);
                  await waitFor(() => store.readEvents(runId).slice(startSeq).some(e => e.type === 'turn.started'));
                  expect(manager.sendMessage(runId, [{ type: 'text', text: KEEP }])).toBe(true);
                  release();
                  await waitFor(() => {
                    const status = store.getRun(runId)?.status;
                    if (status && statuses.at(-1) !== status) statuses.push(status);
                    return status === 'waiting' || ['done', 'review', 'failed'].includes(status ?? '');
                  });
                  const status = store.getRun(runId)?.status;
                  if (status && statuses.at(-1) !== status) statuses.push(status);
                  noNudge(store.readEvents(runId).slice(startSeq));
                  noParkBetween(statuses);
                }, {
                  env,
                  during: async () => { release(); },
                });
              return;
            }
            const observed = await driveRun(backend, 'hold-gated', run =>
              run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''), 30_000,
              async ({ store, runId }) => { noNudge(store.readEvents(runId)); }, {
                env,
                during: async ({ manager, runId, store }) => {
                  await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
                  expect(manager.sendMessage(runId, [{ type: 'text', text: KEEP }])).toBe(true);
                  release();
                },
              });
            noParkBetween(observed.statuses);
            return;
          }
          await driveRun(backend, 'hold-ask', run =>
            run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''), 30_000,
            async ({ store, runId }) => {
              const events = store.readEvents(runId);
              expect(store.getRun(runId)?.status).toBe('waiting');
              expect(events.some(e => e.type === 'ask.requested')).toBe(true);
              expect(mockLog(files)).not.toContain(DROP);
              expect(events.some(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved — session closed'))).toBe(false);
            }, {
              env,
              during: async ({ manager, runId, store }) => {
                await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
                expect(manager.sendMessage(runId, [{ type: 'text', text: DROP }])).toBe(true);
                release();
              },
            });
        });
      }, 30_000);
    }
  }

  it('codex coalesced steer+completed settles instead of staying running (#486)', async () => {
    await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
      const observed = await driveRun('codex', 'hold-done', run =>
        ['done', 'review', 'failed', 'waiting'].includes(run?.status ?? ''), 20_000,
        async ({ store, runId }) => {
          expect(store.getRun(runId)?.status).not.toBe('running');
          expect(['done', 'review', 'waiting']).toContain(store.getRun(runId)?.status);
          const events = store.readEvents(runId);
          const textKeep = events.findIndex(e => e.type === 'text' && String(e.text).includes(KEEP));
          const closed = events.findIndex(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved — session closed'));
          // Coalesced order reads the follow-up in-turn: the echo must land before close,
          // not merely an inbound turn/steer KEEP in the args log.
          expect(textKeep).toBeGreaterThanOrEqual(0);
          if (closed >= 0) expect(textKeep).toBeLessThan(closed);
          followUpConsumedBeforeClose(events);
        }, {
          mockBin: COALESCE_BIN,
          env: { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile },
          during: async ({ manager, runId, store }) => {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
            expect(manager.sendMessage(runId, [{ type: 'text', text: `${KEEP} mock:done` }])).toBe(true);
            release();
          },
        });
      expect(observed.record?.status).not.toBe('running');
    });
  }, 30_000);

  it('codex reverse-order unread hold-done runs the follow-up as a turn before close (#486)', async () => {
    await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
      await driveRun('codex', 'hold-done', run =>
        ['done', 'review', 'failed', 'waiting'].includes(run?.status ?? ''), 20_000,
        async ({ store, runId }) => {
          expect(['done', 'review']).toContain(store.getRun(runId)?.status);
          expect(turnStartsCarryingKeep(files)).toBe(1);
          followUpConsumedBeforeClose(store.readEvents(runId));
        }, {
          mockBin: REVERSE_BIN,
          env: { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile },
          during: async ({ manager, runId, store }) => {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
            expect(manager.sendMessage(runId, [{ type: 'text', text: `${KEEP} mock:done` }])).toBe(true);
            await waitForHumanSteer(files);
            release();
          },
        });
    });
  }, 30_000);

  it('codex reverse-order read-in-turn does not restart the same human text (#486)', async () => {
    await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
      await driveRun('codex', 'hold-gated', run =>
        run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''), 20_000,
        async ({ store, runId }) => {
          expect(store.getRun(runId)?.status).toBe('waiting');
          expect(turnStartsCarryingKeep(files)).toBe(0);
          expect(mockLog(files)).toContain(KEEP);
        }, {
          mockBin: REVERSE_BIN,
          env: {
            CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile,
            CEZ_MOCK_REVERSE_ECHO: '1',
          },
          during: async ({ manager, runId, store }) => {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
            expect(manager.sendMessage(runId, [{ type: 'text', text: KEEP }])).toBe(true);
            await waitForHumanSteer(files);
            release();
            await waitFor(() => store.getRun(runId)?.status === 'waiting'
              || ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? ''));
            const until = Date.now() + 1_500;
            while (Date.now() < until) await new Promise(r => setTimeout(r, 20));
          },
        });
    });
  }, 30_000);

  it('codex reverse-order unread hold does not run a turn while waiting (#486)', async () => {
    await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
      let turnsWhileWaiting = 0;
      let waitingBeforeKeepTurn = false;
      const observed = await driveRun('codex', 'hold-gated', run =>
        run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''), 20_000,
        async ({ store, runId }) => {
          expect(turnStartsCarryingKeep(files)).toBe(1);
          expect(waitingBeforeKeepTurn).toBe(false);
          expect(turnsWhileWaiting).toBe(0);
          expect(store.getRun(runId)?.status).toBe('waiting');
        }, {
          mockBin: REVERSE_BIN,
          env: { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile },
          during: async ({ manager, runId, store }) => {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
            expect(manager.sendMessage(runId, [{ type: 'text', text: KEEP }])).toBe(true);
            await waitForHumanSteer(files);
            release();
            // Sample from send time: a park-then-restart can start the follow-up
            // turn before waitFor(waiting) resolves, which hid the H3 violation.
            let turnsAtFirstWaiting: number | undefined;
            const until = Date.now() + 6_000;
            while (Date.now() < until) {
              const status = store.getRun(runId)?.status ?? '';
              const turns = store.readEvents(runId).filter(e => e.type === 'turn.started').length;
              const keepStarted = turnStartsCarryingKeep(files);
              if (status === 'waiting') {
                if (!keepStarted) waitingBeforeKeepTurn = true;
                turnsAtFirstWaiting ??= turns;
                if (turns > turnsAtFirstWaiting) turnsWhileWaiting = turns - turnsAtFirstWaiting;
              }
              if ((status === 'waiting' && keepStarted) || ['done', 'review', 'failed'].includes(status)) {
                const rest = Date.now() + 400;
                while (Date.now() < rest) {
                  if (store.getRun(runId)?.status === 'waiting') {
                    const later = store.readEvents(runId).filter(e => e.type === 'turn.started').length;
                    if (turnsAtFirstWaiting !== undefined && later > turnsAtFirstWaiting) {
                      turnsWhileWaiting = later - turnsAtFirstWaiting;
                    }
                  }
                  await new Promise(r => setTimeout(r, 10));
                }
                break;
              }
              await new Promise(r => setTimeout(r, 10));
            }
          },
        });
      const parked = observed.statuses.filter(s => s === 'waiting');
      const last = observed.statuses.at(-1);
      if (last === 'waiting') expect(parked).toEqual(['waiting']);
      else expect(parked).toEqual([]);
    });
  }, 30_000);

  it('codex reverse-order delayed turn/started unread hold-done runs the follow-up as a turn before close (#486)', async () => {
    await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
      await driveRun('codex', 'hold-done', run =>
        ['done', 'review', 'failed', 'waiting'].includes(run?.status ?? ''), 20_000,
        async ({ store, runId }) => {
          expect(['done', 'review']).toContain(store.getRun(runId)?.status);
          expect(turnStartsCarryingKeep(files)).toBe(1);
          followUpConsumedBeforeClose(store.readEvents(runId));
        }, {
          mockBin: REVERSE_BIN,
          env: {
            CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile,
            CEZ_MOCK_DELAY_TURN_STARTED_MS: '800',
          },
          during: async ({ manager, runId, store }) => {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
            expect(manager.sendMessage(runId, [{ type: 'text', text: `${KEEP} mock:done` }])).toBe(true);
            await waitForHumanSteer(files);
            release();
          },
        });
    });
  }, 30_000);

  it('codex reverse-order delayed turn/started unread hold does not wait before the follow-up turn (#486)', async () => {
    await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
      let turnsWhileWaiting = 0;
      let waitingBeforeKeepTurn = false;
      const observed = await driveRun('codex', 'hold-gated', run =>
        run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''), 20_000,
        async ({ store, runId }) => {
          expect(turnStartsCarryingKeep(files)).toBe(1);
          expect(waitingBeforeKeepTurn).toBe(false);
          expect(turnsWhileWaiting).toBe(0);
          expect(store.getRun(runId)?.status).toBe('waiting');
        }, {
          mockBin: REVERSE_BIN,
          env: {
            CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile,
            CEZ_MOCK_DELAY_TURN_STARTED_MS: '800',
          },
          during: async ({ manager, runId, store }) => {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'turn.started'));
            expect(manager.sendMessage(runId, [{ type: 'text', text: KEEP }])).toBe(true);
            await waitForHumanSteer(files);
            release();
            let turnsAtFirstWaiting: number | undefined;
            const until = Date.now() + 8_000;
            while (Date.now() < until) {
              const status = store.getRun(runId)?.status ?? '';
              const events = store.readEvents(runId);
              const turns = events.filter(e => e.type === 'turn.started').length;
              const followUpStarted = followUpTurnStartedIndex(events) >= 0;
              if (status === 'waiting') {
                if (!followUpStarted) waitingBeforeKeepTurn = true;
                turnsAtFirstWaiting ??= turns;
                if (turns > turnsAtFirstWaiting) turnsWhileWaiting = turns - turnsAtFirstWaiting;
              }
              if (followUpStarted || ['done', 'review', 'failed'].includes(status)) {
                const rest = Date.now() + 400;
                while (Date.now() < rest) {
                  if (store.getRun(runId)?.status === 'waiting') {
                    const later = store.readEvents(runId).filter(e => e.type === 'turn.started').length;
                    if (turnsAtFirstWaiting !== undefined && later > turnsAtFirstWaiting) {
                      turnsWhileWaiting = later - turnsAtFirstWaiting;
                    }
                  }
                  await new Promise(r => setTimeout(r, 10));
                }
                break;
              }
              await new Promise(r => setTimeout(r, 10));
            }
          },
        });
      const parked = observed.statuses.filter(s => s === 'waiting');
      const last = observed.statuses.at(-1);
      if (last === 'waiting') expect(parked).toEqual(['waiting']);
      else expect(parked).toEqual([]);
    });
  }, 30_000);

  it('codex unread race restarts the follow-up as a turn before close (#486)', async () => {
    // mock:steer-race already answers completed then the steer error; do not wrap it
    // with the reverse bin (that wrapper would hold the error until a later completed).
    await withMockLogs(async ({ argsFile, stdinFile, releaseFile, files, release }) => {
      const observed = await driveRun('codex', { prompt: 'mock:steer-race' }, run =>
        ['done', 'review', 'failed', 'waiting'].includes(run?.status ?? ''), 20_000,
        async ({ store, runId }) => {
          expect(['done', 'review']).toContain(store.getRun(runId)?.status);
          expect(turnStartsCarryingKeep(files)).toBe(1);
          followUpConsumedBeforeClose(store.readEvents(runId));
        }, {
          env: { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_STDIN_FILE: stdinFile, CEZ_MOCK_RELEASE_FILE: releaseFile },
          during: async ({ manager, runId, store }) => {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'tool-call'));
            expect(manager.sendMessage(runId, [{ type: 'text', text: `${KEEP} mock:done` }])).toBe(true);
            release();
          },
        });
      expect(observed.statuses.filter(s => s === 'waiting')).toEqual([]);
    });
  }, 30_000);
});
