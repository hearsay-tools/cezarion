/**
 * #790: a skill-driven task must keep `skillSystemPrompt` on Continue and
 * restart recovery for every runner that resends the system prompt, and must
 * not duplicate it into an in-thread resume.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';
import {
  HARNESS_ADAPTERS,
  PINNED_SESSION_ID,
  SKILL_RESUME_CRITERIA,
  driveSeam,
  promptFor,
  waitFor,
} from './harness-parity.testkit.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';
import { RunManager, skillSystemPrompt } from '../workflows/run.ts';
import { plannedWorkflow, skillTaskSteps } from '../workflows/types.ts';

const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const SKILL_NAME = 'resume-playbook';
const SKILL_DESCRIPTION = 'Playbook for continued skill-driven tasks.';
const SKILL_BODY = 'PLAYBOOK-BODY-790-SENTINEL';
const EXTRA_PROMPT = 'EXTRA-PROMPT-790';
const MISSING_SKILL_LIFECYCLE = `skill /${SKILL_NAME} is not in the skill registry — the continued session runs without its instructions`;

const RESENT = new Set<RunnerId>(['claude', 'pi', 'omp']);
const IN_THREAD = new Set<RunnerId>(['codex', 'cursor', 'opencode']);
const LOST_OPENCODE_SESSION =
  'OpenCode session ses_mock_1 no longer exists; the continuation runs in a fresh session without the earlier conversation.';

function skillMarkdown(): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n${SKILL_BODY}\n`;
}

function expectedSkillPrompt(repoRoot: string): string {
  return skillSystemPrompt({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    body: SKILL_BODY,
    path: join(repoRoot, '.ai/cezar/skills', SKILL_NAME, 'SKILL.md'),
    source: 'cezar',
  });
}

function parsedLines(recording: string): unknown[] {
  return recording.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

function asRecord(row: unknown): Record<string, unknown> | undefined {
  return row && typeof row === 'object' ? row as Record<string, unknown> : undefined;
}

function opencodeSessionPosts(recording: string): unknown[] {
  return parsedLines(recording).filter((row) => {
    const rec = asRecord(row);
    return rec?.method === 'POST' && rec.url === '/session';
  });
}

function opencodeSessionGets(recording: string): string[] {
  return parsedLines(recording).flatMap((row) => {
    const rec = asRecord(row);
    if (rec?.method !== 'GET' || typeof rec.url !== 'string') return [];
    const match = /^\/session\/([^/]+)$/.exec(rec.url);
    return match ? [match[1]!] : [];
  });
}

function recordedSessionId(store: RunStore, runId: string): string {
  const ids = store.getRun(runId)?.steps.map((step) => step.sessionId).filter((value): value is string => Boolean(value)) ?? [];
  const id = ids.at(-1);
  expect(id, `${runId} recorded a session id`).toBeDefined();
  return id!;
}

function assertReusedRecordedSession(
  backend: RunnerId,
  continuationRecording: string,
  sessionId: string,
): void {
  if (backend === 'opencode') {
    expect(opencodeSessionPosts(continuationRecording), `${backend} Continue must not POST /session`).toEqual([]);
    expect(opencodeSessionGets(continuationRecording)).toEqual([sessionId]);
    return;
  }
  if (backend === 'codex') {
    expect(continuationRecording).toContain('thread/resume');
    expect(continuationRecording).toContain(sessionId);
    expect(continuationRecording).not.toContain('thread/start');
    return;
  }
  if (backend === 'cursor') {
    expect(continuationRecording).toContain('session/load');
    expect(continuationRecording).toContain(sessionId);
    expect(continuationRecording).not.toMatch(/"method"\s*:\s*"session\/new"/);
    return;
  }
  if (backend === 'claude') {
    expect(continuationRecording).toMatch(/--resume/);
    expect(continuationRecording).toContain(sessionId);
    return;
  }
  if (backend === 'pi') {
    expect(continuationRecording).toMatch(/--session/);
    expect(continuationRecording).toContain(sessionId);
    return;
  }
  expect(continuationRecording).toMatch(/--resume/);
  expect(continuationRecording).toContain(sessionId);
}

function systemFromPrepended(text: string): string {
  const sep = '\n\n---\n\n';
  const at = text.lastIndexOf(sep);
  return at >= 0 ? text.slice(0, at) : text;
}

function systemPromptsFrom(backend: RunnerId, recording: string): string[] {
  const rows = parsedLines(recording);
  if (backend === 'claude' || backend === 'pi' || backend === 'omp') {
    return rows.flatMap((row) => {
      if (!Array.isArray(row)) return [];
      const index = row.indexOf('--append-system-prompt');
      return index >= 0 && typeof row[index + 1] === 'string' ? [row[index + 1]] : [];
    });
  }
  const texts: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    if (backend === 'codex' && rec.method === 'turn/start') {
      const input = (rec.params as { input?: Array<{ text?: string }> } | undefined)?.input;
      const text = input?.[0]?.text;
      if (typeof text === 'string') texts.push(systemFromPrepended(text));
    }
    if (backend === 'cursor' && rec.method === 'session/prompt') {
      const prompt = (rec.params as { prompt?: Array<{ type?: string; text?: string }> } | undefined)?.prompt;
      const text = prompt?.find((part) => typeof part.text === 'string')?.text;
      if (typeof text === 'string') texts.push(systemFromPrepended(text));
    }
    if (backend === 'opencode' && typeof rec.url === 'string' && rec.url.includes('prompt_async')) {
      const parts = (rec.body as { parts?: Array<{ type?: string; text?: string }> } | undefined)?.parts;
      const text = parts?.[0]?.text;
      if (typeof text === 'string') texts.push(systemFromPrepended(text));
    }
  }
  return texts;
}

function readRecording(argsFile: string, stdinFile: string): string {
  const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '';
  const stdin = existsSync(stdinFile) ? readFileSync(stdinFile, 'utf8') : '';
  return args.endsWith('\n') || args.length === 0 ? `${args}${stdin}` : `${args}\n${stdin}`;
}

function fileText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function wireSince(argsFile: string, stdinFile: string, marked: { args: number; stdin: number }): string {
  return `${fileText(argsFile).slice(marked.args)}${fileText(stdinFile).slice(marked.stdin)}`;
}

function markWire(argsFile: string, stdinFile: string): { args: number; stdin: number } {
  return { args: fileText(argsFile).length, stdin: fileText(stdinFile).length };
}

function skillInPrompt(prompt: string, repoRoot: string): boolean {
  const skill = expectedSkillPrompt(repoRoot);
  return prompt.startsWith(skill) && prompt.includes(EXTRA_PROMPT)
    && prompt.indexOf(skill) < prompt.indexOf(EXTRA_PROMPT);
}

async function idleClose(manager: RunManager, runId: string): Promise<void> {
  await waitFor(() => {
    const state = (manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(runId);
    return typeof (state?.idleTimer as { _onTimeout?: () => void } | undefined)?._onTimeout === 'function';
  });
  const state = (manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(runId);
  const timer = state?.idleTimer as NodeJS.Timeout & { _onTimeout(): void };
  timer._onTimeout();
  await waitFor(() => !manager.isActive(runId));
}

/** Idle-close leaves the run `waiting`, so a second wait-for-waiting is a race. */
async function continueAndPark(
  fixture: {
    manager: RunManager;
    store: RunStore;
    runId: string;
    argsFile: string;
    stdinFile: string;
    markWire: () => { args: number; stdin: number };
    wireSince: (marked: { args: number; stdin: number }) => string;
  },
  opts: { text: string; runner?: RunnerId },
  marked: { args: number; stdin: number },
): Promise<string> {
  expect(fixture.manager.continueRun(fixture.runId, opts).ok).toBe(true);
  await waitFor(() => fixture.manager.isActive(fixture.runId) || fixture.store.getRun(fixture.runId)?.status === 'running');
  await waitFor(() => fixture.store.getRun(fixture.runId)?.status === 'waiting' && fixture.manager.isActive(fixture.runId));
  await waitFor(() => fixture.wireSince(marked).includes('--append-system-prompt') || fixture.wireSince(marked).includes('turn/start') || fixture.wireSince(marked).includes('session/prompt') || fixture.wireSince(marked).includes('prompt_async'));
  return fixture.wireSince(marked);
}

async function withSkillResumeRun(
  backend: RunnerId,
  body: (fixture: {
    repoRoot: string;
    runId: string;
    store: RunStore;
    manager: RunManager;
    argsFile: string;
    stdinFile: string;
    snapshotWire: () => string;
    markWire: () => { args: number; stdin: number };
    wireSince: (marked: { args: number; stdin: number }) => string;
    restart: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const adapter = HARNESS_ADAPTERS[backend];
  const saved: Array<[string, string | undefined]> = [];
  const remember = (name: string, value: string | undefined) => {
    saved.push([name, process.env[name]]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-skill-resume-${backend}-`));
  const argsFile = join(repoRoot, 'wire.args.ndjson');
  const stdinFile = join(repoRoot, 'wire.stdin.ndjson');
  remember(adapter.binEnv, adapter.mockBin);
  remember('CEZ_AUTONAME', '0');
  remember('CEZ_MOCK_ARGS_FILE', argsFile);
  remember('CEZ_MOCK_STDIN_FILE', stdinFile);
  const dry = process.env.CEZ_DRY_RUN;
  saved.push(['CEZ_DRY_RUN', dry]);
  delete process.env.CEZ_DRY_RUN;
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills', SKILL_NAME), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/skills', SKILL_NAME, 'SKILL.md'), skillMarkdown());
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    const started = manager.startRun(plannedWorkflow(skillTaskSteps(SKILL_NAME)), {
      task: promptFor(backend, 'baseline'),
      runner: backend,
      worktree: false,
      systemPrompt: EXTRA_PROMPT,
    });
    await waitFor(() => store!.getRun(started.id)?.status === 'waiting', 30_000);
    const snapshotWire = () => readRecording(argsFile, stdinFile);
    const mark = () => markWire(argsFile, stdinFile);
    const since = (marked: { args: number; stdin: number }) => wireSince(argsFile, stdinFile, marked);
    const restart = async () => {
      store!.flush();
      const dataDir = join(repoRoot, '.ai/cezar');
      const checkpoint = readPersistedRuns(dataDir);
      await drainFixtureManagers(repoRoot);
      store!.close();
      seedRuns(dataDir, checkpoint);
      store = RunStore.open(dataDir, { keepLive: true });
      manager = createFixtureManager(store, repoRoot);
      await manager.recover();
    };
    await body({
      repoRoot,
      runId: started.id,
      get store() { return store!; },
      get manager() { return manager!; },
      argsFile,
      stdinFile,
      snapshotWire,
      markWire: mark,
      wireSince: since,
      restart,
    });
  } finally {
    await drainFixtureManagers(repoRoot);
    store?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function assertLaunchKeepsSkill(backend: RunnerId, repoRoot: string, recording: string): string {
  const prompts = systemPromptsFrom(backend, recording);
  expect(prompts.length, `${backend} launch recorded a system prompt`).toBeGreaterThan(0);
  const launch = prompts[0]!;
  expect(skillInPrompt(launch, repoRoot), `${backend} launch includes skill before extra`).toBe(true);
  return launch;
}

function assertContinuationSkill(
  backend: RunnerId,
  repoRoot: string,
  launchPrompt: string,
  continuationRecording: string,
): void {
  const prompts = systemPromptsFrom(backend, continuationRecording);
  expect(prompts.length, `${backend} continuation recorded a system prompt`).toBeGreaterThan(0);
  const continued = prompts[prompts.length - 1]!;
  if (RESENT.has(backend)) {
    expect(skillInPrompt(continued, repoRoot), `${backend} Continue resends the skill`).toBe(true);
    expect(continued.startsWith(expectedSkillPrompt(repoRoot))).toBe(true);
    expect(continued.slice(0, launchPrompt.length)).toBe(launchPrompt);
  } else {
    expect(continued.includes(SKILL_BODY), `${backend} in-thread resume must not resend the skill`).toBe(false);
    expect(continued.includes(`Selected skill: /${SKILL_NAME}`)).toBe(false);
  }
}

describe('harness parity — skill system prompt on Continue (#790)', () => {
  expect(SKILL_RESUME_CRITERIA.map((row) => row.id)).toEqual(['R53', 'R54', 'R55', 'R56', 'R57']);

  for (const backend of RUNNER_IDS) {
    it(`${backend} R53 keeps the skill system prompt on a live Continue`, async () => {
      await withSkillResumeRun(backend, async (fixture) => {
        const launchPrompt = assertLaunchKeepsSkill(backend, fixture.repoRoot, fixture.snapshotWire());
        await idleClose(fixture.manager, fixture.runId);
        const marked = fixture.markWire();
        const continued = await continueAndPark(fixture, { text: promptFor(backend, 'baseline') }, marked);
        assertContinuationSkill(backend, fixture.repoRoot, launchPrompt, continued);
      });
    }, 60_000);

    it(`${backend} R54 keeps the skill system prompt when recover() resumes a persisted continuation`, async () => {
      await withSkillResumeRun(backend, async (fixture) => {
        const launchPrompt = assertLaunchKeepsSkill(backend, fixture.repoRoot, fixture.snapshotWire());
        await idleClose(fixture.manager, fixture.runId);
        const marked = fixture.markWire();
        expect(fixture.manager.continueRun(fixture.runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
        const persisted = fixture.store.getRun(fixture.runId);
        expect(persisted?.continuationMessage).toBeDefined();
        expect(['running', 'queued']).toContain(persisted?.status);
        await fixture.restart();
        await waitFor(() => fixture.manager.isActive(fixture.runId) || ['queued', 'running', 'waiting'].includes(fixture.store.getRun(fixture.runId)?.status ?? ''));
        await waitFor(() => fixture.store.getRun(fixture.runId)?.status === 'waiting' && fixture.manager.isActive(fixture.runId));
        await waitFor(() => fixture.wireSince(marked).includes('--append-system-prompt') || fixture.wireSince(marked).includes('turn/start') || fixture.wireSince(marked).includes('session/prompt') || fixture.wireSince(marked).includes('prompt_async'));
        assertContinuationSkill(backend, fixture.repoRoot, launchPrompt, fixture.wireSince(marked));
      });
    }, 60_000);

    it(`${backend} R57 reuses the recorded session id on Continue and recover`, async () => {
      await withSkillResumeRun(backend, async (fixture) => {
        await waitFor(() => Boolean(fixture.store.getRun(fixture.runId)?.steps?.some((step) => Boolean(step.sessionId))));
        const sessionId = recordedSessionId(fixture.store, fixture.runId);
        await idleClose(fixture.manager, fixture.runId);
        const continuedMark = fixture.markWire();
        const continued = await continueAndPark(fixture, { text: promptFor(backend, 'baseline') }, continuedMark);
        assertReusedRecordedSession(backend, continued, sessionId);
        expect(recordedSessionId(fixture.store, fixture.runId)).toBe(sessionId);

        await idleClose(fixture.manager, fixture.runId);
        const recoverMark = fixture.markWire();
        expect(fixture.manager.continueRun(fixture.runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
        await fixture.restart();
        await waitFor(() => fixture.manager.isActive(fixture.runId) || ['queued', 'running', 'waiting'].includes(fixture.store.getRun(fixture.runId)?.status ?? ''));
        await waitFor(() => fixture.store.getRun(fixture.runId)?.status === 'waiting' && fixture.manager.isActive(fixture.runId));
        await waitFor(() => fixture.wireSince(recoverMark).includes('--append-system-prompt') || fixture.wireSince(recoverMark).includes('turn/start') || fixture.wireSince(recoverMark).includes('session/prompt') || fixture.wireSince(recoverMark).includes('prompt_async') || fixture.wireSince(recoverMark).includes('session/load') || fixture.wireSince(recoverMark).includes('thread/resume'));
        assertReusedRecordedSession(backend, fixture.wireSince(recoverMark), sessionId);
        expect(recordedSessionId(fixture.store, fixture.runId)).toBe(sessionId);
      });
    }, 90_000);

    it(`${backend} R55 ${RESENT.has(backend) ? 'warns once when the continued skill is gone' : 'skips the missing-skill warning on an in-thread resume'}`, async () => {
      await withSkillResumeRun(backend, async (fixture) => {
        assertLaunchKeepsSkill(backend, fixture.repoRoot, fixture.snapshotWire());
        await idleClose(fixture.manager, fixture.runId);
        rmSync(join(fixture.repoRoot, '.ai/cezar/skills', SKILL_NAME), { recursive: true, force: true });
        const before = fixture.store.readEvents(fixture.runId).filter((event) => event.type === 'lifecycle' && String(event.message).includes('is not in the skill registry'));
        expect(before).toEqual([]);
        const marked = fixture.markWire();
        const continuedWire = await continueAndPark(fixture, { text: promptFor(backend, 'baseline') }, marked);
        const warnings = fixture.store.readEvents(fixture.runId).filter((event) => event.type === 'lifecycle' && String(event.message).includes('is not in the skill registry'));
        const continued = systemPromptsFrom(backend, continuedWire);
        const last = continued.at(-1) ?? '';
        expect(last.includes(SKILL_BODY)).toBe(false);
        expect(last.includes(`Selected skill: /${SKILL_NAME}`)).toBe(false);
        if (RESENT.has(backend)) {
          expect(warnings).toEqual([expect.objectContaining({ type: 'lifecycle', message: MISSING_SKILL_LIFECYCLE })]);
        } else {
          expect(warnings).toEqual([]);
        }
      });
    }, 60_000);
  }

  for (const backend of IN_THREAD) {
    it(`${backend} fresh-session continuation includes the skill`, async () => {
      const origin: RunnerId = 'claude';
      const savedClaude = process.env.CEZ_CLAUDE_BIN;
      const savedTarget = process.env[HARNESS_ADAPTERS[backend].binEnv];
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
      try {
        await withSkillResumeRun(origin, async (fixture) => {
          const launchPrompt = assertLaunchKeepsSkill(origin, fixture.repoRoot, fixture.snapshotWire());
          await idleClose(fixture.manager, fixture.runId);
          const marked = fixture.markWire();
          const continuedWire = await continueAndPark(fixture, {
            text: promptFor(backend, 'baseline'),
            runner: backend,
          }, marked);
          const continued = systemPromptsFrom(backend, continuedWire);
          expect(continued.length).toBeGreaterThan(0);
          const last = continued.at(-1)!;
          expect(skillInPrompt(last, fixture.repoRoot)).toBe(true);
          expect(last.startsWith(expectedSkillPrompt(fixture.repoRoot))).toBe(true);
          expect(launchPrompt.startsWith(expectedSkillPrompt(fixture.repoRoot))).toBe(true);
        });
      } finally {
        if (savedClaude === undefined) delete process.env.CEZ_CLAUDE_BIN;
        else process.env.CEZ_CLAUDE_BIN = savedClaude;
        if (savedTarget === undefined) delete process.env[HARNESS_ADAPTERS[backend].binEnv];
        else process.env[HARNESS_ADAPTERS[backend].binEnv] = savedTarget;
      }
    }, 60_000);
  }
});

describe('harness parity — systemPromptOnResume declaration (#790)', () => {
  it('every runner declares systemPromptOnResume', () => {
    const expected: Record<RunnerId, 'resent' | 'in-thread'> = {
      claude: 'resent',
      pi: 'resent',
      omp: 'resent',
      opencode: 'in-thread',
      codex: 'in-thread',
      cursor: 'in-thread',
    };
    for (const backend of RUNNER_IDS) {
      expect(createRunner(backend).systemPromptOnResume).toBe(expected[backend]);
    }
  });

  for (const backend of RUNNER_IDS) {
    it(`${backend} R56 declaration matches the resume wire`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `cez-skill-resume-decl-${backend}-`));
      try {
        const freshName = 'fresh';
        const resumeName = 'resume';
        const fresh = await driveSeam(backend, 'baseline', {
          spec: {
            cwd: dir,
            systemPrompt: 'SENTINEL-790-SYSTEM',
            env: {
              CEZ_MOCK_ARGS_FILE: `${freshName}.args.ndjson`,
              CEZ_MOCK_STDIN_FILE: `${freshName}.stdin.ndjson`,
              CEZ_HANDOFF_FILE: '',
              CEZ_TODOS_FILE: '',
            },
          },
        });
        expect(fresh.v1.filter((event) => event.type === 'error')).toEqual([]);
        const resumed = await driveSeam(backend, 'baseline', {
          spec: {
            cwd: dir,
            resume: true,
            systemPrompt: 'SENTINEL-790-SYSTEM',
            env: {
              CEZ_MOCK_ARGS_FILE: `${resumeName}.args.ndjson`,
              CEZ_MOCK_STDIN_FILE: `${resumeName}.stdin.ndjson`,
              CEZ_HANDOFF_FILE: '',
              CEZ_TODOS_FILE: '',
            },
          },
        });
        expect(resumed.v1.filter((event) => event.type === 'error')).toEqual([]);
        const freshWire = readRecording(join(dir, `${freshName}.args.ndjson`), join(dir, `${freshName}.stdin.ndjson`));
        const resumeWire = readRecording(join(dir, `${resumeName}.args.ndjson`), join(dir, `${resumeName}.stdin.ndjson`));
        const mode = createRunner(backend).systemPromptOnResume;
        if (mode === 'resent') {
          expect(freshWire).toContain('SENTINEL-790-SYSTEM');
          expect(resumeWire).toContain('SENTINEL-790-SYSTEM');
          expect(resumeWire).toMatch(/--resume|--session|thread\/resume|session\/load/);
        } else {
          expect(freshWire).toContain('SENTINEL-790-SYSTEM');
          if (backend === 'opencode') {
            expect(opencodeSessionGets(resumeWire)).toEqual([PINNED_SESSION_ID]);
            expect(opencodeSessionGets(freshWire)).toEqual([]);
            expect(freshWire).not.toMatch(/thread\/resume|session\/load/);
          } else {
            expect(resumeWire).toMatch(/thread\/resume|session\/load/);
            expect(freshWire).not.toMatch(/thread\/resume|session\/load/);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 45_000);
  }
});

describe('opencode lost-session fallback (#790)', () => {
  it('opens a fresh session with the skill, one lifecycle notice, and a new session id', async () => {
    await withSkillResumeRun('opencode', async (fixture) => {
      const launchPrompt = assertLaunchKeepsSkill('opencode', fixture.repoRoot, fixture.snapshotWire());
      const lostId = recordedSessionId(fixture.store, fixture.runId);
      expect(lostId).toBe('ses_mock_1');
      await idleClose(fixture.manager, fixture.runId);
      const persist = `${fixture.argsFile}.opencode-sessions.json`;
      const stored = JSON.parse(readFileSync(persist, 'utf8')) as { seq: number; sessions: Record<string, unknown> };
      expect(stored.sessions[lostId]).toBeDefined();
      writeFileSync(persist, JSON.stringify({ seq: stored.seq, sessions: {} }));
      const marked = fixture.markWire();
      const continued = await continueAndPark(fixture, { text: promptFor('opencode', 'baseline') }, marked);
      expect(opencodeSessionGets(continued)).toEqual([lostId]);
      expect(opencodeSessionPosts(continued)).toHaveLength(1);
      const prompts = systemPromptsFrom('opencode', continued);
      expect(prompts.length).toBeGreaterThan(0);
      expect(skillInPrompt(prompts.at(-1)!, fixture.repoRoot)).toBe(true);
      expect(prompts.at(-1)!.startsWith(expectedSkillPrompt(fixture.repoRoot))).toBe(true);
      expect(launchPrompt.startsWith(expectedSkillPrompt(fixture.repoRoot))).toBe(true);
      const notices = fixture.store.readEvents(fixture.runId).filter((event) =>
        (event.type === 'lifecycle' || event.type === 'note')
        && String(event.message).includes('no longer exists'));
      expect(notices).toEqual([expect.objectContaining({ message: LOST_OPENCODE_SESSION })]);
      const freshId = recordedSessionId(fixture.store, fixture.runId);
      expect(freshId).not.toBe(lostId);
      expect(freshId).toMatch(/^ses_mock_/);
    });
  }, 60_000);
});
