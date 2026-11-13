import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it, vi } from 'vitest';
import { play, scenarioFor, type Encoder, type ScenarioContext, type Step } from '../../scripts/mock-scenario.mjs';

function context(unsupported: string[] = []): ScenarioContext {
  return { runner: 'pi', lifecycle: async () => '', toolPrompt: async () => '', ciPrompt: async () => '', crash: () => {}, session: {}, unsupported };
}

function encoder(events: string[]): Encoder {
  return {
    open: () => { events.push('open'); },
    text: step => { events.push(step.parts.join('')); },
    reasoning: step => { events.push(step.text); },
    toolStart: step => { events.push(`start:${step.call.name}`); },
    toolEnd: step => { events.push(`end:${step.call.name}`); },
    child: (_step, playChild) => { playChild(encoder(events)); },
    reply: step => { events.push(`reply:${step.prompt}`); },
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

  it.each([
    ['mock:silent-tail', 'silent-tail'],
    ['mock:crash-stderr-clean', 'crash-stderr'], ['mock:ack-only', 'ack-only'],
    ['mock:ci-wait', 'ci-wait'], ['mock:steer-tool', 'steer-tool'],
    ['mock:steer-late', 'steer-late'], ['mock:multi-pr-refs', 'multi-pr-refs'],
    ['mock:turn-messages:W10=', 'turn-messages'], ['mock:cezar-done', 'cezar-done'],
    ['mock:cezar-ask', 'cezar-ask'], ['mock:no-progress', 'no-progress'],
    ['mock:provider-error', 'provider-error'], ['mock:subagent-after-park', 'subagent-after-park'],
    ['mock:deferred-turn-start', 'deferred-turn-start'], ['mock:cezar-wait', 'cezar-wait'],
    ['Continue working autonomously until the task is fully complete.', 'autonomous'],
  ])('selects the shared script for %s', (prompt, name) => {
    expect(scenarioFor(prompt, context())?.name).toBe(name);
  });

  it.each(['codex', 'opencode'] as const)('uses the %s tool boundary without knowing its wire configuration', async runner => {
    const state = context();
    state.runner = runner;
    state.toolPrompt = vi.fn(async prompt => `tool boundary: ${prompt}`);
    state.ciPrompt = vi.fn(async prompt => `ci boundary: ${prompt}`);
    for (const [token, boundary] of [['cezar-tool', state.toolPrompt], ['ci-wait', state.ciPrompt]] as const) {
      const events: string[] = [];
      await play(scenarioFor(`mock:${token}`, state)!, encoder(events));
      expect(boundary).toHaveBeenCalledWith(`mock:${token}`);
      expect(events).toEqual(['open', `${token === 'cezar-tool' ? 'tool' : 'ci'} boundary: mock:${token}`, 'end']);
    }
  });

  it.each([
    ['mock:autonomous', undefined],
    ['mock:autonomous-cap', 'cap'],
    ['mock:autonomous-cezar-ask-cap', 'cezar-ask-cap'],
    ['mock:autonomous-cap mock:autonomous-cezar-ask-cap', 'cezar-ask-cap'],
    ['mock:autonomous unrelated-cap', undefined],
  ])('reports the autonomous variant for %s', (prompt, variant) => {
    expect(scenarioFor(prompt, context())?.variant).toBe(variant);
  });

  it('delegates the deferred reply to each native encoder after its start delay', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const prompt = 'mock:deferred-turn-start';
      let settled = false;
      const result = Promise.resolve(play(scenarioFor(prompt, context())!, encoder(events))).then(() => { settled = true; });
      expect(events).toEqual(['open']);
      // bound: fake time advances the deferred delay after its optional module loads.
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 3_000 });
      await result;
      expect(events).toEqual(['open', 'open', `reply:${prompt}`]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['pi', 'omp'] as const)('registers the %s lifecycle wait before deferred admission', async runner => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const state = context();
      state.runner = runner;
      state.lifecycle = vi.fn(async () => { events.push('wait'); return ' wait receipt'; });
      const prompt = 'mock:deferred-turn-start mock:cezar-wait';
      let settled = false;
      const result = Promise.resolve(play(scenarioFor(prompt, state)!, encoder(events))).then(() => { settled = true; });
      // bound: advance fake time after the optional deferred module has loaded.
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 3_000 });
      await result;
      expect(state.lifecycle).toHaveBeenCalledExactlyOnceWith(['cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'Re-check the downstream work.' }]);
      expect(events).toEqual(['wait', 'open', 'open', `Investigating: ${prompt} wait receipt`, 'start:read', 'end:read', 'end']);
    } finally { vi.useRealTimers(); }
  });

  it.each([['cursor', 'Done.'], ['pi', 'parity done: the task is complete']] as const)(
    'keeps the %s completion text and lifecycle note', async (runner, reply) => {
      const state = context();
      state.runner = runner;
      state.lifecycle = vi.fn(async () => ' receipt');
      const events: string[] = [];
      await play(scenarioFor('mock:cezar-done', state)!, encoder(events));
      expect(events).toEqual(['open', `${reply} receipt`, 'end']);
      expect(state.lifecycle).toHaveBeenCalledExactlyOnceWith(['cezar_done', {}]);
    });

  it('delegates crash wire details to the supplied boundary', () => {
    const state = context();
    state.crash = vi.fn();
    expect(play(scenarioFor('mock:crash-stderr-clean', state)!, encoder([]))).toBe('continue');
    expect(state.crash).toHaveBeenCalledWith('mock:crash-stderr-clean');
  });

  it('declares unsupported scripts and leaves untokened prompts alone', () => {
    expect(scenarioFor('mock:subagent-after-park', context(['subagent-after-park']))).toBeUndefined();
    expect(scenarioFor('mock:ack-only mock:agent-echo', context(['ack-only']))?.name).toBe('agent-echo');
    expect(scenarioFor('Inspect the working tree.', context())).toBeUndefined();
  });

  it('places the native failure check between early and trailing scripts', () => {
    expect(scenarioFor('mock:agent-echo', context())?.beforeFailure).toBe(true);
    expect(scenarioFor('mock:hold', context())?.beforeFailure).toBe(false);
    expect(scenarioFor('mock:crash-stderr-clean', context())?.result).toBe('continue');
  });

  it('does not change session state during repeated selection', () => {
    const state = context();
    const original = { ...state.session };
    scenarioFor('mock:cezar-ask mock:resume-cezar-done', state);
    scenarioFor('mock:cezar-ask mock:resume-cezar-done', state);
    expect(state.session).toEqual(original);
    state.session.resumeAfterAsk = true;
    scenarioFor('Library: Vitest', state);
    scenarioFor('Library: Vitest', state);
    expect(state.session.resumeAfterAsk).toBe(true);
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

  it('runs synchronous effects without an encoder call or microtask gap', () => {
    const events: string[] = [];
    expect(play({ steps: [{ kind: 'effect', run: () => { events.push('effect'); } }, { kind: 'end' }] }, encoder(events))).toBe('handled');
    expect(events).toEqual(['effect', 'end']);
  });

  it('waits for asynchronous effects before the next frame', async () => {
    const events: string[] = [];
    const result = play({ steps: [{ kind: 'effect', run: async () => { await Promise.resolve(); events.push('loaded'); } }, { kind: 'end' }] }, encoder(events));
    expect(events).toEqual([]);
    await result;
    expect(events).toEqual(['loaded', 'end']);
  });

  it('passes admitted steer text back to the script without yielding', () => {
    const events: string[] = [];
    const wire = encoder(events);
    wire.readSteers = () => ['first', 'second'];
    let admitted: string[] = [];
    const steps: Step[] = [{ kind: 'readSteers', receive: texts => { admitted = texts ?? []; } }, { kind: 'text', parts: [() => admitted.join(',')] }, { kind: 'end' }];
    expect(play({ steps }, wire)).toBe('handled');
    expect(events).toEqual(['first,second', 'end']);
  });

  it('uses a native steering hold when supplied', () => {
    const events: string[] = [];
    const wire = encoder(events);
    wire.hold = step => { events.push(`hold:${step.ms}`); };
    expect(play({ steps: [{ kind: 'hold', ms: 600 }, { kind: 'end' }] }, wire)).toBe('handled');
    expect(events).toEqual(['hold:600', 'end']);
  });

  it('sleeps for a steering hold when the encoder has no native hold', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const result = play({ steps: [{ kind: 'hold', ms: 600 }, { kind: 'end' }] }, encoder(events));
      await vi.advanceTimersByTimeAsync(599);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(events).toEqual(['end']);
    } finally { vi.useRealTimers(); }
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


describe('silent-tail shared scripts', () => {
  it.each([
    ['pi', 'silent-tail'],
    ['pi', 'silent-tail-no-reply'], ['pi', 'silent-tail-late-reply'],
    ['pi', 'silent-tail-slow-done'], ['pi', 'silent-tail-late-turn-start'],
    ['codex', 'silent-tail-late-turn-start'], ['cursor', 'silent-tail-slow-done'],
  ] as const)('plays %s %s through the fake encoder', async (runner, token) => {
    const state = context();
    state.runner = runner;
    const events: string[] = [];
    await play(scenarioFor(`mock:${token}`, state)!, encoder(events));
    expect(events).toContain('Filing the issue now.');
    events.length = 0;
    vi.useFakeTimers();
    vi.stubEnv('CEZ_MOCK_RELEASE_FILE', '');
    try {
      let settled = false;
      const result = Promise.resolve(play(scenarioFor('Your turn ended without a wait or done.', state)!, encoder(events))).then(() => { settled = true; });
      // bound: fake time advances the script's waits; this only guards a stuck script.
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10_000 });
      await result;
      if (token === 'silent-tail-no-reply') expect(events).toEqual(['open']);
      else expect(events.at(-1)).toBe('end');
      if (token === 'silent-tail-slow-done') expect(events).toContain('Working on the wrap-up.');
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
});
