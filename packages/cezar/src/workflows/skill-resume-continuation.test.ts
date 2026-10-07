/**
 * #790 review follow-ups: Continue must revalidate after skill materialize,
 * wait briefly for the team-skill cache, keep extra-only worker inheritance,
 * and rematerialize a team directory skill without a Continue note.
 */
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { workerWorkflowHash } from '../delegation/execution-identity.ts';
import { RunStore } from '../runs/store.ts';
import * as skills from '../skills.ts';
import type { Skill } from '../skills.ts';
import * as skillsRemote from '../skills-remote.ts';
import { seedTeamSkillsClone, writeSkillsReposConfig } from '../skills-remote.testkit.ts';
import { RunManager, skillSystemPrompt } from './run.ts';
import { plannedWorkflow, skillTaskSteps } from './types.ts';

// A launch creates a worktree and runs git; under full-suite load that outlasts
// vi.waitFor's 1 s default (seen failing in the #790 gate run).
const LAUNCH_WAIT_MS = 15_000;
const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const EXTRA_PROMPT = 'EXTRA-PROMPT-790';
const WORKER_SKILL = 'worker-skill';
const WORKER_SKILL_BODY = 'WORKER-SKILL-BODY-790';
const TEAM_SKILL = 'team-playbook';
const TEAM_SKILL_BODY = 'TEAM-PLAYBOOK-BODY-790';
const MISSING_SKILL_LIFECYCLE = `skill /${TEAM_SKILL} is not in the skill registry — its instructions were not re-sent to the continued session`;
const MATERIALIZED_NOTE = `team skill "${TEAM_SKILL}" materialized to`;

function teamDirSkill(): Skill {
  return {
    name: TEAM_SKILL,
    description: 'Team directory playbook',
    body: TEAM_SKILL_BODY,
    path: '/cache/team-skills/team-playbook/SKILL.md',
    source: 'team',
    team: { repo: 'org/skills', ref: 'main', path: 'team-playbook/SKILL.md', dir: true },
  };
}

describe('skill resume continuation follow-ups (#790 review)', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let launches: Array<{ spec: AgentRunSpec; inheritedSystemPrompt: string | undefined }>;
  let sessions: Array<{ spec: AgentRunSpec; finish: (text?: string) => void }>;
  let releases: Array<() => void>;
  let cleanup: string[];

  beforeEach(async () => {
    scopeFixtureProcesses();
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    vi.stubEnv('CEZ_DELEGATION', '1');
    launches = [];
    sessions = [];
    releases = [];
    cleanup = [];
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-skill-resume-cont-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, repoRoot);
    vi.spyOn(runners, 'createRunner').mockImplementation((backend) => ({
      backend: backend ?? 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT,
      systemPromptOnResume: 'resent',
      interrupt: async () => undefined,
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      startSession: (spec: AgentRunSpec, onEvent) => {
        const active = [...(manager as unknown as { active: Map<string, { delegationSettings?: { systemPrompt?: string } }> }).active.values()].at(-1);
        launches.push({ spec, inheritedSystemPrompt: active?.delegationSettings?.systemPrompt });
        let resolveResult!: (value: AgentRunResult) => void;
        let open = true;
        const result = new Promise<AgentRunResult>((resolve) => { resolveResult = resolve; });
        const finish = (text = 'ok') => {
          open = false;
          resolveResult({ text, toolCalls: [], tokensUsed: 0 });
        };
        const session: AgentSession = {
          result,
          get open() { return open; },
          sendMessage: () => open,
          sendAgentMessage: () => open ? Promise.resolve() : false,
          discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false,
          interrupt: () => finish(''),
          end: () => finish(''),
        };
        sessions.push({ spec, finish });
        queueMicrotask(() => onEvent?.({ type: 'session', sessionId: `sess-${launches.length}` }));
        return session;
      },
    }));
  });

  afterEach(async () => {
    for (const release of releases) release();
    for (const session of sessions) session.finish();
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  function terminalSkillRun(skillName: string, extra = EXTRA_PROMPT): string {
    const def = plannedWorkflow(skillTaskSteps(skillName));
    const record = store.createRun({
      title: 't',
      workflow: def.name,
      task: 'do the thing',
      runner: 'claude',
      systemPrompt: extra,
      steps: [{ id: 'task', name: skillName, kind: 'agent' }],
    });
    store.updateRun(record.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      workflowDef: def,
    });
    store.updateStep(record.id, 'task', {
      status: 'done',
      sessionId: 'sess-skill',
      backend: 'claude',
    });
    return record.id;
  }

  it('Stop during materializeSkillDir never launches the continued session', async () => {
    const skill = teamDirSkill();
    vi.spyOn(skills, 'discoverSkills').mockResolvedValue([skill]);
    let release!: (seeded: boolean) => void;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const materialize = vi.spyOn(skillsRemote, 'materializeSkillDir').mockReturnValue(held);
    const id = terminalSkillRun(TEAM_SKILL);

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1), { timeout: LAUNCH_WAIT_MS });
    expect(launches).toEqual([]);
    expect(manager.cancel(id)).toBe(true);
    release(true);
    await vi.waitFor(() => expect(!manager.isActive(id) || launches.length > 0).toBe(true), { timeout: LAUNCH_WAIT_MS });
    expect(launches).toEqual([]);
    expect(store.getRun(id)?.status).toBe('cancelled');
    expect(manager.isActive(id)).toBe(false);
  });

  it('bounds the team-skill wait when the continued skill is missing', async () => {
    vi.spyOn(skills, 'discoverSkills').mockResolvedValue([]);
    const wait = vi.spyOn(skillsRemote, 'waitForTeamSkills').mockReturnValue(new Promise(() => {}));
    const id = terminalSkillRun(TEAM_SKILL);
    const started = Date.now();

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(0), { timeout: 8_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(store.readEvents(id).filter((event) => event.type === 'lifecycle' && event.message === MISSING_SKILL_LIFECYCLE)).toHaveLength(1);
    expect(launches[0]!.spec.systemPrompt ?? '').not.toContain(TEAM_SKILL_BODY);
    expect(launches[0]!.spec.systemPrompt ?? '').not.toContain(`Selected skill: /${TEAM_SKILL}`);
    sessions[0]!.finish();
  });

  it('re-discovers a team skill that arrives during the bounded wait', async () => {
    const skill = teamDirSkill();
    const discover = vi.spyOn(skills, 'discoverSkills');
    discover.mockResolvedValueOnce([]);
    discover.mockResolvedValue([skill]);
    vi.spyOn(skillsRemote, 'waitForTeamSkills').mockResolvedValue([skill]);
    vi.spyOn(skillsRemote, 'materializeSkillDir').mockResolvedValue(true);
    const id = terminalSkillRun(TEAM_SKILL);

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(0), { timeout: LAUNCH_WAIT_MS });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(launches[0]!.spec.systemPrompt).toContain(skillSystemPrompt(skill));
    expect(store.readEvents(id).some((event) => event.type === 'lifecycle' && String(event.message).includes('is not in the skill registry'))).toBe(false);
    sessions[0]!.finish();
  });

  // #859: the real `loadTeamSkills` path with the passive fetch held open, as on the
  // first restart of the day — the bare clone on disk already holds the skill.
  async function heldFetchTeamSource(skillsInClone: Record<string, string> | undefined): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'cez-skill-resume-home-'));
    cleanup.push(home);
    vi.stubEnv('HOME', home);
    const repo = `org-${randomUUID().slice(0, 8)}/skills`;
    writeSkillsReposConfig(repoRoot, [repo]);
    if (skillsInClone) cleanup.push((await seedTeamSkillsClone(repo, skillsInClone)).sourceDir);
    skillsRemote.__holdFetchForTests(repo, new Promise<void>((resolve) => { releases.push(resolve); }));
  }

  it('recovers a team skill from the on-disk clone while the first fetch still runs (#859)', async () => {
    await heldFetchTeamSource({ [TEAM_SKILL]: TEAM_SKILL_BODY });
    const fullLoad = vi.spyOn(skillsRemote, 'waitForTeamSkills');
    const id = terminalSkillRun(TEAM_SKILL);
    const started = Date.now();

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(0), { timeout: LAUNCH_WAIT_MS });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(fullLoad).toHaveBeenCalledTimes(1);
    expect(launches[0]!.spec.systemPrompt).toContain(`Selected skill: /${TEAM_SKILL}`);
    expect(launches[0]!.spec.systemPrompt).toContain(TEAM_SKILL_BODY);
    expect(store.readEvents(id).some((event) => event.type === 'lifecycle' && String(event.message).includes('is not in the skill registry'))).toBe(false);
    sessions[0]!.finish();
  });

  it('warns once and starts within the bound when no source has the skill while the fetch hangs (#859)', async () => {
    await heldFetchTeamSource({ 'other-playbook': 'OTHER-BODY' });
    const id = terminalSkillRun(TEAM_SKILL);
    const started = Date.now();

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(0), { timeout: 8_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(store.readEvents(id).filter((event) => event.type === 'lifecycle' && event.message === MISSING_SKILL_LIFECYCLE)).toHaveLength(1);
    expect(launches[0]!.spec.systemPrompt ?? '').not.toContain(`Selected skill: /${TEAM_SKILL}`);
    sessions[0]!.finish();
  });

  it('warns once and starts within the bound when no clone exists and the fetch hangs (#859)', async () => {
    await heldFetchTeamSource(undefined);
    const id = terminalSkillRun(TEAM_SKILL);
    const started = Date.now();

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(0), { timeout: 8_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(store.readEvents(id).filter((event) => event.type === 'lifecycle' && event.message === MISSING_SKILL_LIFECYCLE)).toHaveLength(1);
    expect(launches[0]!.spec.systemPrompt ?? '').not.toContain(TEAM_SKILL_BODY);
    sessions[0]!.finish();
  });

  it('Continue of a team directory skill rematerializes without a note', async () => {
    const skill = teamDirSkill();
    vi.spyOn(skills, 'discoverSkills').mockResolvedValue([skill]);
    const materialize = vi.spyOn(skillsRemote, 'materializeSkillDir').mockResolvedValue(true);
    const id = terminalSkillRun(TEAM_SKILL);

    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(0), { timeout: LAUNCH_WAIT_MS });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(launches[0]!.spec.systemPrompt).toContain(skillSystemPrompt(skill));
    expect(store.readEvents(id).some((event) => event.type === 'note' && String(event.message).includes(MATERIALIZED_NOTE))).toBe(false);
    sessions[0]!.finish();
  });

  it('Continue of a --skill worker resends the skill and keeps extra-only delegationSettings', async () => {
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/skills', `${WORKER_SKILL}.md`), WORKER_SKILL_BODY);
    const workflowDef = plannedWorkflow(skillTaskSteps(WORKER_SKILL));
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const workerId = randomUUID();
    const sha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const workspace = await planOwnedWorkspace(repoRoot, workerId, sha);
    store.createOwnedRun({
      title: 'worker',
      task: 'do the thing',
      workflow: workflowDef.name,
      runner: 'claude',
      systemPrompt: EXTRA_PROMPT,
      workflowDef,
      steps: [{ id: 'task', name: WORKER_SKILL, kind: 'agent' }],
    }, parent.id, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parent.id, workspace,
    }, 'a'.repeat(64), { kind: 'internal', workflowHash: workerWorkflowHash(workflowDef) });

    manager.enqueueOwnedRun(workerId);
    await vi.waitFor(() => expect(launches.length).toBe(1), { timeout: LAUNCH_WAIT_MS });
    const expectedSkill = skillSystemPrompt({
      name: WORKER_SKILL,
      body: WORKER_SKILL_BODY,
      path: join(repoRoot, '.ai/cezar/skills', `${WORKER_SKILL}.md`),
      source: 'cezar',
    });
    expect(launches[0]!.spec.systemPrompt).toContain(expectedSkill);
    expect(launches[0]!.spec.systemPrompt).toContain(EXTRA_PROMPT);
    expect(launches[0]!.inheritedSystemPrompt).toBe(EXTRA_PROMPT);
    expect(launches[0]!.inheritedSystemPrompt).not.toContain(WORKER_SKILL_BODY);
    sessions[0]!.finish();
    expect(await manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    expect(['done', 'review']).toContain(store.getRun(workerId)?.status);

    expect(manager.continueRun(workerId, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBe(2), { timeout: LAUNCH_WAIT_MS });
    expect(launches[1]!.spec.systemPrompt).toContain(expectedSkill);
    expect(launches[1]!.spec.systemPrompt).toContain(EXTRA_PROMPT);
    expect(launches[1]!.inheritedSystemPrompt).toBe(EXTRA_PROMPT);
    expect(launches[1]!.inheritedSystemPrompt).not.toContain(`Selected skill: /${WORKER_SKILL}`);
    expect(launches[1]!.inheritedSystemPrompt).not.toContain(WORKER_SKILL_BODY);
    sessions[1]!.finish();
  });
});
