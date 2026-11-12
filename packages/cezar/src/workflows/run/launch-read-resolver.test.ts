import { Home } from '../../home/home.ts';
import { useTestHome } from '../../home/test-home.testkit.ts';
import { testHome } from '../../home/test-home.testkit.ts';
// Load compile-only fixture functions so the quality report can measure their bodies.
import '../launch-read-resolver.types.testkit.ts';
import { STEP_KIND, STEP_STATUS, RUN_STATUS, makeRunRecord, makeStepState } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AGENT_MODELS_LOCKED_ERROR } from '../../core/agent-model-policy.ts';
import type { WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import { createActiveRun } from '../active-run.ts';
import { RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { atContinue, atStepOpen, atTaskHead, bindLaunchSource } from './launch-read-resolver.ts';
import { retryPrompt } from './auto-resume.ts';
import { TrackedWork } from './tracked-work.ts';
import type { RunModuleContext } from './types.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';

let root: string;
let store: RunStore;
let context: RunModuleContext;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-launch-read-'));
  useTestHome(join(root, 'home') ? Home.sandbox(join(root, 'home')) : undefined);
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
  store = RunStore.open(root);
  context = { createRunner: noRunners, home: testHome(), store, dataDir: root, repoRoot: root, semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false };
  id = store.createRun({ title: 'Launch', workflow: 'accepted', task: 'original', steps: [{ id: 'first', name: 'First', kind: STEP_KIND.agent }] }).id;
});
afterEach(() => { vi.unstubAllEnvs(); store.flush(); rmSync(root, { recursive: true, force: true }); });
const attachments = (runId: string, urls: string[], kind: 'task' | 'queued' | 'continuation') =>
  atTaskHead.attachments(context, runId, urls, kind);
const message = (text: string, images: string[] = []) => ({ id: 'queued', text, images, createdAt: '2026-11-05T00:00:00Z' });
function imageFile(name: string, content: string): string {
  const dir = join(root, 'runs', `${id}-images`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  return `/api/v1/runs/${id}/images/${name}`;
}

it('hydrates current amendments while preserving accepted task options and separate durable text', () => {
  const accepted = { task: 'accepted', runner: 'codex' as const, model: 'gpt-5', effort: 'high', systemPrompt: 'pinned', worktree: false, autonomous: true };
  store.updateRun(id, { task: 'edited', queuedMessages: [message('latest')] });
  const durable = structuredClone(store.getRun(id));
  const hydrated = atTaskHead.hydrateQueuedInput(context, attachments, id, accepted);
  expect(hydrated).toEqual({ ...accepted, task: 'edited\n\nlatest', images: undefined, stackedImages: undefined });
  expect(store.getRun(id)).toEqual(durable);
});

it('keeps original live image blocks when the best-effort persistence has no file', () => {
  const pasted = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'live' } };
  store.updateRun(id, { taskImages: ['/images/missing.png'] });
  const hydrated = atTaskHead.hydrateQueuedInput(context, attachments, id, { task: 'accepted', images: [pasted] });
  expect(hydrated.images).toEqual([pasted]);
  expect(store.readEvents(id).filter(event => event.type === 'note')).toEqual([]);
});

it('reads replacement bytes and omits removed persisted attachments at hydration', () => {
  const url = imageFile('current.png', 'old');
  store.updateRun(id, { taskImages: [url, '/images/removed.png'] });
  imageFile('current.png', 'replacement');
  const hydrated = atTaskHead.hydrateQueuedInput(context, attachments, id, { task: 'accepted' });
  expect(hydrated.images).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('replacement').toString('base64') } }]);
  expect(store.readEvents(id).filter(event => event.type === 'note').map(event => event.message)).toEqual(['task attachment removed.png could not be read — starting without it']);
});

it('refreshes queued Continue text without replacing accepted session or backend pins', () => {
  store.updateRun(id, { task: 'edited task', queuedMessages: [message('amended')], continuationMessage: { ...message('edited opening'), id: 'continued' } });
  const accepted = { stepId: 'continued', sessionId: 'accepted-session', backend: 'codex' as const, prompt: 'old opening', images: [], lineJoinedAt: 12 };
  const hydrated = atContinue.hydrateQueuedContinuation(context, attachments, id, accepted);
  expect(hydrated).toEqual({ ...accepted, prompt: 'edited opening\n\nCurrent task and queued updates:\n\nedited task\n\namended', persistedImages: [], persistedAttachments: [] });
});

it('does not read checkpoint attachments during Continue hydration', () => {
  store.updateRun(id, { continuationMessage: { ...message('Continue', ['/images/checkpoint.png']), id: 'continued' }, queuedMessages: [message('queued', ['/images/queued.png'])] });
  const reads: string[][] = [];
  const read = (...args: Parameters<typeof attachments>) => { const result = attachments(...args); reads.push(args[1]); return result; };
  atContinue.hydrateQueuedContinuation(context, read, id, { stepId: 'continued', sessionId: undefined, backend: 'claude', prompt: 'Continue', images: [], lineJoinedAt: 12 });
  expect(reads).toEqual([['/images/queued.png']]);
});

it('reads Continue checkpoint files at opening and prefers live blocks before appending queued blocks', () => {
  const url = imageFile('checkpoint.png', 'checkpoint');
  const live = { type: 'text' as const, text: 'live block' };
  const queued = { type: 'text' as const, text: 'queued block' };
  const result = atContinue.openingImages({ readPersistedAttachments: attachments, answerSource: () => undefined }, id, 'continued', { ...message('Continue', [url]), id: 'continued' }, { images: [live], persistedImages: [queued], persistedAttachments: [] });
  expect(result.openingImages).toEqual([live, queued]);
  expect(result.attachments.map(saved => saved.name)).toEqual(['checkpoint.png']);
});

it('ignores checkpoint URLs owned by another continuation', () => {
  const result = atContinue.openingImages({ readPersistedAttachments: attachments, answerSource: () => undefined }, id, 'new-step', { ...message('Continue', ['/images/old.png']), id: 'old-step' }, { images: [], persistedImages: [], persistedAttachments: [] });
  expect(result).toEqual({ openingImages: [], attachments: [] });
  expect(store.readEvents(id)).toEqual([]);
});

it('selects amended run effort before input fallback and preserves authored explicit unset', () => {
  store.updateRun(id, { effort: 'high' });
  expect(atStepOpen.effort(store, id, { id: 'first', prompt: '{{task}}' }, { task: 'accepted', effort: 'low' }, undefined, false)).toBe('high');
  expect(atStepOpen.effort(store, id, { id: 'first', prompt: '{{task}}', effort: '' }, { task: 'accepted', effort: 'low' }, undefined, false)).toBeUndefined();
  expect(atStepOpen.effort(store, id, { id: 'first', prompt: '{{task}}', effort: 'high' }, { task: 'accepted' }, undefined, true)).toBeUndefined();
});

it('keeps Continue effort record-reference semantics after an in-place store amendment', () => {
  store.updateRun(id, { effort: 'low' });
  const captured = store.getRun(id);
  store.updateRun(id, { effort: 'high' });
  expect(store.getRun(id)).toBe(captured);
  expect(atContinue.effort(root, captured, undefined, undefined, testHome())).toEqual({ effort: 'high' });
  expect(atContinue.effort(root, store.getRun(id), undefined, undefined, testHome())).toEqual({ effort: 'high' });
});

it('binds accepted input without reading fields or exposing them through an alias', () => {
  let reads = 0;
  const accepted = { task: 'accepted', get runner() { reads++; return 'codex' as const; } };
  const source = bindLaunchSource(accepted);
  const alias = source;
  expect(reads).toBe(0);
  expect(Object.keys(alias)).toEqual([]);
  expect(Object.isFrozen(alias)).toBe(true);
});

const workerIdentity: WorkerStepIdentity = { account: { provider: 'codex', profileId: 'default' }, grants: {}, effort: 'low' };

it.each(['step', 'continue'] as const)('P6-30 P6-31 keeps worker and authored effort precedence at %s', phase => {
  store.updateRun(id, { effort: 'max' });
  const input = { task: 'accepted', effort: 'medium' };
  const authored = { id: 'first', effort: 'high' };
  const select = (definition: typeof authored, identity: WorkerStepIdentity | undefined) => phase === 'step'
    ? atStepOpen.effort(store, id, definition, input, identity, false)
    : (atContinue.effort(root, store.getRun(id), definition, identity, testHome()) as { effort: string | undefined }).effort;
  expect(select(authored, workerIdentity)).toBe('low');
  expect(select(authored, undefined)).toBe('high');
  expect(select({ id: 'first', effort: '' }, undefined)).toBeUndefined();
});

it('P6-30 P6-31 keeps lock and invalid authored effort errors in their original order', async () => {
  const input = { task: 'accepted', effort: 'low' };
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  const invalid = { id: 'first', effort: 'invalid' };
  expect(() => atStepOpen.effort(store, id, invalid, input, undefined, false)).toThrow('Invalid effort');
  expect(atContinue.effort(root, store.getRun(id), invalid, undefined, testHome())).toBe('Invalid effort');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ modelsLocked: true }));
  expect(await atStepOpen.model(store, root, id, state, invalid, input, 'claude', undefined, testHome())).toBe(AGENT_MODELS_LOCKED_ERROR);
  expect(atContinue.effort(root, store.getRun(id), invalid, undefined, testHome())).toBe(AGENT_MODELS_LOCKED_ERROR);
  expect(atContinue.effort(root, store.getRun(id), { id: 'first', effort: '' }, undefined, testHome())).toEqual({ effort: undefined });
});

it('P6-29 task-level model metadata does not read effort before step selection', async () => {
  let reads = 0;
  const source = bindLaunchSource({ task: 'accepted', model: 'anthropic/claude-sonnet-4-6', get effort() { reads++; return 'high'; } });
  expect(await atTaskHead.modelIdentity(root, 'claude', source, testHome())).toBe('anthropic/claude-sonnet-4-6');
  expect(reads).toBe(0);
});

it('P6-13 unsafe attachment names and symlinks preserve omission and note behavior', () => {
  const outside = join(root, 'outside.png');
  writeFileSync(outside, 'private image');
  const dir = join(root, 'runs', `${id}-images`);
  mkdirSync(dir, { recursive: true });
  symlinkSync(outside, join(dir, 'unsafe.png'));
  expect(attachments(id, ['/images/unsafe.png', '/images/..png'], 'task')).toEqual({ attachments: [], blocks: [] });
  expect(store.readEvents(id).filter(event => event.type === 'note').map(event => event.message))
    .toEqual(['task attachment unsafe.png could not be read — starting without it']);
});

it('copies the selected account before hold participant callbacks run', () => {
  store.updateRun(id, { agentProfile: 'pinned' });
  const run = store.getRun(id)!;
  const held = atTaskHead.heldAccount(run, 'claude', () => {
    run.agentProfile = 'changed';
    return { deadline: new Set(['claude:pinned']), inFlight: new Set() };
  });
  expect(held).toBe(true);
  expect(run.agentProfile).toBe('changed');
});

it('P6-25 task metadata reads the current model lock after input acceptance', async () => {
  const input = atTaskHead.acceptInput(root, { task: 'accepted', model: 'anthropic/claude-sonnet-4-6' }, testHome());
  expect(await atTaskHead.modelIdentity(root, 'claude', bindLaunchSource(input), testHome())).toBe('anthropic/claude-sonnet-4-6');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ modelsLocked: true }));
  expect(await atTaskHead.modelIdentity(root, 'claude', bindLaunchSource(input), testHome())).toBeUndefined();
});

// hearsay-tools/squawk#3337: the workflow step a provider-error hold resumes, and what a fresh retry asks.
const twoAgentSteps = { name: 'two', source: 'built-in' as const, steps: [
  { id: 'build', name: 'Build', prompt: 'Build: {{task}}' },
  { id: 'review', name: 'Review', prompt: 'Review this change: {{task}}. Do not edit files.' },
] };
const heldRun = (statuses: Record<string, (typeof STEP_STATUS)[keyof typeof STEP_STATUS]>, currentStepId: string) => makeRunRecord({
  status: RUN_STATUS.running, task: 'add the parser', workflowDef: twoAgentSteps, currentStepId,
  steps: Object.entries(statuses).map(([stepId, status]) => makeStepState({ id: stepId, name: stepId, kind: STEP_KIND.agent, status })),
});
it('holds the failing workflow step, not an earlier one a retry already recovered', () => {
  expect(atContinue.heldStep(heldRun({ build: STEP_STATUS.failed, review: STEP_STATUS.failed }, 'review'))).toBe('review');
  expect(atContinue.heldStep(heldRun({ build: STEP_STATUS.failed, review: STEP_STATUS.pending }, 'build'))).toBe('build');
  expect(atContinue.heldStep({ ...heldRun({ build: STEP_STATUS.failed }, 'build'), workflowResumeStepId: 'build' })).toBe('build');
  // A later Continue's failure, after the recovered workflow finished, is no workflow step's.
  expect(atContinue.heldStep(heldRun({ build: STEP_STATUS.failed, review: STEP_STATUS.done, 'continue-2': STEP_STATUS.failed }, 'continue-2'))).toBeUndefined();
});
it('gives a fresh retry the held step\'s own prompt', () => {
  const run = { ...heldRun({ build: STEP_STATUS.done, review: STEP_STATUS.failed }, 'review'), workflowResumeStepId: 'review' };
  expect(atContinue.task(run)).toBe('Review this change: add the parser. Do not edit files.');
  expect(atContinue.task(makeRunRecord({ task: 'add the parser' }))).toBe('add the parser');
});
it('sends the held step\'s prompt with every provider retry, a launch id alone included', () => {
  const held = { ...heldRun({ build: STEP_STATUS.done, review: STEP_STATUS.failed }, 'review'), workflowResumeStepId: 'review', autoResumeReason: 'provider-error' as const };
  const launched = { ...held, steps: held.steps.map(step => ({ ...step, sessionId: 'launch-uuid' })) };
  expect(retryPrompt(held)).toContain('before its agent session started');
  for (const run of [held, launched]) expect(retryPrompt(run)).toContain('Review this change: add the parser. Do not edit files.');
  expect(retryPrompt({ ...launched, autoResumeReason: 'usage-limit' })).not.toContain('Review this change');
});
it('keeps a queued provider retry on the held step\'s runner across a restart', () => {
  const host = { workerStep: () => undefined, resumableSessionId: () => 'claude-session' } as unknown as Parameters<typeof atTaskHead.queuedResumeSession>[1];
  const step = makeStepState({ id: 'review', kind: STEP_KIND.agent, status: STEP_STATUS.failed, sessionId: 'claude-session', backend: 'claude' });
  // No attempt count: admission's write can land before the counter's debounced one.
  const retry = makeRunRecord({ status: RUN_STATUS.queued, runner: 'codex', steps: [step], workflowResumeStepId: 'review', autoResumeReason: 'provider-error' });
  expect(atTaskHead.queuedResumeSession(context, host, retry, step)).toMatchObject({ backend: 'claude', recoveredSessionId: 'claude-session' });
  // The held step's account too, not the run's.
  const ownedStep = { ...step, profileId: 'work-account' };
  expect(atTaskHead.queuedResumeSession(context, host, { ...retry, agentProfile: 'personal', steps: [ownedStep] }, ownedStep)).toMatchObject({ backend: 'claude', sameAccount: true, recoveredSessionId: 'claude-session' });
  // Any other queued Continue keeps the run's runner, as before.
  expect(atTaskHead.queuedResumeSession(context, host, { ...retry, autoResumeReason: undefined }, step)).toMatchObject({ backend: 'codex', recoveredSessionId: undefined });
});
