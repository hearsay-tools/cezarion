import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_IDS, VoiceEngineError, selectVoiceEngine, type EngineQuestion, type VoiceEngineState } from './engine.ts';
import { FakeVoiceEngine } from './fake-engine.ts';
import { JevVoiceEngine } from './jev-engine.ts';

const KEY = 'test-key';
const STATE: VoiceEngineState = {
  sentence: 'open next finished',
  view: { sidebarView: 'active', openTask: false },
  recent: [],
};
const QUESTIONS: Record<string, EngineQuestion> = {
  [QUESTION_IDS.action]: {
    type: 'choice',
    instructions: 'Which action?',
    options: { open: 'Open a task', none: null },
  },
  [QUESTION_IDS.isCommand]: {
    type: 'noul',
    instructions: 'Is this a command?',
    criteria: { true: 'It is', false: 'It is not' },
  },
};
const CANNED = {
  model: 'jev-1.13.0',
  answers: {
    action: { type: 'choice', choice: 'open', confidence: 0.42, probabilities: { open: 0.61, none: 0.39 } },
    is_command: { type: 'noul', noul: 0.95 },
  },
  usage: { input_tokens: 589, output_tokens: 212 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stub(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => jsonResponse(body, status));
}

function engineWith(fetchImpl: typeof fetch): JevVoiceEngine {
  return new JevVoiceEngine({ apiKey: KEY, fetch: fetchImpl });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('JevVoiceEngine', () => {
  it('posts the pinned model with a bearer key', async () => {
    const fetchImpl = stub(CANNED);
    await engineWith(fetchImpl).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toEqual(STATE);
    expect(body.questions).toEqual({
      action: { type: 'choice', instructions: 'Which action?', criteria: { open: 'Open a task', none: null } },
      is_command: { type: 'noul', instructions: 'Is this a command?', criteria: { true: 'It is', false: 'It is not' } },
    });
  });

  it('returns typed answers', async () => {
    const result = await engineWith(stub(CANNED)).decide(
      { state: STATE, questions: QUESTIONS },
      new AbortController().signal,
    );
    expect(result).toEqual({
      answers: {
        action: { type: 'choice', choice: 'open', confidence: 0.42, probabilities: { open: 0.61, none: 0.39 } },
        is_command: { type: 'noul', noul: 0.95 },
      },
      inputTokens: 589,
    });
  });

  it.each([
    ['a malformed noul', { type: 'noul', noul: 2 }],
    ['an unknown type', { type: 'banana' }],
    ['a non-object', 'nope'],
  ])('drops an unasked answer without validating it (%s)', async (_name, extra) => {
    const body = { ...CANNED, answers: { ...CANNED.answers, extra } };
    const result = await engineWith(stub(body)).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal);
    expect(Object.keys(result.answers).sort()).toEqual(['action', 'is_command']);
  });

  it('omits the token count when usage has none, and drops answers nobody asked for', async () => {
    const body = { ...CANNED, usage: {}, answers: { ...CANNED.answers, extra: { type: 'noul', noul: 1 } } };
    const result = await engineWith(stub(body)).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal);
    expect(result.inputTokens).toBeUndefined();
    expect(Object.keys(result.answers).sort()).toEqual(['action', 'is_command']);
  });

  const invalid: [string, (answers: Record<string, unknown>) => Record<string, unknown>][] = [
    ['a choice that was not offered', (a) => ({ ...a, action: { type: 'choice', choice: 'banana', confidence: 1, probabilities: {} } })],
    ['a missing question id', ({ is_command: _omitted, ...rest }) => rest],
    ['a probability above 1', (a) => ({ ...a, action: { type: 'choice', choice: 'open', confidence: 1, probabilities: { open: 1.2 } } })],
    ['a probability for an option that was not offered', (a) => ({ ...a, action: { type: 'choice', choice: 'open', confidence: 1, probabilities: { banana: 0.5 } } })],
    ['a confidence below 0', (a) => ({ ...a, action: { type: 'choice', choice: 'open', confidence: -0.1, probabilities: {} } })],
    ['a noul above 1', (a) => ({ ...a, is_command: { type: 'noul', noul: 3 } })],
    ['an answer of the wrong type', (a) => ({ ...a, is_command: { type: 'choice', choice: 'true', confidence: 1, probabilities: {} } })],
  ];
  it.each(invalid)('rejects %s', async (_name, mutate) => {
    const body = { ...CANNED, answers: mutate(CANNED.answers) };
    const error = await rejection(
      engineWith(stub(body)).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal),
    );
    expect(error).toBeInstanceOf(VoiceEngineError);
    expect((error as VoiceEngineError).code).toBe('invalid-answer');
  });

  it('rejects a body that is not an answer set', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('<html>oops</html>', { status: 200 }));
    const error = await rejection(
      engineWith(fetchImpl).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal),
    );
    expect((error as VoiceEngineError).code).toBe('invalid-answer');
  });

  it('maps 529 to a VoiceEngineError without the key', async () => {
    const error = await rejection(
      engineWith(stub({ error: 'overloaded' }, 529)).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal),
    );
    expect(error).toBeInstanceOf(VoiceEngineError);
    expect((error as VoiceEngineError).code).toBe('http');
    expect((error as VoiceEngineError).status).toBe(529);
    expect(String(error)).not.toContain(KEY);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(KEY);
  });

  it('maps a fetch failure to a network error without the key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed for Bearer ${KEY}`);
    });
    const error = await rejection(
      engineWith(fetchImpl).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal),
    );
    expect((error as VoiceEngineError).code).toBe('network');
    expect(String(error)).not.toContain(KEY);
    expect((error as VoiceEngineError).cause).toBeUndefined();
  });

  it('rejects with the caller reason when the caller aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('request closed');
    const pending = engineWith(hangingFetch()).decide({ state: STATE, questions: QUESTIONS }, controller.signal);
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
  });

  it('rejects at once when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = stub(CANNED);
    const error = await rejection(engineWith(fetchImpl).decide({ state: STATE, questions: QUESTIONS }, controller.signal));
    expect(error).toBe(controller.signal.reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops a call that never answers with a timeout after 5000 ms', async () => {
    vi.useFakeTimers();
    const pending = rejection(engineWith(hangingFetch()).decide({ state: STATE, questions: QUESTIONS }, new AbortController().signal));
    // bound: the engine's own 5000 ms per-call limit, advanced on the fake clock
    await vi.advanceTimersByTimeAsync(5000);
    const error = await pending;
    expect(error).toBeInstanceOf(VoiceEngineError);
    expect((error as VoiceEngineError).code).toBe('timeout');
  });
});

describe('JevVoiceEngine construction', () => {
  it.each([undefined, ''])('refuses a missing key (%j)', (apiKey) => {
    expect(() => new JevVoiceEngine({ apiKey: apiKey as string })).toThrow('TYPESAFE_API_KEY is not set');
  });
});

describe('selectVoiceEngine', () => {
  it('picks the fake under CEZ_DRY_RUN=1, even with a key', () => {
    const engine = selectVoiceEngine({ CEZ_DRY_RUN: '1', TYPESAFE_API_KEY: KEY });
    expect(engine).toBeInstanceOf(FakeVoiceEngine);
    expect(engine.id).toBe('fake');
  });

  it('picks Jev with the key otherwise', () => {
    const engine = selectVoiceEngine({ TYPESAFE_API_KEY: KEY }, stub(CANNED));
    expect(engine).toBeInstanceOf(JevVoiceEngine);
    expect(engine.id).toBe('jev');
  });

  it('throws when Jev is selected without a key', () => {
    expect(() => selectVoiceEngine({})).toThrow('TYPESAFE_API_KEY is not set');
  });
});

/** A fetch that never answers and honors its signal, as the real one does. */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const fail = () => reject(signal.reason);
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
}
