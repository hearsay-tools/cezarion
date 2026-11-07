import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeHomes } from './runtime-isolation.testkit.ts';
import { planChain } from '../planner.ts';
import { generateRunName } from '../runs/auto-name.ts';
import type { AgentRunner } from '../core/agent-runner.ts';
import { createHostDiscovery } from '../discovery/catalog.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';

const { run } = vi.hoisted(() => ({ run: vi.fn(async () => ({ text: '' })) }));
const createRunner = vi.fn((_backend?: string) => ({ run }) as unknown as AgentRunner);
vi.mock('../skills.ts', () => ({ discoverSkills: async () => [] }));
afterEach(() => { vi.clearAllMocks(); });

it('uses the selected config and account for planner calls', async () => {
  const { root, selected } = runtimeHomes();
  Home.seed(Home.sandbox(selected.root), selected.workspaceConfig, { agentDefaults: { runner: 'claude' } });
  run.mockResolvedValue({ text: JSON.stringify({ title: 'test-plan', steps: [{ prompt: '{{task}}', name: 'Task' }] }) });
  expect((await planChain(root, 'Plan a task', [], selected, createRunner)).fallback).toBe(false);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ env: { CLAUDE_CONFIG_DIR: join(root, 'selected-account') } }));
});

it('uses the selected config and account for task naming', async () => {
  const { root, selected } = runtimeHomes();
  Home.seed(Home.sandbox(selected.root), selected.workspaceConfig, { agentDefaults: { runner: 'claude' } });
  run.mockResolvedValue({ text: '{"title":"testing home isolation"}' });
  expect(await generateRunName(root, { task: 'Test home isolation' }, selected, createRunner)).toMatchObject({ titleSummary: 'testing home isolation' });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: join(root, 'selected-account') }) }));
});

it('chooses the selected machine runner for planner and namer', async () => {
  const { root, selected } = runtimeHomes();
  run.mockResolvedValue({ text: '{"title":"testing home isolation"}' });
  await planChain(root, 'Test home isolation', [], selected, createRunner);
  await generateRunName(root, { task: 'Test home isolation' }, selected, createRunner);
  expect(createRunner).toHaveBeenCalledTimes(2);
  expect(createRunner).toHaveBeenNthCalledWith(1, 'codex');
  expect(createRunner).toHaveBeenNthCalledWith(2, 'codex');
});

it('applies selected provider preferences to host discovery', async () => {
  const { root, selected } = runtimeHomes();
  const auth = { status: async () => ({ providers: [{ provider: 'claude', available: true, authenticated: true }] }) } as unknown as ProviderAuthService;
  const discovery = createHostDiscovery(root, auth, selected);
  expect((await discovery.providers()).providers).toEqual([expect.objectContaining({ provider: 'claude', enabled: false })]);
});
import { Home } from './home.ts';
