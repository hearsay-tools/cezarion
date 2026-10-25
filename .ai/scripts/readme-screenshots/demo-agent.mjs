#!/usr/bin/env node
// A scripted Claude Code for the README screenshots (hearsay-tools/cezarion#1456). The capture
// command runs the cockpit with CEZ_DRY_RUN=1 and points CEZ_CLAUDE_BIN at a launcher for this
// file, so every task plays a realistic stream-json turn from scenarios.mjs: real tool calls,
// and a real edit in the task's worktree, so the diff counts the cockpit shows are real. The
// bundled packages/cezar/scripts/mock-claude.mjs stays as it is: its replies name their test
// scenarios, which a gallery image must not show.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withoutSessionContext } from '../../../packages/cezar/scripts/mock-session-context.mjs';
import { FOLLOW_UP_REPLY, editedText, pickScenario, testText, turnScript } from './scenarios.mjs';

/** `--help` names the options cezar detects before it passes them (#505). */
export const HELP_TEXT = 'Usage: claude [options]\n  --input-format <format>\n  --replay-user-messages  Re-emit user messages from stdin back on stdout\n';
/** What `claude --version` prints, for a cockpit that probes the binary. */
export const VERSION_TEXT = '2.1.0 (Claude Code)\n';

/**
 * One stdin line as a message: a user turn with its text, a control request, or null for a
 * line the agent ignores.
 */
export function parseLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (message?.type === 'control_request') return { kind: 'control', requestId: message.request_id, subtype: message.request?.subtype };
  if (message?.type !== 'user') return null;
  const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  return { kind: 'user', text: withoutSessionContext(text), raw: text, uuid: typeof message.uuid === 'string' ? message.uuid : undefined };
}

/** The answer to a control request: the model list for `list_models`, plain success otherwise. */
export function controlResponse(request) {
  const response = request.subtype === 'list_models'
    ? { models: ['opus', 'sonnet', 'haiku'].map((value) => ({ value, displayName: value })) }
    : {};
  return { type: 'control_response', response: { subtype: 'success', request_id: request.requestId, response } };
}

/**
 * Write the step's change into the worktree. The test file is new; when one exists already,
 * the test is appended, so the diff never deletes a whole file.
 */
export function applyChange(step, scenario, cwd) {
  const path = join(cwd, step.write ? scenario.test : scenario.file);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  mkdirSync(dirname(path), { recursive: true });
  if (step.write) appendFileSync(path, before ? `\n${testText(scenario)}` : testText(scenario));
  else writeFileSync(path, editedText(before, scenario));
}

let toolIds = 0;

/**
 * A tool call, its worktree change, and its result after `ms`. A `hold` step stays in the call
 * until the session closes and returns true: the turn ends there, with nothing left to read it.
 */
async function playTool(step, ctx) {
  const id = `toolu_${process.pid}_${toolIds++}`;
  ctx.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.tool, input: step.input }], usage: { input_tokens: 400, output_tokens: 60 } } });
  if (step.write || step.edit) applyChange(step, ctx.scenario, ctx.cwd);
  if (step.hold) return ctx.closed.then(() => true);
  await ctx.sleep(step.ms);
  ctx.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: step.result }] } });
  return false;
}

/** Assistant text; a step with `result` also ends the turn with the scenario's usage. */
function playSay(step, ctx) {
  ctx.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.say }], usage: { input_tokens: 1200, output_tokens: 160 } } });
  if (!step.result) return;
  const { tokens, cost } = ctx.scenario;
  const usage = { input_tokens: Math.round(tokens * 0.85), output_tokens: Math.round(tokens * 0.15) };
  const failed = step.result === 'error';
  ctx.emit({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, result: step.say, usage, total_cost_usd: cost });
}

/**
 * Play one turn. The first turn of a session plays its scenario's script; every later message
 * (a follow-up or a nudge) gets a short finished reply.
 */
export async function playTurn({ text, first, cwd, emit, sleep: wait = sleep, closed }) {
  const scenario = first ? pickScenario(text) : { tokens: 3_500, cost: 0.04 };
  const steps = first ? turnScript(scenario) : [{ say: FOLLOW_UP_REPLY, result: 'success' }];
  const ctx = { scenario, cwd, emit, sleep: wait, closed };
  for (const step of steps) {
    if (step.tool) {
      if (await playTool(step, ctx)) return;
    } else if (step.say) playSay(step, ctx);
    else await wait(step.pause);
  }
}

/** Run as the agent CLI: stream-json over stdin and stdout until stdin closes. */
export function main(argv = process.argv.slice(2), io = { stdin: process.stdin, stdout: process.stdout, cwd: process.cwd(), exit: process.exit }) {
  if (argv.includes('--help')) return void io.stdout.write(HELP_TEXT);
  if (argv.includes('--version')) return void io.stdout.write(VERSION_TEXT);
  const emit = (event) => io.stdout.write(`${JSON.stringify(event)}\n`);
  // A cockpit that stopped first leaves no reader: end quietly rather than crash on EPIPE.
  io.stdout.on?.('error', () => io.exit(0));
  const replay = argv.includes('--replay-user-messages');
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let queue = Promise.resolve();
  let turns = 0;
  emit({ type: 'system', subtype: 'init' });
  const lines = createInterface({ input: io.stdin });
  lines.on('line', (line) => {
    const message = parseLine(line.trim());
    if (message?.kind === 'control') return void emit(controlResponse(message));
    if (!message) return;
    queue = queue.then(() => {
      if (replay && message.uuid) emit({ type: 'user', isReplay: true, uuid: message.uuid, message: { role: 'user', content: [{ type: 'text', text: message.raw }] } });
      turns += 1;
      return playTurn({ text: message.text, first: turns === 1, cwd: io.cwd, emit, closed });
    });
  });
  // EOF ends the session: release a held live turn, finish it, then exit.
  lines.on('close', () => {
    resolveClosed();
    queue.then(() => io.exit(0));
  });
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) main();
