// Manual real-harness probe for hearsay-tools/cezarion#1307: what does pi or omp load at startup
// when cezar starts it? Prints the skills and commands the runner lists, the system prompt of its
// first model request, the marker files the fixture's extensions and MCP servers wrote, and the
// trust.json state.
//
// Spends NO paid session: a spy model provider on 127.0.0.1 answers every request. Never run by CI
// or `npm test`, and never packed (it lives outside packages/). Usage, from the repo root:
//   node_modules/.bin/tsx .ai/scripts/probe-startup.ts <pi|omp> [fixture-dir] [-- extra args]
// Extra args go after cezar's argv, e.g. `-- --approve` for pi in a folder trusted for this run.
// CEZ_PI_BIN and CEZ_OMP_BIN pick the binary, as they do for cezar.
//
// Isolation: everything lives in one scratch root (printed first), with home/, the agent dir
// home/.pi/agent or home/.omp/agent, and project/. The child env holds only PATH, LANG, TERM,
// TMPDIR, the scratch HOME, PI_CODING_AGENT_DIR and PI_OFFLINE=1: no provider keys, no XDG_* and no
// OMP_PROFILE, PI_PROFILE or PI_CONFIG_DIR. The probe refuses to start when cezar's own
// agentHomePaths() resolves the agent dir outside the scratch root. pi and omp also search every
// ancestor of project/ (pi for context files such as AGENTS.md, omp for .omp/agents,
// .claude/agents and more), so the scratch root never sits under the real home: when TMPDIR does,
// the probe uses /tmp. A run therefore reads and writes nothing under the real ~/.pi or ~/.omp.
// The ancestor-context record lists every context file pi still finds above project/.
//
// The argv is cezar's: buildPiArgs or buildOmpArgs on a spec with the shipped default tools
// (allowedToolsForStep), model spy/spy-model and PROBE_SYSTEM_PROMPT. pi also gets --offline.
//
// Fixture: a project directory, copied into project/ (git init runs there when it has no .git),
// so the fixture itself never changes. Without fixture-dir the probe writes the built-in fixture
// below, which holds one of each:
//   .agents/skills/<name>/SKILL.md   shared skills (pi offers an untrusted folder's through
//                                    cezar's pi-project-skills extension)
//   .pi/skills/<name>/SKILL.md       pi skills
//   .omp/skills/<name>/SKILL.md      omp skills
//   .pi/extensions/*.ts              pi extensions (trust-gated in pi)
//   .omp/extensions/*.ts             omp extensions
//   .pi/mcp.json, .omp/mcp.json      MCP servers ({"mcpServers": {...}}; trust-gated in pi)
//
// Markers: an extension or MCP server shows it ran by writing a file into its working directory,
// the project root. The built-in ones write PROBE-MARKER-<source>. The probe reports every file
// outside .git that appeared or changed in project/ during the run, so any fixture can use any name.
//
// Output: one JSON line per record (scratch, ancestor-context, argv, end, skills, commands,
// requests, markers, trust, and stderr when the run did not settle), then the system prompt of
// the first request that carries the probe's user prompt, as plain text. Exit 0 once it settled.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentRunSpec } from '../../packages/cezar/src/core/agent-runner.ts';
import { buildOmpArgs } from '../../packages/cezar/src/core/omp-runner.ts';
import { buildPiArgs } from '../../packages/cezar/src/core/pi-runner.ts';
import { agentHomePaths } from '../../packages/cezar/src/paths.ts';
import { allowedToolsForStep } from '../../packages/cezar/src/workflows/types.ts';

type Frame = Record<string, unknown>;
type SpyRequest = { path: string; body: Frame };

const USER_PROMPT = 'PROBE-USER-PROMPT: reply with one word.';
const PROBE_SYSTEM_PROMPT = 'PROBE-SYSTEM-PROMPT: cezar appends this line.';
const SPY_KEY = 'spy-not-a-secret';
const REPLY = 'probe-ok';
const HANG_GUARD_MS = 60_000; // bound: a startup that never settles still prints what it saw
const KILL_GRACE_MS = 2_000;

const RUNNERS = {
  pi: {
    bin: process.env.CEZ_PI_BIN ?? 'pi',
    agentDir: (home: string) => join(home, '.pi', 'agent'),
    argv: (spec: AgentRunSpec) => [...buildPiArgs(spec), '--offline'],
    // pi 1.0.4 answers get_commands with its full list once resources_discover has run.
    listsCommands: 'rpc',
    settled: 'agent_settled',
    writeProvider: (agentDir: string, baseUrl: string) => writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: { spy: { baseUrl, api: 'openai-completions', apiKey: SPY_KEY, models: [{ id: 'spy-model' }] } },
    }, null, 2)),
  },
  omp: {
    bin: process.env.CEZ_OMP_BIN ?? 'omp',
    agentDir: (home: string) => join(home, '.omp', 'agent'),
    argv: (spec: AgentRunSpec) => buildOmpArgs(spec),
    // omp 18.8.0 answers get_commands with "Unknown command" and pushes available_commands_update.
    listsCommands: 'event',
    settled: 'session_settled',
    writeProvider: (agentDir: string, baseUrl: string) => writeFileSync(join(agentDir, 'models.yml'), [
      'providers:', '  spy:', `    baseUrl: ${baseUrl}`, '    api: openai-completions', `    apiKey: ${SPY_KEY}`, '    models:',
      '      - id: spy-model', '        name: spy-model', '        reasoning: false', '        input: [text]',
      '        contextWindow: 128000', '        maxTokens: 4096',
      '        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }', '',
    ].join('\n')),
  },
} as const;
type RunnerName = keyof typeof RUNNERS;

const skillFile = (name: string, where: string) =>
  `---\nname: ${name}\ndescription: Probe skill from ${where}. Never use it.\n---\n\nProbe skill body.\n`;
// Written at module load, so the marker shows the extension loaded even if it registers nothing.
const extensionFile = (source: string) =>
  `import { writeFileSync } from 'node:fs';\nwriteFileSync('PROBE-MARKER-${source}', 'loaded\\n');\nexport default function () {}\n`;
const mcpFile = (source: string) => JSON.stringify({
  mcpServers: { probe: { command: 'node', args: ['-e', `require('node:fs').writeFileSync('PROBE-MARKER-${source}', 'started\\n')`] } },
}, null, 2);

const BUILTIN_FIXTURE: Record<string, string> = {
  '.agents/skills/probe-agents-skill/SKILL.md': skillFile('probe-agents-skill', '.agents/skills'),
  '.pi/skills/probe-pi-skill/SKILL.md': skillFile('probe-pi-skill', '.pi/skills'),
  '.omp/skills/probe-omp-skill/SKILL.md': skillFile('probe-omp-skill', '.omp/skills'),
  '.pi/extensions/probe-marker.ts': extensionFile('pi-extension'),
  '.omp/extensions/probe-marker.ts': extensionFile('omp-extension'),
  '.pi/mcp.json': mcpFile('pi-mcp'),
  '.omp/mcp.json': mcpFile('omp-mcp'),
};

const rec = (kind: string, detail: unknown) => console.log(JSON.stringify({ kind, detail }));

function parseArgs(argv: string[]): { runner: RunnerName; fixture?: string; extra: string[] } {
  const split = argv.indexOf('--');
  const [runner, fixture, ...rest] = split < 0 ? argv : argv.slice(0, split);
  if (!(runner === 'pi' || runner === 'omp') || rest.length > 0) {
    console.error('usage: probe-startup.ts <pi|omp> [fixture-dir] [-- extra runner args]');
    process.exit(2);
  }
  return { runner, fixture: fixture && resolve(fixture), extra: split < 0 ? [] : argv.slice(split + 1) };
}

function prepareProject(project: string, fixture: string | undefined): void {
  if (fixture) cpSync(fixture, project, { recursive: true });
  else for (const [path, text] of Object.entries(BUILTIN_FIXTURE)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  if (!existsSync(join(project, '.git'))) execFileSync('git', ['init', '-q'], { cwd: project });
}

/** Every file under `root` outside .git, keyed by relative path, with its size and mtime. */
function snapshot(root: string, dir = root, files = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git') snapshot(root, path, files);
    else if (entry.isFile()) files.set(relative(root, path), `${statSync(path).size}:${statSync(path).mtimeMs}`);
  }
  return files;
}

const isInside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** TMPDIR, or /tmp when TMPDIR lies under the real home, which the runners' ancestor walks would reach. */
const scratchBase = () => isInside(homedir(), tmpdir()) ? '/tmp' : tmpdir();

function probeEnv(home: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
  for (const name of ['PATH', 'LANG', 'TERM', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
  return env;
}

/** A streamed chat completion of REPLY, the reply both runners read through openai-completions. */
function chatReply(res: ServerResponse): void {
  const chunk = (delta: Frame, finish: string | null) =>
    ({ id: 'spy', object: 'chat.completion.chunk', created: 0, model: 'spy-model', choices: [{ index: 0, delta, finish_reason: finish }] });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const data of [
    chunk({ role: 'assistant', content: REPLY }, null),
    { ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]) res.write(`data: ${JSON.stringify(data)}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** A spy OpenAI-compatible provider: records every request and answers each with REPLY. */
async function startSpy(): Promise<{ baseUrl: string; requests: SpyRequest[] }> {
  const requests: SpyRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body: Frame = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
      requests.push({ path: `${req.method} ${req.url}`, body });
      if (req.url?.endsWith('/chat/completions')) return chatReply(res);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'spy-model' }] }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => textOf((part as Frame)?.text ?? '')).join('\n') : '';

/** The system and developer messages of a chat-completions request body. */
function systemPromptOf(body: Frame): string {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Frame[];
  return messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n\n');
}

/**
 * One line per listed entry, `<source>:<name> [scope] path`. pi lists `{name, source, sourceInfo:
 * {path, scope}}` and names a skill `skill:<name>`; omp lists `{name, source}` with no path.
 */
function describeCommands(commands: unknown): { skills: string[]; commands: string[] } {
  const list = (Array.isArray(commands) ? commands : []) as Frame[];
  const describe = (c: Frame) => {
    const info = (c.sourceInfo ?? {}) as Frame;
    return [`${c.source}:${String(c.name).replace(/^skill:/, '')}`, info.scope && `[${info.scope}]`, info.path].filter(Boolean).join(' ');
  };
  return { skills: list.filter((c) => c.source === 'skill').map(describe), commands: list.filter((c) => c.source !== 'skill').map(describe) };
}

/** Context files above `dir`, under the names pi 1.0.4 reads from every ancestor (resource-loader.js). */
function ancestorContextFiles(dir: string): string[] {
  const found: string[] = [];
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
      if (existsSync(join(parent, name))) found.push(join(parent, name));
    }
    if (dirname(parent) === parent) return found;
  }
}

/** The agent dir starts empty, so a trust.json there is one the runner wrote during the run. */
function reportChanges(project: string, before: Map<string, string>, trustPath: string): void {
  const after = snapshot(project);
  rec('markers', [...after].filter(([path, stamp]) => before.get(path) !== stamp).map(([path]) => path).sort());
  rec('trust', existsSync(trustPath) ? { path: trustPath, state: 'created', content: readFileSync(trustPath, 'utf8') } : { path: trustPath, state: 'absent' });
}

const { runner: name, fixture, extra } = parseArgs(process.argv.slice(2));
const runner = RUNNERS[name];
const scratch = mkdtempSync(join(scratchBase(), `probe-startup-${name}-`));
const home = join(scratch, 'home');
const project = join(scratch, 'project');
const agentDir = runner.agentDir(home);
mkdirSync(agentDir, { recursive: true });
mkdirSync(project);
prepareProject(project, fixture);
const env = probeEnv(home, agentDir);
const resolvedAgentDir = agentHomePaths(env)[name];
if (!isInside(scratch, resolvedAgentDir)) {
  console.error(`refusing to start: cezar resolves the ${name} agent dir to ${resolvedAgentDir}, outside ${scratch}`);
  process.exit(1);
}
const spy = await startSpy();
runner.writeProvider(agentDir, spy.baseUrl);
const trustPath = join(agentDir, 'trust.json');
const before = snapshot(project);
const spec: AgentRunSpec = {
  userPrompt: USER_PROMPT, cwd: project, model: 'spy/spy-model',
  allowedTools: allowedToolsForStep(undefined, name), systemPrompt: PROBE_SYSTEM_PROMPT,
};
const argv = [...runner.argv(spec), ...extra];
rec('scratch', scratch);
rec('ancestor-context', ancestorContextFiles(project));
rec('argv', [runner.bin, ...argv]);

const child = spawn(runner.bin, argv, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
let listed: unknown;
let finished = false;
const write = (frame: Frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);

function finish(why: string): void {
  if (finished) return;
  finished = true;
  rec('end', why);
  const { skills, commands } = describeCommands(listed);
  rec('skills', skills);
  rec('commands', commands);
  rec('requests', spy.requests.map((request) => request.path));
  reportChanges(project, before, trustPath);
  if (why !== 'settled') rec('stderr', stderr.slice(-4000));
  const first = spy.requests.find((request) => JSON.stringify(request.body).includes(USER_PROMPT));
  console.log(`--- system prompt (${first ? first.path : 'no request carried the probe prompt'}) ---`);
  console.log(first ? systemPromptOf(first.body) : '');
  console.log('--- end system prompt ---');
  const exit = () => process.exit(why === 'settled' ? 0 : 1);
  // A spawn that failed has no process to wait for: it emits 'error' and 'close', never 'exit'.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return exit();
  child.once('exit', exit);
  child.stdin.end();
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
}

function onFrame(frame: Frame): void {
  if (finished) return;
  if (frame.type === 'available_commands_update') listed = frame.commands;
  else if (frame.type === 'response' && frame.success === false) {
    rec('rpc-error', frame);
    // A failed listing must not read as a settled probe that found no commands.
    if (frame.command === 'get_commands') finish('get_commands failed');
  } else if (frame.type === 'response' && frame.command === 'get_commands') {
    listed = (frame.data as Frame | undefined)?.commands;
    finish('settled');
  } else if (frame.type === 'extension_error' || frame.type === 'extension_ui_request') {
    rec(String(frame.type), frame);
  } else if (frame.type === runner.settled) {
    if (runner.listsCommands === 'rpc') write({ id: 'probe-commands', type: 'get_commands' });
    else finish('settled');
  }
}

createInterface({ input: child.stdout }).on('line', (line) => {
  let frame: Frame;
  try { frame = JSON.parse(line) as Frame; } catch { return; } // a non-JSON line is pi or omp logging
  onFrame(frame);
});
// A runner that exits at once fails the probe's stdin writes with EPIPE; 'close' reports that exit
// once stderr is fully read.
child.stdin.on('error', () => {});
child.on('error', (error) => { stderr += String(error); finish('spawn failed'); });
child.on('close', (code, signal) => finish(`exited early (${code ?? signal})`));
write({ id: 'probe-prompt', type: 'prompt', message: USER_PROMPT });
setTimeout(() => finish('hang guard'), HANG_GUARD_MS).unref();
