import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { readMockRecords } from '../mock-records.testkit.ts';
import { allowedToolsForStep } from '../workflows/types.ts';
import { AGENT_RUN_SPEC_FIELDS, inputDeliveryOf, RUNNER_IDS, type AgentEvent, type AgentRunSpec, type AgentRunSpecField, type ContentBlock, type RunnerId, type ToolGrant } from './agent-runner.ts';
import { driveSeam, exemptionFor, PINNED_SESSION_ID, seedOpencodeMockSession, textEvents, waitFor, type ScenarioName, type SeamObservation } from './harness-parity-core.testkit.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, probeEnv, readRecording, type Cells, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration, type SeamCriterion } from './harness-parity-registrar.testkit.ts';
import { FOLLOW_ON_ROWS, INPUT_ROWS } from './harness-parity-rows.testkit.ts';
import { SEAM_CRITERIA, seamRows } from './harness-parity-seam-tier.testkit.ts';
import { autoEndObservationClock } from './observation-clock.testkit.ts';
import { AUTO_END_DELAY_MS } from './runner-runtime.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import { shellQuote } from './shell-env.ts';
import { explicitToolGrant } from './tool-grant.testkit.ts';
import { TOOL_GRANT_CASES, describeToolGrantParity } from './tool-grant-parity-cells.testkit.ts';

/** The session part: the seam tier against each runner's own mock, with no workflow engine. */

// Group 8 — #505: agent input reaches a running turn and its reading is reported.
interface InputObservation {
  readonly obs: SeamObservation;
  readonly consumed: readonly string[];
  readonly consumedBeforeTurnEnd: boolean;
  readonly unconsumed: readonly string[];
}
async function observeInput(backend: RunnerId, scenario: ScenarioName, id: string): Promise<InputObservation> {
  const consumed: string[] = [];
  let consumedBeforeTurnEnd = false;
  let seenTurnEnd = false;
  const obs = await driveSeam(backend, scenario, {
    sessionOptions: { onAgentInputConsumed: ids => { consumed.push(...ids); if (!seenTurnEnd) consumedBeforeTurnEnd = true; } },
    whileOpen: async (session, { v1 }) => {
      const firstTurnEnd = () => { seenTurnEnd ||= v1.some(e => e.type === 'turn-end'); return seenTurnEnd; };
      await waitFor(() => v1.some(e => (scenario === 'steer-tool' ? e.type === 'tool-call' : e.type === 'text')) || firstTurnEnd());
      let ack: false | Promise<void> = false;
      const text = `mock:agent-echo parity ${id}`;
      await waitFor(() => (ack = session.sendAgentMessage([{ type: 'text', text }], [id])) !== false || firstTurnEnd());
      if (ack) await ack;
      await waitFor(() => firstTurnEnd());
      // Late input is read by a follow-on turn or reported; OpenCode reports after a grace window.
      const reported = () => v1.some(e => (e.type === 'turn-end' && !!e.unconsumedInputIds?.length) || e.type === 'input-unconsumed');
      // bound: wait for the reserved input's consumption receipt.
      await waitFor(() => consumed.includes(id) || reported(), 10_000).catch(() => undefined);
    },
  });
  const unconsumed = obs.v1.flatMap(e => e.type === 'input-unconsumed' ? [...e.inputIds]
    : e.type === 'turn-end' ? [...(e.unconsumedInputIds ?? [])] : []);
  return { obs, consumed, consumedBeforeTurnEnd, unconsumed };
}
const INPUT_CELLS: Cells<typeof INPUT_ROWS, SeamCriterion<InputObservation>> = {
  I1: {
    assert: ({ obs, consumed, consumedBeforeTurnEnd }) => {
      expect(consumed).toEqual(['parity-I1']);
      expect(consumedBeforeTurnEnd).toBe(true);
      expect(obs.v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
    },
  },
  I2: {
    assert: ({ unconsumed, consumed }) => {
      expect(unconsumed).toEqual(['parity-I2']);
      expect(consumed).toEqual([]);
    },
  },
};
export const INPUT_CRITERIA: readonly SeamCriterion<InputObservation>[] = INPUT_ROWS.map(row => ({ ...row, ...INPUT_CELLS[row.id] }));
// hearsay-tools/cezarion#1235 (PR #1291 CI): OpenCode can answer steered input in a follow-on run
// that starts after the turn's idle. Input posted in that gap opened its own turn, the follow-on
// run's idle closed it, and the input's own run then surfaced nothing. Every wire answers input
// posted right after a turn that took a steer in a turn of its own.
interface FollowOnObservation {
  readonly obs: SeamObservation;
  readonly consumed: readonly string[];
  readonly observable: boolean;
}
const FOLLOW_ON_STEERED = 'parity-I6-steered';
const FOLLOW_ON_NEXT = 'parity-I6-next';
/** The echo of `id` reached the run, and a turn end followed it. */
const answeredInItsTurn = (v1: readonly AgentEvent[], id: string) => {
  const at = v1.findIndex(e => e.type === 'text' && e.text.includes(`parity ${id}`));
  return at >= 0 && v1.slice(at).some(e => e.type === 'turn-end');
};
async function observeFollowOn(backend: RunnerId): Promise<FollowOnObservation> {
  const consumed: string[] = [];
  const obs = await driveSeam(backend, 'steer-tool', {
    // The OpenCode mock answers steers in a follow-on run 300 ms after the idle; other mocks ignore it.
    spec: { env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_MOCK_OPENCODE_FOLLOW_ON_MS: '300' } },
    sessionOptions: { onAgentInputConsumed: ids => { consumed.push(...ids); } },
    whileOpen: async (session, { v1 }) => {
      const turnEnded = () => v1.some(e => e.type === 'turn-end');
      const submit = async (id: string) => {
        let ack: false | Promise<void> = false;
        await waitFor(() => (ack = session.sendAgentMessage([{ type: 'text', text: `mock:agent-echo parity ${id}` }], [id])) !== false);
        if (ack) await ack;
      };
      await waitFor(() => v1.some(e => e.type === 'tool-call') || turnEnded());
      await submit(FOLLOW_ON_STEERED);
      await waitFor(turnEnded);
      await submit(FOLLOW_ON_NEXT);
      // bound: the red case never answers; the assertion below reports what arrived instead.
      await waitFor(() => answeredInItsTurn(v1, FOLLOW_ON_NEXT), 10_000).catch(() => undefined);
    },
  });
  return { obs, consumed, observable: inputDeliveryOf(runnersUnderTest()(backend)).consumption === 'observable' };
}
export const FOLLOW_ON_CRITERION: SeamCriterion<FollowOnObservation> = {
  ...FOLLOW_ON_ROWS[0],
  assert: ({ obs, consumed, observable }) => {
    expect(obs.failure).toBeUndefined();
    expect(answeredInItsTurn(obs.v1, FOLLOW_ON_NEXT)).toBe(true);
    if (observable) expect([...consumed].sort()).toEqual([FOLLOW_ON_NEXT, FOLLOW_ON_STEERED]);
  },
};

// ---- AgentRunSpec support declarations (#284) ------------------------------
//
// Every runner declares, per `AgentRunSpec` field, whether it honors the field
// and how (`AgentRunner.specSupport`). These rows hold each declaration against
// the runner's real boundary — the same argv / JSON-RPC / HTTP recordings D1
// reads, plus the first user message where a mock records its stdin — so a
// runner cannot say it maps a field it drops, and cannot quietly start mapping
// one it declared dropped. Codex and OpenCode ignoring `toolGrant` stays
// pinned exactly as long as they declare it (the product decision the
// `AgentRunSpec.toolGrant` doc comment records).

/**
 * How one field is observed. `boundary` probes set the field and nothing else
 * between `without` and `with`, so any difference in the recording is that
 * field's own footprint. `process` fields shape the child rather than its
 * input, proven by the recording landing where only an honored `cwd` and `env`
 * could put it. `deadline` is cezar-side, proven by a held turn ending in the
 * runner's own timeout error.
 */
const SPEC_FIELD_PROBE_KINDS = ['boundary', 'process', 'deadline', 'timings'] as const;
type SpecFieldProbeKind = (typeof SPEC_FIELD_PROBE_KINDS)[number];

type SpecFieldProbe =
  | { readonly kind: Extract<SpecFieldProbeKind, 'boundary'>; readonly without: Partial<AgentRunSpec>; readonly with: Partial<AgentRunSpec> }
  | { readonly kind: Extract<SpecFieldProbeKind, 'process'> }
  | { readonly kind: Extract<SpecFieldProbeKind, 'deadline' | 'timings'> };

const PROBE_IMAGE: ContentBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'cGFyaXR5' },
};

/** One probe per field — the `Record` fails to compile when `AgentRunSpec` grows. */
export const SPEC_FIELD_PROBES: Readonly<Record<AgentRunSpecField, SpecFieldProbe>> = {
  squawkTools: { kind: 'boundary', without: {}, with: { squawkTools: { name: 'cezar_ci_probe', command: 'node', args: ['/installed/ci-wait/mcp.js'] } } },
  systemPrompt: { kind: 'boundary', without: {}, with: { systemPrompt: 'parity probe system prompt' } },
  // Markerless on purpose, so every mock still answers with its default turn.
  userPrompt: { kind: 'boundary', without: {}, with: { userPrompt: 'inspect the working tree, then report' } },
  images: { kind: 'boundary', without: {}, with: { images: [PROBE_IMAGE] } },
  cwd: { kind: SPEC_FIELD_PROBE_KINDS[1] },
  // `without` is the drive's unset grant; the tool-grant cells pin every kind, bashAllowlist included.
  toolGrant: { kind: 'boundary', without: {}, with: { toolGrant: explicitToolGrant(['Read', 'Grep']) } },
  restrictCrossSessionMessaging: { kind: 'boundary', without: {}, with: { restrictCrossSessionMessaging: true } },
  additionalDirectories: { kind: 'boundary', without: {}, with: { additionalDirectories: ['/tmp/parity-probe-extra'] } },
  env: { kind: SPEC_FIELD_PROBE_KINDS[1] },
  model: { kind: 'boundary', without: {}, with: { model: 'parity-probe/model-sentinel' } },
  effort: { kind: 'boundary', without: {}, with: { effort: 'xhigh' } },
  timeoutMs: { kind: 'deadline' },
  timings: { kind: 'timings' },
  // A session id is a resume handle on codex, so both sides resume; `resume`
  // alone is a no-op on every runner, which keeps `without` a clean base.
  sessionId: { kind: 'boundary', without: { resume: true }, with: { resume: true, sessionId: PINNED_SESSION_ID } },
  resume: {
    kind: 'boundary',
    without: { sessionId: PINNED_SESSION_ID },
    with: { sessionId: PINNED_SESSION_ID, resume: true },
  },
  // Both sides resume a missing id so OpenCode takes the 404 fallback; the
  // field is the opening prompt of that fresh session only.
  resumeFallbackSystemPrompt: {
    kind: 'boundary',
    without: { resume: true, sessionId: PINNED_SESSION_ID },
    with: { resume: true, sessionId: PINNED_SESSION_ID, resumeFallbackSystemPrompt: 'parity probe resume fallback system prompt' },
  },
};

const variantKey = (spec: Partial<AgentRunSpec>): string => JSON.stringify(spec);
const fieldVariants = (backend: RunnerId, field: AgentRunSpecField, probe: Extract<SpecFieldProbe, { kind: 'boundary' }>) =>
  backend === 'cursor' && field === 'sessionId'
    ? { kind: 'boundary' as const, without: {}, with: probe.with }
    : probe;

export const SESSION_GROUPS = {
  seam(r: HarnessRegistrar) {
    const { describeRunners } = r;
    describeRunners('seam', 'harness parity — seam tier', () => seamRows(r, SEAM_CRITERIA.filter(row => row.id !== 'S20')));
  },

  // hearsay-tools/cezarion#1810: the Tool-list kinds case table, one cell per case and runner.
  'tool-grants'(r: HarnessRegistrar) {
    const { describeRunners, scope, registration } = r;
    describeRunners('tool-grants', 'harness parity — tool grants', () => {
      (registration.toolGrants ?? describeToolGrantParity)(scope === 'once' ? 'once' : scope.runner);
    }, true);
  },

  input(r: HarnessRegistrar) {
    const { describeRunners, runners, it, parityRow } = r;
    describeRunners('input', 'harness parity — input delivery (#505)', () => {
      for (const backend of runners) {
        it(`${backend} I0 declares its input delivery`, () => {
          expect(['steer', 'boundary']).toContain(inputDeliveryOf(runnersUnderTest()(backend)).mode);
        });
        for (const criterion of INPUT_CRITERIA) {
          parityRow(backend, criterion, () => observeInput(backend, criterion.scenario, `parity-${criterion.id}`));
        }
        parityRow(backend, FOLLOW_ON_CRITERION, () => observeFollowOn(backend));
      }
    });
  },

  session(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('session', 'harness parity — seam tier, session control', () => {
      for (const backend of runners) {
        // #708: permission discovery at startup must not break any runner's fresh,
        // resumed or subsequent human turns. Codex's native wire enforces Baseline;
        // other adapters exercise their own unchanged permissions and delivery.
        for (const resume of [false, true]) {
          it(`${backend} S14 ${resume ? 'resumes' : 'starts'} and completes repeated human messages under provider policy`, async () => {
            const obs = await driveSeam(backend, 'baseline', {
              spec: { resume, ...(backend === 'codex' ? { sessionId: 'th_mock_1' } : {}), env: { MOCK_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only', 'workspace-write'] }), CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
              whileOpen: async (session, { v1 }) => {
                for (let count = 1; count <= 3; count++) {
                  await waitFor(() => v1.filter(e => e.type === 'turn-end').length >= count);
                  if (count < 3) expect(session.sendMessage([{ type: 'text', text: `mock:agent-echo human follow-up ${count}` }])).toBe(true);
                }
              },
            });
            expect(obs.v1.filter(e => e.type === 'turn-end')).toHaveLength(3);
            expect(obs.v1.filter(e => e.type === 'error')).toEqual([]);
            expect(obs.v1.filter(e => e.type === 'note' && e.message.includes('disallowed'))).toEqual([]);
            expect(textEvents(obs.v1).join('')).toContain('human follow-up 2');
          }, 30_000);
        }

        it(`${backend} S13 auto-end checks a late hold at execution and resumes after the next admitted turn`, async () => {
          let hold = false; let checks = 0;
          const autoEnd = autoEndObservationClock();
          try {
            await driveSeam(backend, 'hold', {
              sessionOptions: { autoEndAfterFirstTurn: true, shouldAutoEnd: () => { checks++; return !hold; } },
              whileOpen: async (session, { v1 }) => {
                await waitFor(() => v1.some(e => e.type === 'turn-end'));
                await waitFor(() => autoEnd.pending === 1);
                // The runner has already armed its timer. The new wait must still veto it.
                hold = true;
                await autoEnd.advance(AUTO_END_DELAY_MS);
                expect(checks).toBeGreaterThan(0); expect(session.open).toBe(true);
                hold = false;
                await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo admitted wake' }])).resolves.toBeUndefined();
                await waitFor(() => v1.filter(e => e.type === 'turn-end').length >= 2);
                await waitFor(() => autoEnd.pending === 1);
                await autoEnd.advance(AUTO_END_DELAY_MS);
                await session.result;
                expect(session.open).toBe(false); expect(checks).toBeGreaterThan(1);
              },
            });
          } finally { autoEnd.restore(); }
        }, 45_000);

        // A native ask is the runner's own: it refuses non-human input until a human answers. A
        // cezar_ask is the workflow's human wait, which the runner never sees, so the run tier holds
        // that input instead (R6); the exemption pins that the seam does not.
        const s11 = exemptionFor('S11', backend);
        it(s11 ? `${backend} is exempt from S11 — ${s11.reason}` : `${backend} S11 non-human input cannot answer a native ask`, async () => {
          const obs = await driveSeam(backend, 'ask', {
            whileOpen: async (session, { v1, v2 }) => {
              await waitFor(() => v2.some(e => e.type === 'ask.requested') || v1.some(e => e.type === 'turn-end'));
              const ends = v1.filter(e => e.type === 'turn-end').length;
              if (s11) {
                expect(s11.kind).toBe('capability-absent');
                expect(v2.some(e => e.type === 'ask.requested')).toBe(false);
                await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo agent steering' }])).resolves.toBeUndefined();
                await waitFor(() => textEvents(v1).some(text => text.includes('agent steering')));
                return;
              }
              expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo refused steering' }])).toBe(false);
              expect(session.sendMessage([{ type: 'text', text: 'Vitest' }])).toBe(true);
              await waitFor(() => v1.filter(e => e.type === 'turn-end').length > ends);
              // The human answer, not the refused steering, ended the asking turn.
              expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(ends + 1);
              await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo agent steering' }])).resolves.toBeUndefined();
              await waitFor(() => textEvents(v1).some(text => text.includes('agent steering')));
            },
          });
          // driveSeam returns after the session result, so the wire has drained: refused steering never reached it.
          if (!s11) expect(textEvents(obs.v1).join('\n')).not.toContain('refused steering');
        }, 45_000);

        // #505: a `steer` runner admits non-human input mid-turn; a `boundary` runner refuses
        // it until the turn ends. Either way the input is eventually read, and a closed session refuses.
        it(`${backend} S12 non-human input follows the runner's declared delivery mode`, async () => {
          const steer = inputDeliveryOf(runnersUnderTest()(backend)).mode === 'steer';
          await driveSeam(backend, 'hold', {
            whileOpen: async (session, { v1 }) => {
              let busy = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }]);
              if (steer) {
                // Startup may refuse (codex has no thread yet); the running turn then admits it.
                if (busy === false) await waitFor(() => (busy = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }])) !== false);
                expect(v1.some(e => e.type === 'turn-end')).toBe(false);
                await expect(busy).resolves.toBeUndefined();
              } else {
                expect(busy).toBe(false);
                await waitFor(() => v1.some(e => e.type === 'turn-end'));
                await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }])).resolves.toBeUndefined();
              }
              await waitFor(() => textEvents(v1).some(text => text.includes('retried steering')));
              session.end();
              expect(session.sendAgentMessage([{ type: 'text', text: 'closed' }])).toBe(false);
            },
          });
        }, 45_000);

        // Group 7 — mid-task follow-ups are the whole reason a session outlives a turn.
        it(
          `${backend} S5 accepts a follow-up message and completes a second turn`,
          async () => {
            const obs = await driveSeam(backend, 'baseline', {
              whileOpen: async (session, { v1 }) => {
                await waitFor(() => v1.some((e) => e.type === 'turn-end'));
                expect(session.open).toBe(true);
                expect(session.sendMessage([{ type: 'text', text: 'now the second turn' }])).toBe(true);
                await waitFor(() => v1.filter((e) => e.type === 'turn-end').length >= 2);
              },
            });
            expect(obs.v1.filter((e) => e.type === 'turn-end').length).toBeGreaterThanOrEqual(2);
          },
          45_000,
        );

        // Group 7 / #703 — a teardown Squawk asked for is never an agent failure.
        it(
          `${backend} S6 settles result on interrupt without reporting an agent error`,
          async () => {
            const obs = await driveSeam(backend, 'baseline', {
              whileOpen: async (session, { v1 }) => {
                await waitFor(() => v1.some((e) => e.type === 'text'));
                session.interrupt();
              },
            });
            expect(obs.v1.some((e) => e.type === 'error')).toBe(false);
            expect(obs.v2.some((e) => e.type === 'turn.completed' && e.stopReason === 'error')).toBe(
              false,
            );
          },
          45_000,
        );

        // Desktop privacy attribution: macOS execs this shim in place; other platforms bypass it.
        it(`${backend} S35 keeps the native session working through the desktop launch trampoline`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'cez-desktop-parity-'));
          const trampoline = join(dir, 'desktop');
          const marker = join(dir, 'called');
          writeFileSync(trampoline, `#!/bin/sh\n[ "$1" = "--cez-disclaim-exec" ] || exit 91\nshift\nprintf called > ${shellQuote(marker)}\nexec "$@"\n`);
          chmodSync(trampoline, 0o755);
          vi.stubEnv('CEZ_DISCLAIM_EXEC', trampoline);
          try {
            const obs = await driveSeam(backend, 'baseline');
            expect(obs.failure).toBeUndefined();
            expect(obs.v1.some((e) => e.type === 'turn-end')).toBe(true);
            expect(existsSync(marker)).toBe(process.platform === 'darwin');
          } finally {
            vi.unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
          }
        }, 45_000);
      }
    });
  },

  // D1 (hearsay-tools/cezarion#2279): inspect the real argv/RPC/HTTP boundary of a governed
  // launch against an ordinary one. Native subagents and messages to them stay; a control is
  // added only where a runner's cross-session tool is separate from subagent messaging (Codex's
  // message board, OpenCode's task_id). Every other runner is a named `capability-absent`
  // exemption, pinned the other way round: its governed wire equals the ordinary one.
  governed(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('governed', 'harness parity — D1 governed cross-session controls', () => {
      for (const backend of runners) {
        const exempt = exemptionFor('D1', backend);
        for (const resume of [false, true]) {
          const when = resume ? 'Continue' : 'start';
          it(exempt ? `${backend} is exempt from D1 on ${when} — ${exempt.reason}` : `${backend} D1 keeps subagents and controls only cross-session reach on ${when}`, async () => {
            const dir = mkdtempSync(join(tmpdir(), 'cez-native-wire-'));
            try {
              const launches = [];
              for (const governed of [false, true]) {
                const path = join(dir, `${governed}.ndjson`);
                if (backend === 'opencode' && resume) seedOpencodeMockSession(path);
                const obs = await driveSeam(backend, 'baseline', { spec: {
                  cwd: dir, resume, toolGrant: explicitToolGrant(['Read', 'Bash'], ['git status']),
                  systemPrompt: 'Use native subagents for research; use Squawk workers for work that needs a worktree.',
                  ...(governed ? { restrictCrossSessionMessaging: true } : {}),
                  env: { CEZ_MOCK_ARGS_FILE: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
                } });
                expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
                expect(obs.v1.at(-1)?.type).toBe('done');
                // Argv arrays or JSON-RPC rows, by runner, as JSON.parse returned them before.
                launches.push(readMockRecords<any>(path));
              }
              const [ordinary, governed] = launches;
              if (exempt) {
                expect(exempt.kind).toBe('capability-absent');
                expect(governed).toEqual(ordinary);
              } else if (backend === 'codex') {
                const method = resume ? 'thread/resume' : 'thread/start';
                const normal = ordinary!.find(row => row.method === method);
                const controlled = governed!.find(row => row.method === method);
                expect(controlled.params.config).toEqual({ 'features.agent_message_board': false });
                const { config: _config, ...rest } = controlled.params;
                expect(rest).toEqual(normal.params);
                expect(normal.params).not.toHaveProperty('config');
              } else {
                // OpenCode: the task-scope plugin rides the runtime config; no session rule is sent.
                const config = governed!.find(row => row.type === 'runtime-config')?.config;
                expect(config?.plugin).toEqual([expect.stringMatching(/scripts\/opencode-task-scope\.mjs$/)]);
                expect(ordinary!.some(row => row.type === 'runtime-config')).toBe(false);
                const requests = (rows: any[]) => rows.filter(row => row.type !== 'runtime-config');
                expect(requests(governed!)).toEqual(requests(ordinary!));
                expect(governed!.filter(row => row.method === 'PATCH')).toEqual([]);
                expect(governed!.filter(row => row.method === 'POST' && row.url === '/session').every(row => row.body.permission === undefined)).toBe(true);
              }
            } finally { rmSync(dir, { recursive: true, force: true }); }
          }, 45000);
        }
      }
    });
  },

  // D3 (hearsay-tools/cezarion#1994): at shipped defaults (no D1) a session refuses the
  // runner's native cross-session messages, which bypass Squawk's recorded conversations.
  // Claude refuses inbound peer messages on every launch. Each other runner is a named
  // `capability-absent` exemption, pinned the other way round: its default wire carries no
  // cross-session control, so the day Squawk adds one, its exemption must go.
  'native-message'(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('native-message', 'harness parity — D3 native cross-session messaging at shipped defaults', () => {
      for (const backend of runners) {
        const exempt = exemptionFor('D3', backend);
        for (const resume of [false, true]) {
          it(exempt ? `${backend} is exempt from D3 on ${resume ? 'Continue' : 'start'} — ${exempt.reason}` : `${backend} D3 refuses native cross-session messages on ${resume ? 'Continue' : 'start'}`, async () => {
            const dir = mkdtempSync(join(tmpdir(), 'cez-cross-session-'));
            const path = join(dir, 'wire.ndjson');
            try {
              if (backend === 'opencode' && resume) seedOpencodeMockSession(path);
              const obs = await driveSeam(backend, 'baseline', { spec: {
                cwd: dir, resume,
                env: { CEZ_MOCK_ARGS_FILE: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
              } });
              expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
              expect(obs.v1.at(-1)?.type).toBe('done');
              const records = readMockRecords<unknown>(path);
              if (!exempt) {
                const args = records[0] as string[];
                const index = args.indexOf('--settings');
                expect(index).toBeGreaterThanOrEqual(0);
                expect(JSON.parse(args[index + 1]!)).toEqual({ crossSessionInbound: 'refuse' });
                expect(args).not.toContain('--disallowedTools');
                return;
              }
              expect(exempt.kind).toBe('capability-absent');
              expect(JSON.stringify(records)).not.toMatch(/crossSessionInbound|agent_message_board/);
            } finally { rmSync(dir, { recursive: true, force: true }); }
          }, 45_000);
        }
      }
    });
  },

  spec(r: HarnessRegistrar) {
    const { describeRunners, runners, it, describe, beforeAll, afterAll, scope } = r;
    describeRunners('spec', 'harness parity — AgentRunSpec support declarations', () => {
      if (scope === 'once') {
        it('every runner id builds its own runner, declaring every AgentRunSpec field with a reason', () => {
          for (const backend of RUNNER_IDS) {
            const runner = runnersUnderTest()(backend);
            // A new RUNNER_IDS member with no factory case falls through to claude; that is not a declaration.
            expect(runner.backend).toBe(backend);
            expect(Object.keys(runner.specSupport).sort()).toEqual([...AGENT_RUN_SPEC_FIELDS].sort());
            for (const field of AGENT_RUN_SPEC_FIELDS) {
              const support = runner.specSupport[field];
              expect(`${backend}/${field}: ${support.honored ? support.via : support.reason}`.trim()).not.toMatch(/: $/);
            }
          }
        });

        it('every AgentRunSpec field has a probe', () => {
          expect(Object.keys(SPEC_FIELD_PROBES).sort()).toEqual([...AGENT_RUN_SPEC_FIELDS].sort());
        });
      }

      for (const backend of runners) {
        describe(`${backend} declarations against its boundary`, () => {
          let dir = '';
          const recordings = new Map<string, string[]>();
          let deadlineErrors: string[] = [];
          let timingErrors: string[] = [];

          beforeAll(async () => {
            dir = mkdtempSync(join(tmpdir(), `cez-spec-support-${backend}-`));
            const variants = new Map<string, Partial<AgentRunSpec>>();
            for (const [field, entry] of Object.entries(SPEC_FIELD_PROBES) as [AgentRunSpecField, SpecFieldProbe][]) {
              const probe = entry.kind === 'boundary' ? fieldVariants(backend, field, entry) : entry;
              if (probe.kind !== 'boundary') continue;
              variants.set(variantKey(probe.without), probe.without);
              variants.set(variantKey(probe.with), probe.with);
            }
            let n = 0;
            for (const [key, spec] of variants) {
              const name = `probe-${n++}`;
              const obs = await driveSeam(backend, 'baseline', {
                spec: { cwd: dir, sessionId: undefined, env: probeEnv(name), ...spec },
              });
              expect(obs.v1.filter((e) => e.type === 'error')).toEqual([]);
              recordings.set(key, readRecording(dir, name));
            }
            // `hold` keeps content ≥250ms behind the prompt, so a 150ms deadline
            // fires first on every wire and the runner reports its own timeout.
            const held = await driveSeam(backend, 'hold', {
              spec: { cwd: dir, timeoutMs: 150, env: probeEnv('deadline') },
            });
            const timed = await driveSeam(backend, 'hold', {
              spec: { cwd: dir, timeoutMs: undefined, timings: { runTimeoutMs: 150 }, env: probeEnv('timings') },
            });
            timingErrors = timed.v1
              .filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
              .map((e) => e.message);
            deadlineErrors = held.v1
              .filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
              .map((e) => e.message);
          }, 120_000);

          afterAll(() => {
            rmSync(dir, { recursive: true, force: true });
          });

          for (const field of AGENT_RUN_SPEC_FIELDS) {
            it(`${backend} does with ${field} what it declares`, () => {
              const declared = runnersUnderTest()(backend).specSupport[field].honored;
              const probe = SPEC_FIELD_PROBES[field];
              let observed: boolean;
              if (probe.kind === 'boundary') {
                const variants = fieldVariants(backend, field, probe);
                const without = recordings.get(variantKey(variants.without));
                const withField = recordings.get(variantKey(variants.with));
                expect(without?.length ?? 0).toBeGreaterThan(0);
                observed = JSON.stringify(without) !== JSON.stringify(withField);
              } else if (probe.kind === 'process') {
                observed = (recordings.get(variantKey({}))?.length ?? 0) > 0;
              } else if (probe.kind === 'timings') {
                observed = timingErrors.some((message) => /timed out/.test(message));
              } else {
                observed = deadlineErrors.some((message) => /timed out/.test(message));
              }
              // Both directions: an honored field must leave a footprint, and a
              // declared-dropped field must leave none — that inversion is what
              // keeps codex/opencode `toolGrant` pinned as ignored (AC #3).
              expect({ backend, field, honored: observed }).toEqual({ backend, field, honored: declared });
            });
          }
        });
      }
    }, true);
  },

  // #781: the `squawkTools` cell, live. One shared Squawk tool list feeds every
  // runner's own wire (Claude's MCP config and generated allow-list entry, Codex
  // and Cursor forwarded env, OpenCode's runtime config, Pi's extension and tool
  // admission), and each mock lists the tools through the real bundled adapter.
  // `cezar_preview_serve` and `cezar_preview_stop` are listed under `CEZ_PREVIEW=1` exactly, and
  // `cezar_schedule_task` and `cezar_scheduled_tasks` unless `CEZ_AUTOMATIONS=0` (hearsay-tools/cezarion#1465).
  // Exercise the default and both explicit automation states on every native wire.
  tools(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('tools', 'harness parity — squawkTools list behind CEZ_PREVIEW', () => {
      const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'gen', turnId: 'turn', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
      // hearsay-tools/cezarion#1305: pi also runs the default list, which admits the tools through no allowlist.
      const lists = (backend: RunnerId) => [
        { label: '', toolGrant: explicitToolGrant(['Read']) },
        ...(backend === 'pi' ? [{ label: ' on the default tool list', toolGrant: { kind: 'step-default', tools: allowedToolsForStep(undefined, 'pi') } as ToolGrant }] : []),
      ];
      for (const backend of runners) for (const value of [undefined, '1', '0']) for (const { label, toolGrant } of lists(backend)) {
        it(`${backend} R35 lists tools with CEZ_AUTOMATIONS ${value ?? 'unset'}${label}`, async () => {
          vi.stubEnv('CEZ_PREVIEW', value === '1' ? '1' : '');
          vi.stubEnv('CEZ_AUTOMATIONS', value);
          const { CiToolController } = await import('../ci-wait/controller.ts');
          const controller = await CiToolController.start();
          const dir = mkdtempSync(join(tmpdir(), 'cez-tools-list-'));
          try {
            const session = controller.provision({ registerWait: async () => ({ answer: { ok: true, wait_id: wait.id, kind: WAIT_KIND.pr, deadline: wait.deadline, open_waits: [] }, wait: { ...wait, kind: WAIT_KIND.pr, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, phase: WAIT_PHASE.open } }), ask: async () => ({ ok: false, code: 'unavailable', message: 'none' }), cancelWait: async () => ({ cancelled: false, code: 'not_found', message: 'none' }), finishTurn: async () => ({ ok: true, finishes: 'at_turn_end', completes: 'task', open_waits: [] }) });
            const obs = await driveSeam(backend, 'baseline', { spec: { squawkTools: session.descriptor, toolGrant, env: { ...session.env, CEZ_MOCK_ARGS_FILE: join(dir, 'wire'), CEZ_MOCK_CI_PR: wait.prUrl, CEZ_MOCK_CI_RESULT: join(dir, 'result'), CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
            expect(obs.v1.filter((event) => event.type === 'error')).toEqual([]);
            const waits = ['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done'];
            const expected = [...waits, ...(value === '1' ? ['cezar_preview_serve', 'cezar_preview_stop'] : []), ...(value !== '0' ? ['cezar_schedule_task', 'cezar_scheduled_tasks'] : [])];
            expect(JSON.parse(readFileSync(join(dir, 'result'), 'utf8')).names).toEqual(expected);
            const argv: string[] = JSON.parse(readFileSync(join(dir, 'wire'), 'utf8').trim().split('\n')[0]!);
            if (backend === 'claude') {
              const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',');
              expect(allowed.filter((name) => name.startsWith(`mcp__${session.descriptor.name}__`))).toEqual(expected.map((name) => `mcp__${session.descriptor.name}__${name}`));
            }
            // hearsay-tools/cezarion#1305: pi's default list sends no allowlist, so the extension's tools stay active.
            if (backend === 'pi' && !argv.includes('--tools')) expect(argv).toContain('--no-builtin-tools');
            else if (backend === 'pi' || backend === 'omp') expect(argv[argv.indexOf('--tools') + 1]!.split(',').filter((name) => name.startsWith('cezar_'))).toEqual(expected);
          } finally {
            vi.unstubAllEnvs();
            await controller.close();
            rmSync(dir, { recursive: true, force: true });
          }
        }, 30_000);
      }
    });
  },

  // hearsay-tools/cezarion#784: the agent drives the task's preview browser through
  // `agent-browser --cdp "$CEZ_PREVIEW_CDP_URL"`, so the address must reach each runner's own native
  // process, which the agent's Bash inherits. The session comes from the real tool controller and
  // `previewCdpSession`, the gate RunManager uses. `mock-env-record.mjs`, preloaded through
  // NODE_OPTIONS, records each mock's own process env.
  cdp(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('cdp', 'harness parity — preview CDP address in the agent env', () => {
      for (const backend of runners) for (const enabled of [true, false]) {
        it(`${backend} R125 ${enabled ? 'carries' : 'omits'} CEZ_PREVIEW_CDP_URL with CEZ_PREVIEW ${enabled ? 'on' : 'off'}`, async () => {
          vi.stubEnv('CEZ_PREVIEW', enabled ? '1' : '');
          const { CiToolController } = await import('../ci-wait/controller.ts');
          const { PreviewHost } = await import('../preview/host.ts');
          const { previewCdpSession } = await import('../preview/agent-address.ts');
          const controller = await CiToolController.start();
          const host = new PreviewHost({ home: testHome(), launchBrowser: async () => { throw new Error('R125 starts no browser'); } });
          const dir = mkdtempSync(join(tmpdir(), 'cez-preview-cdp-env-'));
          try {
            const provisioned = controller.provision({ registerWait: async () => ({ answer: { ok: false, code: 'unavailable', message: 'none' } }), ask: async () => ({ ok: false, code: 'unavailable', message: 'none' }), cancelWait: async () => ({ cancelled: false, code: 'not_found', message: 'none' }), finishTurn: async () => ({ ok: true, finishes: 'at_turn_end', completes: 'task', open_waits: [] }) });
            const session = previewCdpSession(provisioned, { host, cockpitOrigin: 'http://127.0.0.1:4321', runId: 'run-r125', worktree: true, context: () => undefined });
            const record = join(dir, 'env.json');
            const recorder = pathToFileURL(fileURLToPath(new URL('../../scripts/mock-env-record.mjs', import.meta.url))).href;
            const preload = `${process.env.NODE_OPTIONS ?? ''} --import=${recorder}`.trim();
            const obs = await driveSeam(backend, 'baseline', { spec: { squawkTools: session.descriptor, env: { ...session.env, NODE_OPTIONS: preload, CEZ_MOCK_ENV_RECORD: record, CEZ_MOCK_ENV_RECORD_NAMES: 'CEZ_PREVIEW_CDP_URL', CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
            expect(obs.v1.filter((event) => event.type === 'error')).toEqual([]);
            const seen = JSON.parse(readFileSync(record, 'utf8')) as { CEZ_PREVIEW_CDP_URL: string | null };
            if (!enabled) {
              expect(seen.CEZ_PREVIEW_CDP_URL).toBeNull();
              return;
            }
            const url = new URL(seen.CEZ_PREVIEW_CDP_URL!);
            expect(`${url.protocol}//${url.host}`).toBe('ws://127.0.0.1:4321');
            const token = url.pathname.replace('/api/v1/preview/cdp/', '');
            expect(token).toMatch(/^[0-9a-f]{64}$/);
            expect(host.hasAgentGrant(token)).toBe(true);
            // The address ends with the session's tool capability.
            session.revoke();
            expect(host.hasAgentGrant(token)).toBe(false);
          } finally {
            vi.unstubAllEnvs();
            await controller.close();
            await host.close();
            rmSync(dir, { recursive: true, force: true });
          }
        }, 30_000);
      }
    });
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the session part's cells for one runner: `harness-<runner>-session-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('session', SESSION_GROUPS, scope, registration, TOOL_GRANT_CASES.length);
}
