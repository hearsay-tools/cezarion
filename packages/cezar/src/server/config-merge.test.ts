import { describe, expect, it } from 'vitest';
import type { SetConfigInput } from '@open-mercato/cezar-contract/workspace';
import { mergeConfig } from './config-merge.js';

describe('mergeConfig', () => {
  it.each<[SetConfigInput, Record<string, unknown>]>([
    [{ baseBranch: 'develop' }, { baseBranch: 'develop' }],
    [{ defaultRunner: 'codex' }, { defaultRunner: 'codex' }],
    [{ systemPrompt: 'brief' }, { systemPrompt: 'brief' }],
    [{ maxParallel: 3 }, { maxParallel: 3 }],
    [{ worktreeRetention: 0 }, { worktreeRetention: 0 }],
    [{ liveTitleUpdates: false }, { liveTitleUpdates: false }],
    [{ archiveOnMerge: false }, { archiveOnMerge: false }],
    [{ reviewGate: false }, { reviewGate: false }],
    [{ memoryLimitMb: 128 }, { memoryLimitMb: 128 }],
    [{ worktreeSetup: { commands: ['npm ci'] } }, { worktreeSetup: { commands: ['npm ci'] } }],
    [{ worktreeSetup: { commands: ['npm ci'], timeoutSeconds: 60 } },
      { worktreeSetup: { commands: ['npm ci'], timeoutSeconds: 60 } }],
    [{ defaultModels: { codex: 'preset' } }, { defaultModels: { codex: 'preset' } }],
  ])('stores supplied fields (case %#)', (body, expected) => {
    expect(mergeConfig({ untouched: true }, body)).toEqual({ untouched: true, ...expected });
  });

  it.each<SetConfigInput>([
    { baseBranch: null }, { systemPrompt: null }, { systemPrompt: '' },
    { worktreeRetention: null }, { liveTitleUpdates: null }, { archiveOnMerge: null },
    { reviewGate: null }, { memoryLimitMb: null }, { memoryLimitMb: 0 },
    { worktreeSetup: null }, { worktreeSetup: { commands: [] } },
    { defaultModels: { codex: null } }, { defaultModels: { codex: '' } },
  ])('clears supplied fields (case %#)', (body) => {
    const key = Object.keys(body)[0]!;
    expect(mergeConfig({ untouched: true, [key]: { codex: 'old' } }, body)).toEqual({ untouched: true });
  });

  it('leaves omitted and explicitly undefined fields alone without changing inputs', () => {
    const raw = Object.freeze({ custom: { kept: true }, baseBranch: 'main', defaultModels: { claude: 'old' } });
    const body = Object.freeze({ baseBranch: undefined, defaultModels: undefined });
    const next = mergeConfig(raw, body);
    expect(next).toEqual(raw);
    expect(next).not.toBe(raw);
    expect(mergeConfig(raw, {})).toEqual(raw);
  });

  it('merges models per runner without mutating the old models or request', () => {
    const models = Object.freeze({ claude: 'keep', codex: 'old', custom: 'keep' });
    const body = Object.freeze({ defaultModels: Object.freeze({ codex: 'new', claude: undefined }) });
    expect(mergeConfig({ defaultModels: models }, body)).toEqual({
      defaultModels: { claude: 'keep', codex: 'new', custom: 'keep' },
    });
    expect(models).toEqual({ claude: 'keep', codex: 'old', custom: 'keep' });
    expect(mergeConfig({ defaultModels: models }, { defaultModels: { codex: null } })).toEqual({
      defaultModels: { claude: 'keep', custom: 'keep' },
    });
  });

  it.each([undefined, null, false, 1, 'malformed', {}])('handles absent or malformed model maps (case %#)', (existing) => {
    expect(mergeConfig({ defaultModels: existing }, { defaultModels: { codex: 'new' } })).toEqual({
      defaultModels: { codex: 'new' },
    });
    expect(mergeConfig({ defaultModels: existing }, { defaultModels: {} })).toEqual({});
  });

  it('preserves top-level array serialization accepted by the existing file reader', () => {
    const raw = ['legacy'] as unknown as Record<string, unknown>;
    const next = mergeConfig(raw, { baseBranch: 'main' });
    expect(JSON.stringify(next)).toBe(JSON.stringify(raw));
    expect(next).not.toBe(raw);
    expect(raw.baseBranch).toBeUndefined();
  });

  it('retains legacy object-like model keys and the field insertion order', () => {
    expect(mergeConfig({ defaultModels: ['legacy'] }, { defaultModels: { codex: 'new' } })).toEqual({
      defaultModels: { 0: 'legacy', codex: 'new' },
    });
    expect(Object.keys(mergeConfig({}, { defaultModels: {}, maxParallel: 2, baseBranch: 'main' })))
      .toEqual(['baseBranch', 'maxParallel']);
  });
});
