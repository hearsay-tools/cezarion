import { existsSync } from 'node:fs';
import { stall, waitForRelease } from './mock-lifecycle.mjs';
import { silentNudge } from './mock-nudge.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = (...parts) => ({ kind: 'text', parts });
const open = options => ({ kind: 'open', ...options });
const end = options => ({ kind: 'end', ...options });
function tools() {
  return import('./mock-ci-tool.mjs');
}
const done = (context, message) => async () => message + await context.lifecycle((await tools()).DONE);
const ask = (context, questions) => async () => 'Pick one.' + await context.lifecycle((await tools()).ask(questions));
const QUESTIONS = [{ header: 'Library', question: 'Which test library?', multiSelect: false, options: [{ label: 'Vitest', description: 'Use the existing test runner' }, { label: 'Node test', description: 'Use node:test' }] }];
const tool = (id, name, input, output) => ({ id, name, input, output, isError: false });
const calls = call => [{ kind: 'toolStart', call }, { kind: 'toolEnd', call }];

/** Shared post-park gate. The encoder keeps child attribution and native barriers. */
export async function afterParityPark(prompt) {
  const gate = /parity-release=([^\s"\\]+)/.exec(prompt)?.[1];
  if (!gate) throw new Error('post-park scenario requires a release path');
  while (!existsSync(gate)) await sleep(10);
}

/**
 * A steering window: the steer-tool hold, and the tail after a turn's last model call (steer-late,
 * hold). With CEZ_MOCK_STEER_GATE set, the window stays open until that file exists, so a test
 * decides when the turn moves on instead of a timer (hearsay-tools/cezarion#2991). Unset, the
 * window keeps its native hold or its timer.
 */
function steerWindow(ms, nativeHold) {
  const gate = process.env.CEZ_MOCK_STEER_GATE;
  if (!gate) return nativeHold ? nativeHold() : sleep(ms);
  return (async () => {
    const deadline = Date.now() + 15_000;
    while (!existsSync(gate)) {
      if (Date.now() > deadline) throw new Error('CEZ_MOCK_STEER_GATE was not created');
      await sleep(10);
    }
  })();
}

/** Await only a pending operation: consecutive synchronous steps stay in one tick. */
export function play(scenario, encoder) {
  const steps = scenario.steps[Symbol.iterator]();
  function advance() {
    for (let next = steps.next(); !next.done; next = steps.next()) {
      const result = perform(next.value, encoder);
      if (result && typeof result.then === 'function') return result.then(advance);
    }
    return scenario.result ?? 'handled';
  }
  return advance();
}

function perform(step, encoder) {
  if (step.kind === 'effect') return step.run();
  if (step.kind === 'sleep') return sleep(step.ms);
  if (step.kind === 'hold') return steerWindow(step.ms, encoder.hold && (() => encoder.hold(step)));
  if (step.kind === 'window') return steerWindow(step.ms);
  if (step.kind === 'release') return waitForRelease(step.fallbackMs, step.suffix);
  if (step.kind === 'park') return afterParityPark(step.prompt);
  if (step.kind === 'stall') return stall(step.prompt, { closeInput: encoder.closeInput });
  if (step.kind === 'text') return sendParts(step, encoder);
  if (step.kind === 'readSteers') {
    const steers = encoder.readSteers(step);
    if (steers && typeof steers.then === 'function') return steers.then(value => step.receive?.(value));
    return step.receive?.(steers);
  }
  if (step.kind === 'child') return encoder.child(step, childEncoder => play({ steps: step.steps }, childEncoder));
  return encoder[step.kind](step);
}

function sendParts(step, encoder) {
  const parts = step.parts.map(part => typeof part === 'function' ? part() : part);
  if (parts.some(part => part && typeof part.then === 'function')) {
    return Promise.all(parts).then(parts => encoder.text({ ...step, parts }));
  }
  return encoder.text({ ...step, parts });
}

const held = (reply, fallbackMs = 400) => [open(), { kind: 'release', fallbackMs }, text(reply), end()];
const hold = gated => [open(), gated ? { kind: 'release', fallbackMs: 250 } : { kind: 'sleep', ms: 250 }, text(`parity ${gated ? 'hold-gated' : 'hold'}: content after the pause`), { kind: 'window', ms: 250 }, end()];

function* busy(prompt, context) {
  yield* progress(prompt);
  for (let i = 0; i < 24; i++) {
    yield { kind: 'progress' };
    yield { kind: 'sleep', ms: 100 };
  }
  yield text(done(context, 'busy complete'));
  yield end();
}

function* progress(prompt) {
  const gated = prompt.includes('mock:gate-prompt-ack');
  if (gated) {
    yield { kind: 'stall', prompt };
    // This gate belongs to scenario timing; acknowledgement belongs to open().
    while (!existsSync('input-ack.release')) yield { kind: 'sleep', ms: 10 };
  }
  yield open();
  if (!gated) yield { kind: 'stall', prompt };
}

function* silentSteps(prompt, context) {
  // Loaded only for a selected scenario; ordinary dry-run dispatch stays synchronous.
  let silent;
  yield effect(async function loadSilent() {
    silent = await import('./mock-silent-tail.mjs');
    silent.noteSilentTailPrompt(prompt);
  });
  const cursorSilent = context.runner === 'cursor' && silent.finalMessageNudgeKind() === 'silent';
  if (silent.isFinalMessageNudge(prompt)) {
    const kind = silent.finalMessageNudgeKind();
    yield open({ ackOnly: true });
    if (kind === 'ack-only') return;
    const lateStart = kind === 'late-turn-start' && context.runner === 'codex';
    if (kind === 'late' || lateStart) yield { kind: 'release', fallbackMs: silent.LATE_REPLY_MS };
    yield open({ acknowledged: true });
    if (lateStart) yield { kind: 'release', fallbackMs: silent.LATE_TURN_START_HOLD_MS, suffix: '.content' };
    if (kind === 'silent') {
      if (!cursorSilent) yield { kind: 'reasoning', text: silent.SILENT_TAIL_REASONING };
    }
    else {
      if (kind === 'slow-done') {
        yield text(silent.SLOW_DONE_PREFIX);
        yield context.runner === 'cursor' ? { kind: 'release', fallbackMs: silent.SLOW_DONE_TAIL_MS } : { kind: 'sleep', ms: silent.SLOW_DONE_TAIL_MS };
      }
      yield text(() => silent.finalNudgeText(kind === 'slow-done' ? 'done' : kind, context.lifecycle));
    }
    yield end();
    return;
  }
  yield open();
  const toolTail = silent.isToolTailScenario(prompt);
  yield text(toolTail ? silent.TOOL_TAIL_OPENING : silent.SILENT_TAIL_OPENING);
  // Cursor F3 pins this reasoning in read-tool output, with no thinking frames.
  yield* calls(cursorSilent ? tool('tool-silent-read', 'read', { path: 'README.md' }, silent.SILENT_TAIL_REASONING)
    : tool(toolTail ? 'tool-tail-git' : 'tool-silent-gh', 'bash', { command: toolTail ? 'git status --short' : 'gh issue create' }, toolTail ? ' M src/example.ts' : 'created'));
  if (!toolTail && !cursorSilent) yield { kind: 'reasoning', text: silent.SILENT_TAIL_REASONING, index: 1 };
  yield end();
}

// Effects load optional content or update scenario state without touching the encoder.
const effect = run => ({ kind: 'effect', run });

function* multiPr(prompt, context) {
  let shared;
  yield effect(async function loadMultiPr() {
    shared = await import('./mock-multi-pr.mjs');
  });
  yield open();
  yield* calls(tool('multi-read', 'read', { path: 'other.txt' }, shared.unrelatedPr));
  yield { kind: 'reasoning', text: shared.unrelatedPr, complete: true };
  let reply;
  yield effect(async () => { reply = await shared.multiPrText(prompt, context.lifecycle); });
  yield text(reply.slice(0, 5), reply.slice(5));
  yield end();
}

function* turnMessages(prompt) {
  let messages;
  yield effect(async function loadMessages() {
    messages = (await import('./mock-turn-messages.mjs')).turnMessages(prompt);
  });
  yield open();
  for (const message of messages) yield text(message);
  yield end();
}

function* parkedChild(prompt, context) {
  const task = tool('toolu_park_task', 'task', { agent: 'explore', task: 'Review the change' }, 'ParkReviewer: running');
  yield open();
  yield { kind: 'toolStart', call: task };
  yield { kind: 'child', id: 'ParkReviewer', phase: 'start', steps: [text('Child review started.')] };
  yield { kind: 'toolEnd', call: task };
  yield text(async () => 'Watching the child.' + await context.lifecycle((await tools()).wait()));
  yield end();
  yield { kind: 'park', prompt };
  yield { kind: 'child', id: 'ParkReviewer', phase: 'end', steps: [...calls(tool('toolu_park_read', 'read', { path: 'README.md' }, 'mock file')), text('Post-park child update processed.')] };
}

function* deferredOpening(prompt) {
  yield open({ ackOnly: true, agentStart: prompt.includes(':late-ack') });
  yield effect(async function delayStart() {
    await (await import('./mock-deferred-turn-start.mjs')).deferredTurnStart();
  });
  yield open({ acknowledged: true, agentStarted: prompt.includes(':late-ack') });
}

function* deferredReply(prompt, context) {
  if (has(prompt, 'cezar-wait') && !context.unsupported?.includes('cezar-wait')) {
    yield* waitReply(prompt, context, deferredOpening(prompt));
  } else {
    yield* deferredOpening(prompt);
    yield { kind: 'reply', prompt };
  }
}

/** Register the wait before admission; the supplied opening preserves native timing. */
function* waitReply(prompt, context, opening) {
  let reply;
  yield effect(async () => { reply = `Investigating: ${prompt}${await context.lifecycle((await tools()).wait())}`; });
  yield* opening;
  yield text(reply);
  yield* calls(tool('tool-1', 'read', { path: 'README.md' }, 'mock file'));
  yield end();
}

const scenario = (name, steps, options = {}) => ({ name, beforeFailure: false, steps, ...options });
const has = (prompt, name) => prompt.includes(`mock:${name}`);

function* autonomous(prompt, context) {
  let shared;
  yield effect(async function loadAutonomous() {
    shared = await import('./mock-autonomous.mjs');
  });
  yield open();
  yield text(() => shared.autonomousReply(prompt, context.lifecycle));
  yield end();
}

function autonomousVariant(prompt) {
  if (has(prompt, 'autonomous-cezar-ask-cap')) return 'cezar-ask-cap';
  if (has(prompt, 'autonomous-cap')) return 'cap';
}

function earlyScenario(prompt, context) {
  const matches = name => has(prompt, name) && !context.unsupported?.includes(name.replace(/:$/, ''));
  if (matches('autonomous') || !context.unsupported?.includes('autonomous') && prompt.startsWith('Continue working autonomously until the task is fully complete.')) {
    return scenario('autonomous', autonomous(prompt, context), { early: true, beforeFailure: true, variant: autonomousVariant(prompt) });
  }
  if (matches('silent-tail') || matches('tool-tail') || !context.unsupported?.includes('silent-tail') && silentNudge(prompt)) {
    return scenario(matches('tool-tail') ? 'tool-tail' : 'silent-tail', silentSteps(prompt, context), { early: true, beforeFailure: true });
  }
  if (matches('crash-stderr')) {
    return scenario('crash-stderr', [effect(() => context.crash(prompt))], { early: true, beforeFailure: true, result: matches('crash-stderr-clean') ? 'continue' : 'handled' });
  }
}

function* steerTool(context) {
  const call = tool('tool-steer', 'bash', { command: 'wait' }, 'waited');
  let admitted = [];
  yield open();
  yield { kind: 'toolStart', call };
  yield { kind: 'hold', ms: Number(process.env.CEZ_MOCK_STEER_MS ?? 600) };
  yield { kind: 'toolEnd', call };
  yield { kind: 'readSteers', receive: texts => { admitted = texts ?? []; } };
  // Both versions are pinned: Claude/Codex echo steers; pi/OMP finish in plain text.
  const echoes = context.runner === 'claude' || context.runner === 'codex';
  yield text(['steer tool done', ...(echoes ? admitted.map(value => `saw: ${value}`) : [])].join('\n'));
  yield end();
}

function beforeFailureScenario(prompt, context) {
  const matches = name => has(prompt, name) && !context.unsupported?.includes(name.replace(/:$/, ''));
  if (matches('ack-only')) return scenario('ack-only', [open({ ackOnly: true })], { beforeFailure: true });
  for (const [name, method] of [['cezar-tool', 'toolPrompt'], ['ci-wait', 'ciPrompt']]) {
    if (matches(name)) return scenario(name, [open(), text(() => context[method](prompt)), end()], { beforeFailure: true });
  }
  if (matches('steer-tool')) return scenario('steer-tool', steerTool(context), { beforeFailure: true });
  if (matches('steer-late')) return scenario('steer-late', [open(), text('late window: final message already sent'), { kind: 'readSteers', late: true }, { kind: 'window', ms: 300 }, end()], { beforeFailure: true });
  if (matches('multi-pr-refs')) return scenario('multi-pr-refs', multiPr(prompt, context), { beforeFailure: true });
  if (matches('turn-messages:')) return scenario('turn-messages', turnMessages(prompt), { beforeFailure: true });
  if (matches('agent-echo')) return scenario('agent-echo', [open(), text(prompt), end()], { beforeFailure: true });
}

/**
 * Provider failures, one error class each (hearsay-tools/squawk#3337). `provider-error` above is a
 * request the provider rejects as invalid (HTTP 400), which fails the run. These are failures the
 * same request can survive later, so Cezar holds the run and retries it. Each mock's `end` writes
 * the kind in its own native error shape.
 */
export const PROVIDER_HOLD_SCENARIOS = [
  ['provider-unavailable', 'unavailable'],
  ['provider-rate-limit', 'rate-limit'],
  ['provider-not-found', 'not-found'],
  ['provider-credit', 'credit'],
];

function trailingScenario(prompt, context) {
  const matches = name => has(prompt, name) && !context.unsupported?.includes(name.replace(/:$/, ''));
  if (matches('provider-error') && !context.nativeFailureControl) return scenario('provider-error', [open(), end({ error: 'provider' })]);
  for (const [name, error] of PROVIDER_HOLD_SCENARIOS) if (matches(name)) return scenario(name, [open(), end({ error })]);
  if (matches('hold-cezar-done')) return scenario('hold-cezar-done', held(done(context, 'parity hold-done: content after the pause')));
  if (matches('hold-cezar-ask')) return scenario('hold-cezar-ask', held(ask(context)));
  if (matches('cezar-done') || !context.unsupported?.includes('cezar-done') && context.session.resumeAfterAsk && prompt.trim() === 'Library: Vitest') {
    return scenario('cezar-done', [effect(() => { context.session.resumeAfterAsk = false; }), open(), text(done(context, context.runner === 'cursor' ? 'Done.' : 'parity done: the task is complete')), end()]);
  }
  if (matches('cezar-ask')) {
    return scenario('cezar-ask', [effect(() => { context.session.resumeAfterAsk = matches('resume-cezar-done'); }), open(), text(ask(context, QUESTIONS)), end()]);
  }
  if (matches('busy-progress')) return scenario('busy-progress', busy(prompt, context));
  if (matches('no-progress')) return scenario('no-progress', progress(prompt));
  if (matches('hold-gated')) return scenario('hold-gated', hold(true));
  if (matches('hold')) return scenario('hold', hold(false));
  if (matches('subagent-after-park')) return scenario('subagent-after-park', parkedChild(prompt, context));
  if (matches('deferred-turn-start')) return scenario('deferred-turn-start', deferredReply(prompt, context));
  if (matches('cezar-wait')) return scenario('cezar-wait', waitReply(prompt, context, [open({ ackOnly: true }), open({ acknowledged: true })]));
}

/** First match wins. A wire declares genuine gaps rather than implementing a partial script. */
export function scenarioFor(prompt, context) {
  for (const select of [earlyScenario, beforeFailureScenario, trailingScenario]) {
    const selected = select(prompt, context);
    if (selected && !context.unsupported?.includes(selected.name)) return selected;
  }
}
