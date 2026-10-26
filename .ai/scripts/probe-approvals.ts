// Manual real-harness probe for hearsay-tools/cezarion#1343: does cezar answer Codex's MCP tool
// approvals as AGENT_PROTOCOL.md § MCP tool approvals says? cezar's own server must run with no
// approval request, and another server's tool call must reach cezar as permission.requested and get
// the reply named on the command line (hearsay-tools/cezarion#1294).
//
// Spends ONE paid Codex turn. Never run by CI or `npm test`, and never packed (it lives outside
// packages/). Usage, from the repo root:
//   node_modules/.bin/tsx .ai/scripts/probe-approvals.ts [--answer allow|session|always|decline] [--model <id>]
// --answer picks the option for each MCP tool approval (default allow, "Allow once"); every other
// approval gets "Decline and continue". CEZ_CODEX_BIN picks the binary, as it does for cezar.
//
// Isolation: one scratch root (printed first) holds codex-home/, project/ and the logs. The probe
// drops the session's own CEZ_* and CLAUDE_CODE_* variables first. It keeps CEZ_ENV_PASSTHROUGH and
// CEZ_AGENT_ENV_FULL, which carry the provider key on some hosts (hearsay-tools/cezarion#1296), and
// CEZ_CODEX_BIN. codex-home/config.toml copies only model_provider, model, model_catalog_json and
// the selected [model_providers.<name>] table from the user's $CODEX_HOME/config.toml (or
// ~/.codex/config.toml), and adds the probe_marker server. It holds no approval_policy, so the
// thread runs under Codex's default, and there is no auth.json: the provider's env_key must reach
// Codex through cezar's env allowlist or CEZ_ENV_PASSTHROUGH.
//
// The run uses cezar's own pieces: CodexAppServerRunner, CiToolController (its socket, token and
// ci-wait/mcp.ts server, with stub handlers that record each call) and respondPermission. The
// runner's bin is a tee shim that logs every JSON-RPC line between cezar and codex app-server. The
// prompt asks for one probe_marker call, then one cezar_wait timer.
//
// Output: one JSON line per record: scratch, scratch-config, permission, permission-resolved, text,
// error, end, thread, server-requests, mcp-tool-calls, tool-socket, marker, verdict. Every string
// value copied from the user's config prints as <config>. Exit 0 once the turn ended, 1 otherwise.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { CezarAskAnswer, CezarCancelWaitAnswer, CezarDoneAnswer, Wait } from '../../packages/contract/src/index.ts';
import type { AgentEvent, AgentSession } from '../../packages/cezar/src/core/agent-runner.ts';
import { CodexAppServerRunner } from '../../packages/cezar/src/core/codex-app-server-runner.ts';
import { resolveCodexExecutable } from '../../packages/cezar/src/core/codex-app-server-transport.ts';
import type { UiEvent } from '../../packages/cezar/src/core/ui-events.ts';
import { CiToolController, type CezarToolHandlers, type WaitRegistration } from '../../packages/cezar/src/ci-wait/controller.ts';
import { agentHomePaths } from '../../packages/cezar/src/paths.ts';

type Frame = Record<string, unknown>;
type Toml = { parse(text: string): Frame; stringify(value: Frame): string };

const ANSWERS = {
  allow: 'Allow once',
  session: 'Allow this tool for this session',
  always: 'Always allow this tool (saved in your Codex config)',
  decline: 'Decline and continue',
} as const;
type AnswerName = keyof typeof ANSWERS;
const MCP_APPROVAL_TITLE = 'Codex requests an MCP tool call';
const MARKER = 'probe_marker';
const PROMPT = `This is an approval probe. Make exactly these two tool calls, in this order, and run no shell command:
1. Call the ${MARKER} tool once, with {"note": "approval probe"}.
2. Call the cezar_wait tool once, with {"kind": "timer", "seconds": 60, "note": "approval probe"}.
If a call is refused, still make the next one. Then reply with one line naming each call's result, and end your turn.`;
const HANG_GUARD_MS = 240_000; // bound: a turn that never ends still prints what it saw
const END_GRACE_MS = 15_000; // bound: an ended session that never settles still exits
const TEXT_LIMIT = 200;
// The session's own wiring (CEZ_TOOL_SOCKET, CEZ_HANDOFF_FILE, CLAUDE_CODE_SESSION_ID, …) must not
// reach the run. These host settings stay, as cezar would read them.
const KEPT_ENV = new Set(['CEZ_ENV_PASSTHROUGH', 'CEZ_AGENT_ENV_FULL', 'CEZ_CODEX_BIN']);

// smol-toml is cezar's dependency. It is installed under packages/cezar, which the resolution of a
// file in .ai/scripts does not reach.
const toml = createRequire(new URL('../../packages/cezar/package.json', import.meta.url))('smol-toml') as Toml;

// A dependency-free stdio MCP server with one tool. It appends its start and each call to argv[2].
const MARKER_SERVER = `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (entry) => appendFileSync(process.argv[2], JSON.stringify(entry) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const tool = { name: '${MARKER}', description: 'Records that the approval probe called it.',
  inputSchema: { type: 'object', properties: { note: { type: 'string' } } } };
log({ event: 'started' });
createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: '${MARKER}', version: '1.0.0' } } });
  else if (method === 'tools/list') send({ id, result: { tools: [tool] } });
  else if (method === 'tools/call') {
    log({ event: 'called', tool: params?.name, arguments: params?.arguments });
    send({ id, result: { content: [{ type: 'text', text: 'PROBE-MARKER-OK' }] } });
  } else if (method === 'ping') send({ id, result: {} });
  else send({ id, error: { code: -32601, message: 'method not found' } });
});
`;

// The runner's bin: starts the real codex with the same argv and logs each line, both directions.
const teeShim = (codexBin: string, wireLog: string) => `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const [bin, log] = ${JSON.stringify([codexBin, wireLog])};
const child = spawn(bin, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });
const tee = (from) => {
  let rest = '';
  return (chunk) => {
    const lines = (rest + chunk).split('\\n');
    rest = lines.pop();
    for (const line of lines) if (line) appendFileSync(log, JSON.stringify({ from, line }) + '\\n');
  };
};
const fromCezar = tee('cezar');
const fromCodex = tee('codex');
process.stdin.setEncoding('utf8');
child.stdout.setEncoding('utf8');
process.stdin.on('data', (chunk) => { fromCezar(chunk); child.stdin.write(chunk); });
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
child.stdout.on('data', (chunk) => { fromCodex(chunk); process.stdout.write(chunk); });
child.on('error', (error) => { process.stderr.write(String(error) + '\\n'); process.exit(127); });
child.on('exit', (code, signal) => {
  if (!signal) process.exit(code ?? 0);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
`;

function parseCli(argv: string[]): { answer: AnswerName; model?: string } {
  try {
    const { values } = parseArgs({ args: argv, options: { answer: { type: 'string', default: 'allow' }, model: { type: 'string' } } });
    if (!(values.answer in ANSWERS)) throw new Error(`unknown answer ${values.answer}`);
    return { answer: values.answer as AnswerName, ...(values.model ? { model: values.model } : {}) };
  } catch (error) {
    console.error(`${String(error)}\nusage: probe-approvals.ts [--answer allow|session|always|decline] [--model <id>]`);
    process.exit(2);
  }
}

function scrubSessionEnv(): void {
  for (const name of Object.keys(process.env)) {
    if ((name.startsWith('CEZ_') && !KEPT_ENV.has(name)) || name.startsWith('CLAUDE_CODE_')) delete process.env[name];
  }
}

const isInside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** TMPDIR, or /tmp when TMPDIR lies under the real home: a cezar task's TMPDIR sits inside a checkout. */
const scratchBase = () => isInside(homedir(), tmpdir()) ? '/tmp' : tmpdir();

/** The user's config.toml, parsed; `{}` when it is absent. Never prints the file, which a parse error would quote. */
function readUserConfig(path: string): Frame {
  if (!existsSync(path)) return {};
  try { return toml.parse(readFileSync(path, 'utf8')); } catch {
    console.error(`could not parse ${path}`);
    process.exit(1);
  }
}

/** The provider settings the probe copies; nothing else from the user's config reaches the scratch home. */
function pickProviderSettings(source: Frame): Frame {
  const picked: Frame = {};
  for (const key of ['model_provider', 'model', 'model_catalog_json']) if (source[key] !== undefined) picked[key] = source[key];
  const name = source.model_provider;
  const providers = source.model_providers as Frame | undefined;
  if (typeof name === 'string' && providers?.[name] !== undefined) picked.model_providers = { [name]: providers[name] };
  return picked;
}

/** Every string inside `value`, longest first, so a value that contains another is replaced whole. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' && value.length >= 3) out.push(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, out);
  return out.sort((a, b) => b.length - a.length);
}

function readNdjson(path: string): Frame[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Frame]; } catch { return []; }
  });
}

type WireLine = { from: 'cezar' | 'codex'; message: Frame };

function readWire(path: string): WireLine[] {
  return readNdjson(path).flatMap((entry) => {
    try { return [{ from: entry.from as WireLine['from'], message: JSON.parse(String(entry.line)) as Frame }]; } catch { return []; }
  });
}

/** Each request Codex sent cezar, with the exact reply cezar wrote back, or `none`. */
function serverRequests(wire: WireLine[]): Frame[] {
  const replies = new Map(wire.filter(({ from, message }) => from === 'cezar' && message.method === undefined && message.id !== undefined)
    .map(({ message }) => [String(message.id), message]));
  return wire.filter(({ from, message }) => from === 'codex' && typeof message.method === 'string' && message.id !== undefined)
    .map(({ message }) => {
      const params = (message.params ?? {}) as Frame;
      const reply = replies.get(String(message.id));
      return { method: message.method, id: message.id, server: params.serverName,
        approvalKind: (params._meta as Frame | undefined)?.codex_approval_kind,
        reply: reply ? reply.result ?? { error: reply.error } : 'none' };
    });
}

function mcpToolCalls(wire: WireLine[]): Frame[] {
  return wire.filter(({ from, message }) => from === 'codex' && message.method === 'item/completed')
    .map(({ message }) => (message.params as Frame | undefined)?.item as Frame | undefined)
    .filter((item): item is Frame => item?.type === 'mcpToolCall')
    .map((item) => ({ server: item.server, tool: item.tool, status: item.status, ...(item.error ? { error: item.error } : {}) }));
}

function threadApprovalPolicy(wire: WireLine[]): unknown {
  const start = wire.find(({ from, message }) => from === 'cezar' && message.method === 'thread/start');
  const response = start && wire.find(({ from, message }) => from === 'codex' && message.method === undefined && message.id === start.message.id);
  return (response?.message.result as Frame | undefined)?.approvalPolicy ?? 'not seen';
}

/** cezar's tool socket with stub handlers: each call is recorded, and a timer wait gets a receipt. */
function stubHandlers(calls: Frame[]): CezarToolHandlers {
  const message = 'The approval probe answers cezar_wait timers only.';
  const registerWait: CezarToolHandlers['registerWait'] = async (request, via) => {
    calls.push({ tool: via, request });
    if (request.kind !== 'timer') return { answer: { ok: false, code: 'unavailable', message } } satisfies WaitRegistration;
    const now = new Date();
    const deadline = new Date(now.getTime() + request.seconds * 1000).toISOString();
    const wait: Wait = { id: randomUUID(), source: 'agent', via, registeredAt: now.toISOString(), phase: 'open',
      turnId: 'probe', kind: 'timer', deadline, seconds: request.seconds };
    const open = { wait_id: wait.id, kind: 'timer' as const, summary: 'approval probe timer', deadline };
    return { answer: { ok: true, wait_id: wait.id, kind: 'timer', deadline, open_waits: [open] }, wait };
  };
  return {
    registerWait,
    ask: async (request) => { calls.push({ tool: 'cezar_ask', request }); return { ok: false, code: 'unavailable', message } satisfies CezarAskAnswer; },
    cancelWait: async (request) => { calls.push({ tool: 'cezar_cancel_wait', request }); return { cancelled: false, code: 'unavailable', message } satisfies CezarCancelWaitAnswer; },
    finishTurn: async (request) => { calls.push({ tool: 'cezar_done', request }); return { ok: false, code: 'unavailable', message } satisfies CezarDoneAnswer; },
  };
}

const { answer, model } = parseCli(process.argv.slice(2));
const sourceConfigPath = join(agentHomePaths(process.env).codex, 'config.toml');
scrubSessionEnv();
const codexBin = resolveCodexExecutable();
const scratch = mkdtempSync(join(scratchBase(), 'probe-approvals-'));
const codexHome = join(scratch, 'codex-home');
const project = join(scratch, 'project');
const wireLog = join(scratch, 'wire.ndjson');
const markerLog = join(scratch, 'marker.ndjson');
const markerServer = join(scratch, 'marker-mcp.mjs');
const shim = join(scratch, 'codex-tee.mjs');
mkdirSync(codexHome);
mkdirSync(project);
execFileSync('git', ['init', '-q'], { cwd: project });
writeFileSync(join(project, 'README.md'), 'approval probe\n');
writeFileSync(markerServer, MARKER_SERVER);
writeFileSync(shim, teeShim(codexBin, wireLog));
chmodSync(shim, 0o755);

const provider = pickProviderSettings(readUserConfig(sourceConfigPath));
const copied = stringsOf(provider).map((value) => JSON.stringify(value).slice(1, -1));
const say = (kind: string, detail: unknown) => {
  let line = JSON.stringify({ kind, detail });
  for (const value of copied) line = line.replaceAll(value, '<config>');
  console.log(line);
};
writeFileSync(join(codexHome, 'config.toml'), toml.stringify({
  ...provider, mcp_servers: { [MARKER]: { command: process.execPath, args: [markerServer, markerLog] } },
}));
const written = toml.parse(readFileSync(join(codexHome, 'config.toml'), 'utf8'));
say('scratch', scratch);
say('scratch-config', { source: existsSync(sourceConfigPath) ? 'read' : 'absent', keys: Object.keys(written),
  mcpServers: Object.keys(written.mcp_servers as Frame), approval_policy: 'approval_policy' in written ? 'present' : 'absent' });

const socketCalls: Frame[] = [];
const controller = await CiToolController.start();
const tools = controller.provision(stubHandlers(socketCalls));
let session: AgentSession | undefined;
let answerMissing = false;

function onPermission(event: Extract<UiEvent, { type: 'permission.requested' }>): void {
  const wanted = event.title === MCP_APPROVAL_TITLE ? ANSWERS[answer] : ANSWERS.decline;
  const option = event.options.find((candidate) => candidate.label === wanted);
  say('permission', { title: event.title, offered: event.options.map((candidate) => candidate.label), chosen: option?.label ?? 'not offered' });
  if (!option) { answerMissing = true; session?.end(); return; }
  setImmediate(() => session?.respondPermission?.(event.requestId, option.id));
}

function onUiEvent(event: UiEvent): void {
  if (event.type === 'permission.requested') onPermission(event);
  else if (event.type === 'permission.resolved') say('permission-resolved', event);
}

function onEvent(event: AgentEvent): void {
  if (event.type === 'text') say('text', event.text.slice(0, TEXT_LIMIT));
  else if (event.type === 'error' || event.type === 'note') say(event.type, event.message);
}

function report(): void {
  const wire = readWire(wireLog);
  const requests = serverRequests(wire);
  const calls = mcpToolCalls(wire);
  const marker = readNdjson(markerLog);
  const cezarServer = tools.descriptor.name;
  say('thread', { approvalPolicy: threadApprovalPolicy(wire) });
  say('server-requests', requests);
  say('mcp-tool-calls', calls);
  say('tool-socket', socketCalls);
  say('marker', marker);
  say('verdict', {
    cezarServer,
    cezarApprovalRequests: requests.filter((request) => request.server === cezarServer).length,
    cezarToolCalls: calls.filter((call) => call.server === cezarServer).map((call) => `${call.tool}: ${call.status}`),
    toolSocketSawCall: socketCalls.length > 0,
    markerApprovalReplies: requests.filter((request) => request.server === MARKER).map((request) => request.reply),
    markerToolCalls: calls.filter((call) => call.server === MARKER).map((call) => `${call.tool}: ${call.status}`),
    markerServerCalls: marker.filter((entry) => entry.event === 'called').length,
  });
}

let finished = false;
let guardFired = false;
async function finish(why: string, failed: boolean): Promise<void> {
  if (finished) return;
  finished = true;
  say('end', why);
  report();
  tools.revoke();
  await controller.close();
  process.exit(failed || guardFired || answerMissing ? 1 : 0);
}

session = new CodexAppServerRunner({ bin: shim }).startSession({
  userPrompt: PROMPT, cwd: project, toolGrant: { kind: 'unset' }, ...(model ? { model } : {}), effort: 'low', timeoutMs: HANG_GUARD_MS + END_GRACE_MS,
  cezarTools: tools.descriptor, env: { CODEX_HOME: codexHome, ...tools.env },
}, onEvent, { autoEndAfterFirstTurn: true, onUiEvent });
session.result.then(
  () => finish(guardFired ? 'hang guard' : answerMissing ? `answer "${answer}" not offered` : 'turn ended', false),
  (error) => finish(`session failed: ${String(error)}`, true),
);
setTimeout(() => {
  guardFired = true;
  session?.end();
  setTimeout(() => void finish('hang guard, session never settled', true), END_GRACE_MS).unref();
}, HANG_GUARD_MS).unref();
