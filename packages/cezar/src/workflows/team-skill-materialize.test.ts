/**
 * #1024: a team directory skill must never be copied into the main checkout. A
 * run without its own task worktree gets a per-commit copy under the cache, and
 * the copy a worktree-off run used to leave in `<repoRoot>/.agents/skills` (which
 * `discoverSkills` reads as a LOCAL skill) no longer shadows the team skill.
 */
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
