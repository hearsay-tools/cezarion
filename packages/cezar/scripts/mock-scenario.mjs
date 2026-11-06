import { existsSync } from 'node:fs';
import { stall, waitForRelease } from './mock-lifecycle.mjs';
import { silentNudge } from './mock-nudge.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = (...parts) => ({ kind: 'text', parts });
const open = options => ({ kind: 'open', ...options });
const end = options => ({ kind: 'end', ...options });
const tools = () => import('./mock-ci-tool.mjs');
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
  if (step.kind === 'sleep') return sleep(step.ms);
  if (step.kind === 'release') return waitForRelease(step.fallbackMs, step.suffix);
  if (step.kind === 'park') return afterParityPark(step.prompt);
  if (step.kind === 'stall') return stall(step.prompt, { closeInput: encoder.closeInput });
  if (step.kind === 'text') return sendParts(step, encoder);
  if (step.kind === 'child') return encoder.child(step, childEncoder => play({ steps: step.steps }, childEncoder));
  return encoder[step.kind](step);
}

function sendParts(step, encoder) {
  const parts = step.parts.map(part => typeof part === 'function' ? part() : part);
  if (parts.some(part => part && typeof part.then === 'function')) {
    return Promise.all(parts).then(parts => step.prepare ? undefined : encoder.text({ ...step, parts }));
  }
  return step.prepare ? undefined : encoder.text({ ...step, parts });
}

const held = (reply, fallbackMs = 400) => [open(), { kind: 'release', fallbackMs }, text(reply), end()];
const hold = gated => [open(), gated ? { kind: 'release', fallbackMs: 250 } : { kind: 'sleep', ms: 250 }, text(`parity ${gated ? 'hold-gated' : 'hold'}: content after the pause`), { kind: 'sleep', ms: 250 }, end()];

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
  yield textLoader(async () => { silent = await import('./mock-silent-tail.mjs'); silent.noteSilentTailPrompt(prompt); });
  if (silent.isFinalMessageNudge(prompt)) {
    const kind = silent.finalMessageNudgeKind();
    yield open({ ackOnly: true });
    if (kind === 'ack-only') return;
    if (kind === 'late') yield { kind: 'release', fallbackMs: silent.LATE_REPLY_MS };
    yield open({ acknowledged: true });
    if (kind === 'silent') yield { kind: 'reasoning', text: silent.SILENT_TAIL_REASONING };
    else {
      if (kind === 'slow-done') {
        yield text(silent.SLOW_DONE_PREFIX);
        yield { kind: 'sleep', ms: silent.SLOW_DONE_TAIL_MS };
      }
      yield text(() => silent.finalNudgeText(kind === 'slow-done' ? 'done' : kind, context.lifecycle));
    }
    yield end();
    return;
  }
  yield open();
  const toolTail = silent.isToolTailScenario(prompt);
  yield text(toolTail ? silent.TOOL_TAIL_OPENING : silent.SILENT_TAIL_OPENING);
  yield* calls(tool(toolTail ? 'tool-tail-git' : 'tool-silent-gh', 'bash', { command: toolTail ? 'git status --short' : 'gh issue create' }, toolTail ? ' M src/example.ts' : 'created'));
  if (!toolTail) yield { kind: 'reasoning', text: silent.SILENT_TAIL_REASONING, index: 1 };
  yield end();
}

// A zero-part text step resolves scenario data without emitting a message.
const textLoader = load => ({ kind: 'text', parts: [load], prepare: true });

function* multiPr(prompt, context) {
  let shared;
  yield textLoader(async () => { shared = await import('./mock-multi-pr.mjs'); });
  yield open();
  yield* calls(tool('multi-read', 'read', { path: 'other.txt' }, shared.unrelatedPr));
  yield { kind: 'reasoning', text: shared.unrelatedPr, complete: true };
  let reply;
  yield textLoader(async () => { reply = await shared.multiPrText(prompt, context.lifecycle); });
  yield text(reply.slice(0, 5), reply.slice(5));
  yield end();
}

function* turnMessages(prompt) {
  let messages;
  yield textLoader(async () => { messages = (await import('./mock-turn-messages.mjs')).turnMessages(prompt); });
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

function* defaultScenario(prompt, context, deferred) {
  const waiting = prompt.includes('mock:cezar-wait');
  let reply;
  yield textLoader(async () => { reply = `Investigating: ${prompt}${waiting ? await context.lifecycle((await tools()).wait()) : ''}`; });
  yield open({ ackOnly: true, agentStart: deferred && prompt.includes(':late-ack') });
  if (deferred) yield textLoader(async () => (await import('./mock-deferred-turn-start.mjs')).deferredTurnStart());
  yield open({ acknowledged: true, agentStarted: deferred && prompt.includes(':late-ack') });
  yield text(reply);
  yield* calls(tool('tool-1', 'read', { path: 'README.md' }, 'mock file'));
  if (!waiting) yield text('Done with the first pass.');
  yield end();
}

const scenario = (name, steps, options = {}) => ({ name, beforeFailure: false, steps, ...options });
const has = (prompt, name) => prompt.includes(`mock:${name}`);

function* autonomous(prompt, context) {
  let shared;
  yield textLoader(async () => { shared = await import('./mock-autonomous.mjs'); });
  yield open();
  yield text(() => shared.autonomousReply(prompt, context.lifecycle));
  yield end();
}

function earlyScenario(prompt, context) {
  if (has(prompt, 'autonomous') || prompt.startsWith('Continue working autonomously until the task is fully complete.')) {
    return scenario('autonomous', autonomous(prompt, context), { early: true, beforeFailure: true });
  }
  if (has(prompt, 'silent-tail') || has(prompt, 'tool-tail') || silentNudge(prompt)) {
    return scenario(has(prompt, 'tool-tail') ? 'tool-tail' : 'silent-tail', silentSteps(prompt, context), { early: true, beforeFailure: true });
  }
  if (has(prompt, 'crash-stderr')) {
    return scenario('crash-stderr', [textLoader(async () => {
      const { crashWithStderr } = await import('./mock-runner-crash.mjs');
      crashWithStderr(prompt, context.session.malformedFrame);
    })], { early: true, beforeFailure: true, result: has(prompt, 'crash-stderr-clean') ? 'continue' : 'handled' });
  }
}

function beforeFailureScenario(prompt, context) {
  if (has(prompt, 'ack-only')) return scenario('ack-only', [open({ ackOnly: true })], { beforeFailure: true });
  for (const [name, method] of [['cezar-tool', 'toolPrompt'], ['ci-wait', 'ciPrompt']]) {
    if (has(prompt, name)) return scenario(name, [open(), text(async () => (await tools())[method](context.runner, process.argv.slice(2), prompt)), end()], { beforeFailure: true });
  }
  if (has(prompt, 'steer-tool')) {
    const call = tool('tool-steer', 'bash', { command: 'wait' }, 'waited');
    return scenario('steer-tool', [open(), { kind: 'toolStart', call }, { kind: 'sleep', ms: Number(process.env.CEZ_MOCK_STEER_MS ?? 600) }, { kind: 'toolEnd', call }, { kind: 'readSteers' }, text('steer tool done'), end()], { beforeFailure: true });
  }
  if (has(prompt, 'steer-late')) return scenario('steer-late', [open(), text('late window: final message already sent'), { kind: 'readSteers', late: true }, { kind: 'sleep', ms: 300 }, end()], { beforeFailure: true });
  if (has(prompt, 'multi-pr-refs')) return scenario('multi-pr-refs', multiPr(prompt, context), { beforeFailure: true });
  if (has(prompt, 'turn-messages:')) return scenario('turn-messages', turnMessages(prompt), { beforeFailure: true });
  if (has(prompt, 'agent-echo')) return scenario('agent-echo', [open(), text(prompt), end()], { beforeFailure: true });
}

function trailingScenario(prompt, context) {
  if (has(prompt, 'hold-cezar-done')) return scenario('hold-cezar-done', held(done(context, 'parity hold-done: content after the pause')));
  if (has(prompt, 'hold-cezar-ask')) return scenario('hold-cezar-ask', held(ask(context)));
  if (has(prompt, 'cezar-done') || context.session.resumeAfterAsk && prompt.trim() === 'Library: Vitest') {
    context.session.resumeAfterAsk = false;
    return scenario('cezar-done', [open(), text(done(context, 'parity done: the task is complete')), end()]);
  }
  if (has(prompt, 'cezar-ask')) {
    context.session.resumeAfterAsk = has(prompt, 'resume-cezar-done');
    return scenario('cezar-ask', [open(), text(ask(context, QUESTIONS)), end()]);
  }
  if (has(prompt, 'busy-progress')) return scenario('busy-progress', busy(prompt, context));
  if (has(prompt, 'no-progress')) return scenario('no-progress', progress(prompt));
  if (has(prompt, 'hold-gated')) return scenario('hold-gated', hold(true));
  if (has(prompt, 'hold')) return scenario('hold', hold(false));
  if (has(prompt, 'subagent-after-park')) return scenario('subagent-after-park', parkedChild(prompt, context));
  if (has(prompt, 'provider-error')) return scenario('provider-error', [open(), end({ error: 'provider' })]);
  if (has(prompt, 'deferred-turn-start')) return scenario('deferred-turn-start', defaultScenario(prompt, context, true));
  if (has(prompt, 'cezar-wait')) return scenario('cezar-wait', defaultScenario(prompt, context, false));
}

/** First match wins. A wire declares genuine gaps rather than implementing a partial script. */
export function scenarioFor(prompt, context) {
  for (const select of [earlyScenario, beforeFailureScenario, trailingScenario]) {
    const selected = select(prompt, context);
    if (selected && !context.unsupported?.includes(selected.name)) return selected;
  }
}
