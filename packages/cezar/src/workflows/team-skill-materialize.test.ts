/**
 * #1024: a team directory skill must never be copied into the main checkout. A
 * run without its own task worktree gets a per-commit copy under the cache, and
 * the copy a worktree-off run used to leave in `<repoRoot>/.agents/skills` (which
 * `discoverSkills` reads as a LOCAL skill) no longer shadows the team skill.
 */
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { discoverSkills } from '../skills.ts';
import { bareDirFor, refreshTeamSkills } from '../skills-remote.ts';
import { seedTeamDirSkillClone, writeSkillsReposConfig } from '../skills-remote.testkit.ts';
import { RunManager } from './run.ts';
import { plannedWorkflow, skillTaskSteps, type WorkflowDef } from './types.ts';

const LAUNCH_WAIT_MS = 15_000;
const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const TEAM_SKILL = 'team-dir-playbook';
const V1_BODY = 'TEAM-DIR-PLAYBOOK-V1-1024';
const V2_BODY = 'TEAM-DIR-PLAYBOOK-V2-1024';
const NOTES = 'companion notes 1024\n';
const AGENT_SKILL_DIRS = ['.claude', '.agents', '.cursor'];

describe('team directory skills never land in the main checkout (#1024)', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager;
  let launches: AgentRunSpec[];
  let sessions: Array<() => void>;
  let cleanup: string[];

  beforeEach(async () => {
    scopeFixtureProcesses();
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    launches = [];
    sessions = [];
    cleanup = [];
    home = mkdtempSync(join(tmpdir(), 'cez-team-dir-home-'));
    cleanup.push(home);
    vi.stubEnv('HOME', home);
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-team-dir-root-'));
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
        launches.push(spec);
        let resolveResult!: (value: AgentRunResult) => void;
        let open = true;
        const result = new Promise<AgentRunResult>((resolve) => { resolveResult = resolve; });
        const finish = () => {
          open = false;
          resolveResult({ text: 'ok', toolCalls: [], tokensUsed: 0 });
        };
        const session: AgentSession = {
          result,
          get open() { return open; },
          sendMessage: () => open,
          sendAgentMessage: () => open ? Promise.resolve() : false,
          discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false,
          interrupt: finish,
          end: finish,
        };
        sessions.push(finish);
        queueMicrotask(() => onEvent?.({ type: 'session', sessionId: `sess-${launches.length}` }));
        return session;
      },
    }));
  });

  afterEach(async () => {
    for (const finish of sessions) finish();
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  // A trailing check keeps the agent step non-interactive, so the run ends after its turn.
  const workflow: WorkflowDef = plannedWorkflow([...skillTaskSteps(TEAM_SKILL), { id: 'verify', command: 'true' }]);

  async function runToEnd(worktree: boolean | undefined): Promise<{ id: string; spec: AgentRunSpec }> {
    const before = launches.length;
    const record = manager.startRun(workflow, { task: 'use the playbook', ...(worktree === undefined ? {} : { worktree }) });
    await vi.waitFor(() => expect(launches.length).toBe(before + 1), { timeout: LAUNCH_WAIT_MS });
    sessions[before]!();
    await vi.waitFor(() => {
      expect(manager.isActive(record.id)).toBe(false);
      expect(['done', 'review']).toContain(store.getRun(record.id)?.status);
    }, { timeout: LAUNCH_WAIT_MS });
    return { id: record.id, spec: launches[before]! };
  }

  async function seedTeamSource() {
    const repo = `org-${randomUUID().slice(0, 8)}/skills`;
    writeSkillsReposConfig(repoRoot, [repo]);
    const source = await seedTeamDirSkillClone(repo, TEAM_SKILL, {
      'SKILL.md': `---\ndescription: team dir playbook\n---\n${V1_BODY}\n`,
      'references/notes.md': NOTES,
    });
    cleanup.push(source.sourceDir);
    await refreshTeamSkills(repoRoot);
    return { repo, source };
  }

  it('a worktree-off run reads the skill files from the cache, not the main checkout (AC1)', async () => {
    const { repo, source } = await seedTeamSource();

    const offRun = await runToEnd(false);
    const filesDir = join(home, '.cache', 'cez', 'skill-files', basename(bareDirFor(repo)), source.commit, TEAM_SKILL);
    expect(offRun.spec.cwd).toBe(repoRoot);
    expect(offRun.spec.systemPrompt).toContain(V1_BODY);
    expect(offRun.spec.systemPrompt).toContain(`Skill files are installed on disk at: ${filesDir}`);
    expect(readFileSync(join(filesDir, 'references', 'notes.md'), 'utf8')).toBe(NOTES);
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(repoRoot, agentDir, 'skills', TEAM_SKILL)), `${agentDir}/skills/${TEAM_SKILL}`).toBe(false);
    }
    const exclude = existsSync(join(repoRoot, '.git/info/exclude')) ? readFileSync(join(repoRoot, '.git/info/exclude'), 'utf8') : '';
    expect(exclude).not.toContain(`skills/${TEAM_SKILL}/`);
    expect(store.readEvents(offRun.id).some((event) => event.type === 'note' &&
      event.message === `team skill "${TEAM_SKILL}" materialized to ${filesDir}`)).toBe(true);
  });

  it('after a worktree-off run, a worktree run gets the moved team repo, not a leftover copy (AC2)', async () => {
    const { source } = await seedTeamSource();
    await runToEnd(false);

    await source.update({ 'SKILL.md': `---\ndescription: team dir playbook\n---\n${V2_BODY}\n` });
    await refreshTeamSkills(repoRoot);
    expect((await discoverSkills(repoRoot)).find((skill) => skill.name === TEAM_SKILL)?.source).toBe('team');

    const worktreeRun = await runToEnd(undefined);
    expect(worktreeRun.spec.cwd).not.toBe(repoRoot);
    expect(worktreeRun.spec.systemPrompt).toContain(V2_BODY);
    expect(worktreeRun.spec.systemPrompt).not.toContain(V1_BODY);
    // A worktree run keeps its in-worktree copies and today's note.
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(readFileSync(join(worktreeRun.spec.cwd, agentDir, 'skills', TEAM_SKILL, 'SKILL.md'), 'utf8')).toContain(V2_BODY);
    }
    expect(store.readEvents(worktreeRun.id).some((event) => event.type === 'note' &&
      String(event.message).startsWith(`team skill "${TEAM_SKILL}" materialized to .claude/skills/${TEAM_SKILL}/`))).toBe(true);
  });

  it('a worktree whose agent dirs all link out of it gets the cache copy instead', async () => {
    const { repo, source } = await seedTeamSource();
    const outside = mkdtempSync(join(tmpdir(), 'cez-team-dir-outside-'));
    cleanup.push(outside);
    for (const agentDir of AGENT_SKILL_DIRS) {
      mkdirSync(join(outside, agentDir));
      symlinkSync(join(outside, agentDir), join(repoRoot, agentDir));
    }
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'linked agent dirs'], { cwd: repoRoot });

    const worktreeRun = await runToEnd(undefined);
    const filesDir = join(home, '.cache', 'cez', 'skill-files', basename(bareDirFor(repo)), source.commit, TEAM_SKILL);
    expect(worktreeRun.spec.cwd).not.toBe(repoRoot);
    expect(lstatSync(join(worktreeRun.spec.cwd, '.claude')).isSymbolicLink()).toBe(true);
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(outside, agentDir, 'skills')), `${agentDir} outside the worktree`).toBe(false);
    }
    expect(worktreeRun.spec.systemPrompt).toContain(`Skill files are installed on disk at: ${filesDir}`);
    expect(readFileSync(join(filesDir, 'references', 'notes.md'), 'utf8')).toBe(NOTES);
    expect(store.readEvents(worktreeRun.id).some((event) => event.type === 'note' &&
      event.message === `team skill "${TEAM_SKILL}" materialized to ${filesDir}`)).toBe(true);
  });

  /** The step-start notes of a run that name where a team skill was materialized. */
  function materializedNotes(runId: string): string[] {
    return store.readEvents(runId)
      .filter((event) => event.type === 'note' && String(event.message).startsWith(`team skill "${TEAM_SKILL}" materialized to`))
      .map((event) => String(event.message));
  }

  it('a worktree whose .claude links out of it names a copy that did land in the prompt', async () => {
    await seedTeamSource();
    const outside = mkdtempSync(join(tmpdir(), 'cez-team-dir-outside-'));
    cleanup.push(outside);
    symlinkSync(outside, join(repoRoot, '.claude'));
    for (const agentDir of ['.agents', '.cursor']) {
      mkdirSync(join(repoRoot, agentDir));
      writeFileSync(join(repoRoot, agentDir, '.keep'), '');
    }
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'linked .claude'], { cwd: repoRoot });

    const worktreeRun = await runToEnd(undefined);
    const filesDir = join(worktreeRun.spec.cwd, '.agents', 'skills', TEAM_SKILL);
    expect(worktreeRun.spec.cwd).not.toBe(repoRoot);
    expect(lstatSync(join(worktreeRun.spec.cwd, '.claude')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, 'skills')), '.claude outside the worktree').toBe(false);
    // Every runner reads the named copy, whichever agent dir it would scan itself.
    expect(worktreeRun.spec.systemPrompt).toContain(`Skill files are installed on disk at: ${filesDir}`);
    expect(readFileSync(join(filesDir, 'references', 'notes.md'), 'utf8')).toBe(NOTES);
    expect(materializedNotes(worktreeRun.id)).toEqual([
      `team skill "${TEAM_SKILL}" materialized to .agents/skills/${TEAM_SKILL}/ and .cursor/skills/${TEAM_SKILL}/`,
    ]);
  });

  it('a worktree that takes all three copies keeps the note and names no path', async () => {
    await seedTeamSource();

    const worktreeRun = await runToEnd(undefined);
    expect(worktreeRun.spec.cwd).not.toBe(repoRoot);
    expect(worktreeRun.spec.systemPrompt).toContain(V1_BODY);
    expect(worktreeRun.spec.systemPrompt).not.toContain('Skill files are installed on disk at:');
    expect(materializedNotes(worktreeRun.id)).toEqual([
      `team skill "${TEAM_SKILL}" materialized to .claude/skills/${TEAM_SKILL}/ ` +
        `.agents/skills/${TEAM_SKILL}/, and .cursor/skills/${TEAM_SKILL}/`,
    ]);
  });

  // hearsay-tools/cezarion#1408: the selected skill's companions, and a `/name` team directory skill.
  const promptWorkflow: WorkflowDef = plannedWorkflow([{ id: 'task', name: 'task', prompt: '{{task}}' }, { id: 'verify', command: 'true' }]);

  function writeLocalSkill(name: string, body: string): void {
    mkdirSync(join(repoRoot, '.ai/skills', name), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  }

  /** Start a run and hold its first session open, so its worktree is still there to inspect. */
  async function launch(def: WorkflowDef, task: string, worktree?: boolean): Promise<{ id: string; spec: AgentRunSpec; finish(): Promise<void> }> {
    const before = launches.length;
    const record = manager.startRun(def, { task, ...(worktree === undefined ? {} : { worktree }) });
    await vi.waitFor(() => expect(launches.length).toBe(before + 1), { timeout: LAUNCH_WAIT_MS });
    return {
      id: record.id,
      spec: launches[before]!,
      finish: async () => {
        sessions[before]!();
        await vi.waitFor(() => expect(manager.isActive(record.id)).toBe(false), { timeout: LAUNCH_WAIT_MS });
      },
    };
  }

  const notesOf = (runId: string): string[] => store.readEvents(runId)
    .filter((event) => event.type === 'note').map((event) => String(event.message));

  it("a selected skill's companion lands in the task worktree (#1408)", async () => {
    writeLocalSkill('lead-1408', 'then run helper-1408');
    writeLocalSkill('helper-1408', 'HELPER-1408');
    const run = await launch(plannedWorkflow([...skillTaskSteps('lead-1408'), { id: 'verify', command: 'true' }]), 'go');
    expect(run.spec.cwd).not.toBe(repoRoot);
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(readFileSync(join(run.spec.cwd, agentDir, 'skills', 'helper-1408', 'SKILL.md'), 'utf8')).toContain('HELPER-1408');
    }
    expect(notesOf(run.id)).toContain("skills installed in the task's workspace: lead-1408, helper-1408");
    await run.finish();
  });

  it('a /name opening prompt materializes a team directory skill in the worktree (#1118)', async () => {
    await seedTeamSource();
    const run = await launch(promptWorkflow, `/${TEAM_SKILL} please`);
    expect(run.spec.cwd).not.toBe(repoRoot);
    expect(readFileSync(join(run.spec.cwd, '.agents', 'skills', TEAM_SKILL, 'references', 'notes.md'), 'utf8')).toBe(NOTES);
    expect(run.spec.userPrompt).toContain(V1_BODY);
    expect(run.spec.userPrompt).not.toContain('Skill files are installed on disk at:');
    await run.finish();
  });

  it('a worktree-off /name opening prompt names the cache copy (#1118)', async () => {
    const { repo, source } = await seedTeamSource();
    const run = await launch(promptWorkflow, `/${TEAM_SKILL} please`, false);
    const filesDir = join(home, '.cache', 'cez', 'skill-files', basename(bareDirFor(repo)), source.commit, TEAM_SKILL);
    expect(run.spec.userPrompt).toContain(`Skill files are installed on disk at: ${filesDir}`);
    expect(readFileSync(join(filesDir, 'references', 'notes.md'), 'utf8')).toBe(NOTES);
    await run.finish();
  });

  it('the step note reports a capped closure (#1408)', async () => {
    for (let i = 0; i < 26; i++) writeLocalSkill(`chain-${i}`, i < 25 ? `next chain-${i + 1}` : 'end');
    const run = await launch(plannedWorkflow([...skillTaskSteps('chain-0'), { id: 'verify', command: 'true' }]), 'go');
    const note = notesOf(run.id).find((message) => message.startsWith("skills installed in the task's workspace:"));
    expect(note).toMatch(/; closure capped at 24, skipped chain-24 and later$/);
    expect(existsSync(join(run.spec.cwd, '.agents', 'skills', 'chain-24'))).toBe(false);
    await run.finish();
  });

  const lead1494 = () => plannedWorkflow([...skillTaskSteps('lead-1494'), { id: 'verify', command: 'true' }]);
  const switchOff = (repo: string) => {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/ui-state.json'), JSON.stringify({ disabledTeamSkills: [{ repo, name: TEAM_SKILL }] }));
  };

  it('a switched-off team skill is not installed as a companion (#1494)', async () => {
    const { repo } = await seedTeamSource();
    writeLocalSkill('lead-1494', `then run ${TEAM_SKILL}`);
    switchOff(repo);
    const run = await launch(lead1494(), 'go');
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(run.spec.cwd, agentDir, 'skills', TEAM_SKILL)), agentDir).toBe(false);
    }
    expect(notesOf(run.id)).toContain("skills installed in the task's workspace: lead-1494");
    await run.finish();
  });

  it('the same companion is installed while its team skill is switched on (#1494 guard)', async () => {
    await seedTeamSource();
    writeLocalSkill('lead-1494', `then run ${TEAM_SKILL}`);
    const run = await launch(lead1494(), 'go');
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(run.spec.cwd, agentDir, 'skills', TEAM_SKILL, 'SKILL.md')), agentDir).toBe(true);
    }
    await run.finish();
  });

  it('a companion switched off after the run started is not installed on Continue (#1494)', async () => {
    const { repo } = await seedTeamSource();
    writeLocalSkill('lead-1494', `then run ${TEAM_SKILL}`);
    const run = await launch(lead1494(), 'go');
    await run.finish();
    for (const agentDir of AGENT_SKILL_DIRS) rmSync(join(run.spec.cwd, agentDir, 'skills', TEAM_SKILL), { recursive: true, force: true });
    switchOff(repo);
    const before = launches.length;
    expect(manager.continueRun(run.id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(before), { timeout: LAUNCH_WAIT_MS });
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(run.spec.cwd, agentDir, 'skills', TEAM_SKILL)), agentDir).toBe(false);
    }
    sessions[before]!();
  });

  it('a companion switched off during a live run is not installed by a later live /name (#1494)', async () => {
    const { repo } = await seedTeamSource();
    writeLocalSkill('lead-1494', `then run ${TEAM_SKILL}`);
    // The run's saved registry holds the team skill: it was on when the run started.
    const run = await launch(promptWorkflow, 'go');
    switchOff(repo);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: '/lead-1494 now' }])).toBe(true);
    await (manager as unknown as { active: Map<string, { liveSkillProvisioning?: Promise<void> }> })
      .active.get(run.id)?.liveSkillProvisioning;
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(run.spec.cwd, agentDir, 'skills', 'lead-1494')), `${agentDir} lead`).toBe(true);
      expect(existsSync(join(run.spec.cwd, agentDir, 'skills', TEAM_SKILL)), `${agentDir} team`).toBe(false);
    }
    await run.finish();
  });

  it("Continue removes cezar's copies of a team skill switched off after it was installed, and nothing else (#1494)", async () => {
    const { repo } = await seedTeamSource();
    const run = await runToEnd(undefined);
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(run.spec.cwd, agentDir, 'skills', TEAM_SKILL, 'SKILL.md')), agentDir).toBe(true);
    }
    // The user's own install, beside cezar's copies.
    mkdirSync(join(run.spec.cwd, '.agents/skills/user-own-1494'), { recursive: true });
    writeFileSync(join(run.spec.cwd, '.agents/skills/user-own-1494/SKILL.md'), 'mine\n');
    switchOff(repo);
    const before = launches.length;
    expect(manager.continueRun(run.id, { text: 'keep going' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(launches.length).toBeGreaterThan(before), { timeout: LAUNCH_WAIT_MS });
    for (const agentDir of AGENT_SKILL_DIRS) {
      expect(existsSync(join(run.spec.cwd, agentDir, 'skills', TEAM_SKILL)), agentDir).toBe(false);
    }
    expect(readFileSync(join(run.spec.cwd, '.agents/skills/user-own-1494/SKILL.md'), 'utf8')).toBe('mine\n');
    sessions[before]!();
  });

  describe('guards', () => {
    it('an in-place run writes no skill entry in the checkout', async () => {
      writeLocalSkill('lead-1408', 'then run helper-1408');
      writeLocalSkill('helper-1408', 'HELPER-1408');
      const run = await launch(plannedWorkflow([...skillTaskSteps('lead-1408'), { id: 'verify', command: 'true' }]), 'go', false);
      expect(run.spec.cwd).toBe(repoRoot);
      for (const agentDir of AGENT_SKILL_DIRS) expect(existsSync(join(repoRoot, agentDir)), agentDir).toBe(false);
      await run.finish();
    });

    it('an unknown /command passes through unchanged', async () => {
      const run = await launch(promptWorkflow, '/compact now');
      expect(run.spec.userPrompt.startsWith('/compact now')).toBe(true);
      for (const agentDir of AGENT_SKILL_DIRS) expect(existsSync(join(run.spec.cwd, agentDir, 'skills', 'compact')), agentDir).toBe(false);
      await run.finish();
    });
  });
});
