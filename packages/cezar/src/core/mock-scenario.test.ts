import { describe, expect, it, vi } from 'vitest';
import { play, scenarioFor, type Encoder, type ScenarioContext, type Step } from '../../scripts/mock-scenario.mjs';

function context(unsupported: string[] = []): ScenarioContext {
  return { runner: 'pi', lifecycle: async () => '', session: {}, unsupported };
}

function encoder(events: string[]): Encoder {
  return {
    open: () => { events.push('open'); },
    text: step => { events.push(step.parts.join('')); },
    reasoning: step => { events.push(step.text); },
    toolStart: step => { events.push(`start:${step.call.name}`); },
    toolEnd: step => { events.push(`end:${step.call.name}`); },
    child: (_step, playChild) => { playChild(encoder(events)); },
    progress: () => { events.push('progress'); },
    readSteers: () => { events.push('steers'); },
    end: () => { events.push('end'); },
  };
}

describe('shared mock scenario selection', () => {
  it.each([
    ['mock:hold-cezar-done mock:hold', 'hold-cezar-done'],
    ['mock:hold-cezar-ask mock:hold', 'hold-cezar-ask'],
    ['mock:hold-gated mock:hold', 'hold-gated'],
    ['mock:agent-echo mock:hold', 'agent-echo'],
    ['mock:autonomous mock:cezar-tool', 'autonomous'],
    ['mock:cezar-tool mock:ci-wait', 'cezar-tool'],
    ['mock:busy-progress mock:no-progress', 'busy-progress'],
  ])('preserves first-match order for %s', (prompt, name) => {
    expect(scenarioFor(prompt, context())?.name).toBe(name);
  });

  it('declares unsupported scripts and leaves untokened prompts alone', () => {
    expect(scenarioFor('mock:subagent-after-park', context(['subagent-after-park']))).toBeUndefined();
    expect(scenarioFor('Inspect the working tree.', context())).toBeUndefined();
  });

  it('places the native failure check between early and trailing scripts', () => {
    expect(scenarioFor('mock:agent-echo', context())?.beforeFailure).toBe(true);
    expect(scenarioFor('mock:hold', context())?.beforeFailure).toBe(false);
    expect(scenarioFor('mock:crash-stderr-clean', context())?.result).toBe('continue');
  });

  it('keeps resume state in the supplied session', async () => {
    const state = context();
    await play(scenarioFor('mock:cezar-ask mock:resume-cezar-done', state)!, encoder([]));
    expect(scenarioFor('Library: Vitest', state)?.name).toBe('cezar-done');
    expect(scenarioFor('Library: Vitest', context())).toBeUndefined();
  });
});

describe('shared mock scenario player', () => {
  it('emits synchronous steps before returning, without a microtask gap', async () => {
    const events: string[] = [];
    queueMicrotask(() => events.push('microtask'));
    expect(play({ steps: [{ kind: 'open' }, { kind: 'text', parts: ['a', () => 'b'] }, { kind: 'end' }] }, encoder(events))).toBe('handled');
    expect(events).toEqual(['open', 'ab', 'end']);
    await Promise.resolve();
    expect(events.at(-1)).toBe('microtask');
  });

  it('waits for asynchronous text and then emits following sync steps together', async () => {
    const events: string[] = [];
    let release!: (value: string) => void;
    const pending = new Promise<string>(resolve => { release = resolve; });
    const result = play({ steps: [{ kind: 'open' }, { kind: 'text', parts: [() => pending] }, { kind: 'end' }] }, encoder(events));
    expect(events).toEqual(['open']);
    release('ready');
    await expect(result).resolves.toBe('handled');
    expect(events).toEqual(['open', 'ready', 'end']);
  });

  it('waits for asynchronous encoders and preserves continue', async () => {
    const events: string[] = [];
    const wire = encoder(events);
    wire.open = async () => { await Promise.resolve(); events.push('open'); };
    await expect(play({ steps: [{ kind: 'open' }, { kind: 'end' }], result: 'continue' }, wire)).resolves.toBe('continue');
    expect(events).toEqual(['open', 'end']);
  });

  it('waits for sleep while keeping following frames in the same tick', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const steps: Step[] = [{ kind: 'open' }, { kind: 'sleep', ms: 250 }, { kind: 'text', parts: ['awake'] }, { kind: 'end' }];
      const result = play({ steps }, encoder(events));
      expect(events).toEqual(['open']);
      await vi.advanceTimersByTimeAsync(250);
      await result;
      expect(events).toEqual(['open', 'awake', 'end']);
    } finally { vi.useRealTimers(); }
  });
});
