#!/usr/bin/env node
// Opt-in vendor probe. It saves only a small allowlisted summary, never a transcript.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';

const { values } = parseArgs({ options: {
  model: { type: 'string' },
  'output-dir': { type: 'string' },
  case: { type: 'string' },
} });
if (!values.model || !values['output-dir'] || !['native-question', 'delegation', 'mcp', 'portable-ask', 'plugins', 'resume-missing', 'fields', 'plugin-lifecycle', 'errors'].includes(values.case)) {
  process.stderr.write('Usage: probe-cursor-print.mjs --model <discovered-id> --output-dir <path> --case native-question|delegation|mcp|portable-ask|plugins|resume-missing|fields|plugin-lifecycle|errors\n');
  process.exit(1);
}

const bin = process.env.CEZ_CURSOR_BIN || 'agent';
const scratch = mkdtempSync(join(tmpdir(), 'cez-cursor-print-probe-'));
const checkout = join(scratch, 'checkout');
const outputDir = resolve(values['output-dir']);

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function runAgent(args, cwd, timeoutMs, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const append = (current, chunk) => {
      if (current.length + chunk.length > 1_048_576) { truncated = true; return current; }
      return current + chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const signalGroup = signal => {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* already gone */ }
    };
    const groupAlive = () => {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0); return true; } catch { return false; }
    };
    const timer = setTimeout(() => { timedOut = true; signalGroup('SIGTERM'); }, timeoutMs);
    const escalation = setTimeout(() => signalGroup('SIGKILL'), timeoutMs + 2_000);
    child.on('error', error => { clearTimeout(timer); clearTimeout(escalation); rejectRun(error); });
    child.on('close', async code => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signalGroup('SIGTERM');
      await new Promise(done => setTimeout(done, 500));
      if (groupAlive()) signalGroup('SIGKILL');
      await new Promise(done => setTimeout(done, 100));
      resolveRun({ code, stdout, stderr, truncated, timedOut, processGroupGone: !groupAlive() });
    });
  });
}

function framesOf(stdout) {
  return stdout.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function toolKindsOf(frames) {
  return [...new Set(frames.flatMap(frame => frame.type === 'tool_call'
    ? Object.keys(frame.tool_call ?? {}).filter(key => key.endsWith('ToolCall')) : []))].sort();
}

function resultOf(frames) {
  return frames.findLast(frame => frame.type === 'result');
}

async function probeNativeQuestion(version) {
  const run = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--allowed-tools', 'ask_question_tool_call',
    'Use the native AskQuestion tool now. Ask me to choose Alpha or Beta. Do not answer it yourself and do not use any other tool.',
  ], checkout, 45_000);

  const frames = framesOf(run.stdout);
  const request = frames.find(frame => frame.type === 'interaction_query' && frame.subtype === 'request' && frame.query_type === 'askQuestionInteractionQuery');
  const response = frames.find(frame => frame.type === 'interaction_query' && frame.subtype === 'response' && frame.query_type === 'askQuestionInteractionQuery');
  const rejection = response?.response?.askQuestionInteractionResponse?.result?.rejected?.reason;
  return {
    schema: 1,
    case: 'native-question',
    cliVersion: version,
    model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--allowed-tools ask_question_tool_call'],
    exitCode: run.code,
    timedOut: run.timedOut,
    outputTruncated: run.truncated,
    nativeQuestionRequested: Boolean(request),
    nativeQuestionAnswered: Boolean(response),
    responseKind: rejection ? 'rejected' : response ? 'other' : 'none',
    rejectionKind: typeof rejection === 'string' && rejection.includes('skipped') ? 'skipped' : rejection ? 'other' : 'none',
    sameSession: Boolean(request && response && request.session_id === response.session_id),
    responseDelayMs: request && response ? response.timestamp_ms - request.timestamp_ms : null,
    outcome: run.code === 0 && !run.timedOut && !run.truncated && request && response && request.session_id === response.session_id && rejection?.includes('skipped')
      ? 'blocked' : request && response ? 'unqualified' : 'inconclusive',
  };
}

const nativeDelegationEntries = [
  'task_tool_call', 'create_agent_tool_call', 'adopt_tool_call',
  'send_to_agent_tool_call', 'send_message_tool_call',
  'get_agent_status_tool_call', 'stop_agent_tool_call',
  'read_agent_transcript_tool_call', 'start_grind_execution_tool_call',
  'start_grind_planning_tool_call',
];

async function discoverSafeAllowedTools() {
  // Cursor validates this public proto-oneof list before inference. The name
  // is deliberately invalid; no model or native worker can run in this step.
  const catalogRun = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--allowed-tools', 'definitelyNotATool', 'Reply OK.',
  ], checkout, 15_000);
  const names = catalogRun.stderr.match(/Expected one of: ([a-z_, ]+)/)?.[1]
    ?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  const safeAllowedTools = names.filter(name => !nativeDelegationEntries.includes(name));
  return { catalogRun, names, safeAllowedTools };
}

async function probeDelegation(version) {
  const { catalogRun, names, safeAllowedTools } = await discoverSafeAllowedTools();

  const firstCanary = randomBytes(16).toString('hex');
  writeFileSync(join(checkout, 'probe-first.txt'), `${firstCanary}\n`, { mode: 0o600 });
  const prompt = name => `Use the native Read tool to read ${name}, then reply with its exact contents. Do not use any other tool.`;
  const first = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--allowed-tools', 'read_tool_call', prompt('probe-first.txt'),
  ], checkout, 45_000);
  const firstFrames = framesOf(first.stdout);
  const firstId = resultOf(firstFrames)?.session_id;

  const secondCanary = randomBytes(16).toString('hex');
  writeFileSync(join(checkout, 'probe-second.txt'), `${secondCanary}\n`, { mode: 0o600 });
  const second = firstId ? await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--resume', firstId,
    '--allowed-tools', 'read_todos_tool_call', prompt('probe-second.txt'),
  ], checkout, 45_000) : undefined;
  const secondFrames = second ? framesOf(second.stdout) : [];

  const thirdCanary = randomBytes(16).toString('hex');
  writeFileSync(join(checkout, 'probe-third.txt'), `${thirdCanary}\n`, { mode: 0o600 });
  const third = firstId && second ? await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--resume', firstId,
    '--allowed-tools', safeAllowedTools.join(','), prompt('probe-third.txt'),
  ], checkout, 45_000) : undefined;
  const thirdFrames = third ? framesOf(third.stdout) : [];

  const firstTools = toolKindsOf(firstFrames);
  const secondTools = toolKindsOf(secondFrames);
  const firstSawCanary = String(resultOf(firstFrames)?.result ?? '').includes(firstCanary);
  const secondSawCanary = String(resultOf(secondFrames)?.result ?? '').includes(secondCanary);
  const thirdTools = toolKindsOf(thirdFrames);
  const thirdSawCanary = String(resultOf(thirdFrames)?.result ?? '').includes(thirdCanary);
  const sameSession = Boolean(firstId && firstId === resultOf(secondFrames)?.session_id
    && firstId === resultOf(thirdFrames)?.session_id);
  const noDelegationEntriesInAllowlist = nativeDelegationEntries.every(name => !safeAllowedTools.includes(name));
  const genericFilterVerified = catalogRun.code === 1 && !catalogRun.timedOut
    && names.includes('task_tool_call') && names.includes('create_agent_tool_call')
    && nativeDelegationEntries.every(name => names.includes(name)) && noDelegationEntriesInAllowlist
    && first.code === 0 && !first.timedOut && !first.truncated
    && firstTools.includes('readToolCall') && firstSawCanary
    && second?.code === 0 && !second.timedOut && !second.truncated
    && !secondTools.includes('readToolCall') && !secondSawCanary
    && third?.code === 0 && !third.timedOut && !third.truncated
    && thirdTools.includes('readToolCall') && thirdSawCanary && sameSession;
  return {
    schema: 1,
    case: 'delegation',
    cliVersion: version,
    model: values.model,
    testedMechanism: '--allowed-tools',
    catalogValidatedBeforeInference: catalogRun.code === 1 && names.includes('task_tool_call'),
    nativeDelegationEntries,
    safeAllowedTools,
    freshReadToolCalled: firstTools.includes('readToolCall'),
    freshReadSucceeded: firstSawCanary,
    resumedReadToolCalled: secondTools.includes('readToolCall'),
    resumedReadSucceeded: secondSawCanary,
    fullAllowlistReadToolCalled: thirdTools.includes('readToolCall'),
    fullAllowlistReadSucceeded: thirdSawCanary,
    noDelegationEntriesInAllowlist,
    sameNativeSession: sameSession,
    directTaskCallAttempted: false,
    outcome: genericFilterVerified ? 'pass' : 'blocked',
  };
}

async function probeMcp(version) {
  const { catalogRun, names, safeAllowedTools } = await discoverSafeAllowedTools();
  const pluginDir = join(checkout, 'cez-probe-plugin');
  mkdirSync(pluginDir);
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'cez-probe-plugin', version: '0.0.1', description: 'Inert local qualification plugin' }));
  writeFileSync(join(pluginDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'cez-probe': {
    type: 'stdio', command: 'node', args: [join(pluginDir, 'server.mjs')],
    env: { CEZ_PROBE_CANARY: '${CEZ_PROBE_CANARY}' },
  } } }));
  writeFileSync(join(pluginDir, 'server.mjs'), `
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./started', import.meta.url), '1');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const end = buffer.indexOf('\\n');
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    let result = {};
    if (request.method === 'initialize') result = {
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'cez-probe', version: '0.0.1' },
    };
    if (request.method === 'tools/list') result = { tools: [{
      name: 'check_env', description: 'Return a hash of an inherited synthetic environment value',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }] };
    if (request.method === 'tools/call') {
      writeFileSync(new URL('./called', import.meta.url), '1');
      result = { content: [{ type: 'text', text: 'env-hash:' + createHash('sha256').update(process.env.CEZ_PROBE_CANARY || '').digest('hex') }], isError: false };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`);

  const runTurn = async (id) => {
    const canary = randomBytes(16).toString('hex');
    const expectedHash = createHash('sha256').update(canary).digest('hex');
    rmSync(join(pluginDir, 'called'), { force: true });
    const run = await runAgent([
      '-p', '--force', '--trust', '--output-format', 'stream-json', '--model', values.model,
      ...(id ? ['--resume', id] : []), '--allowed-tools', safeAllowedTools.join(','),
      '--plugin-dir', pluginDir,
      id ? 'The synthetic environment value changed since the last turn. Call cez-probe check_env again now; the previous hash is stale. Report only the new hash. Do not use another tool.'
        : 'Call the cez-probe MCP check_env tool once and report its hash. Do not use any other tool.',
    ], checkout, 45_000, { ...process.env, CEZ_PROBE_CANARY: canary });
    const frames = framesOf(run.stdout);
    return {
      id: resultOf(frames)?.session_id,
      ok: run.code === 0 && !run.timedOut && !run.truncated && existsSync(join(pluginDir, 'called'))
        && run.stdout.includes(expectedHash) && toolKindsOf(frames).includes('mcpToolCall'),
      mcpToolCalled: toolKindsOf(frames).includes('mcpToolCall'),
      serverCalled: existsSync(join(pluginDir, 'called')),
      environmentHashSeen: run.stdout.includes(expectedHash),
      stderrMentionsApproval: /approv/i.test(run.stderr),
    };
  };
  const first = await runTurn();
  const second = first.id ? await runTurn(first.id) : undefined;
  const catalogSafe = catalogRun.code === 1 && names.includes('mcp_tool_call')
    && nativeDelegationEntries.every(name => names.includes(name) && !safeAllowedTools.includes(name));
  return {
    schema: 1, case: 'mcp', cliVersion: version, model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--allowed-tools <non-agent catalog>', '--plugin-dir <disposable local plugin>', '--resume <exact native id>'],
    environmentBinding: 'MCP env placeholder expanded from per-process environment',
    globalCursorConfigWritten: false, blanketMcpApprovalUsed: false,
    catalogSafe, freshToolCalled: first.mcpToolCalled, freshServerCalled: first.serverCalled,
    freshEnvironmentHashSeen: first.environmentHashSeen,
    resumedToolCalled: second?.mcpToolCalled ?? false, resumedServerCalled: second?.serverCalled ?? false,
    resumedEnvironmentHashSeen: second?.environmentHashSeen ?? false,
    sameNativeSession: Boolean(first.id && first.id === second?.id),
    stderrMentionsApproval: first.stderrMentionsApproval || Boolean(second?.stderrMentionsApproval),
    outcome: catalogSafe && first.ok && second?.ok && first.id === second.id
      && !first.stderrMentionsApproval && !second.stderrMentionsApproval ? 'pass' : 'blocked',
  };
}

async function probePortableAsk(version) {
  const phrase = randomBytes(12).toString('hex');
  const marker = 'CEZ:ASK {"questions":[{"header":"Library","question":"Which library?","multiSelect":false,"options":[{"label":"Vitest","description":"Use Vitest"},{"label":"Jest","description":"Use Jest"}]}]}';
  const first = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json', '--model', values.model,
    '--allowed-tools', 'read_todos_tool_call',
    `Remember this blind phrase for the next turn: ${phrase}. Your entire answer to this turn must be exactly this one line, with no code fence or text before or after it:\n${marker}`,
  ], checkout, 45_000);
  const firstFrames = framesOf(first.stdout);
  const firstResult = resultOf(firstFrames);
  const firstText = String(firstResult?.result ?? '');
  const askLine = firstText.split('\n').findLast(line => line.startsWith('CEZ:ASK '));
  let markerValid = false;
  try { markerValid = Boolean(JSON.parse(askLine?.slice('CEZ:ASK '.length) ?? '').questions?.length); } catch { /* invalid marker */ }
  const second = firstResult?.session_id ? await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json', '--model', values.model,
    '--resume', firstResult.session_id, '--allowed-tools', 'read_todos_tool_call',
    'Library: Vitest. State the blind phrase from the previous turn, then say accepted.',
  ], checkout, 45_000) : undefined;
  const secondFrames = second ? framesOf(second.stdout) : [];
  const secondResult = resultOf(secondFrames);
  const sameNativeSession = Boolean(firstResult?.session_id && firstResult.session_id === secondResult?.session_id);
  const phraseRecalled = String(secondResult?.result ?? '').includes(phrase);
  return {
    schema: 1, case: 'portable-ask', cliVersion: version, model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--allowed-tools read_todos_tool_call', '--resume <exact native id>'],
    markerTokenSeen: firstText.includes('CEZ:ASK'), markerSeen: Boolean(askLine), markerValid,
    firstResultTextPresent: firstText.length > 0, explicitReplyDelivered: Boolean(second),
    phraseRecalled, sameNativeSession,
    fullCezarAskRoundTrip: false,
    outcome: first.code === 0 && !first.timedOut && !first.truncated && markerValid
      && second?.code === 0 && !second.timedOut && !second.truncated
      && phraseRecalled && sameNativeSession ? 'pass' : 'blocked',
  };
}

async function probePlugins(version) {
  // This project-local disable is a negative control. It never changes a
  // user's Cursor installation, marketplace state or Claude settings.
  const claudeSettings = join(checkout, '.claude');
  mkdirSync(claudeSettings, { recursive: true });
  writeFileSync(join(claudeSettings, 'settings.json'), JSON.stringify({ enabledPlugins: {
    'superpowers@apptension-dev': false,
    'superpowers@claude-plugins-official': false,
    'superpowers@apptension-toolkit-dev': false,
  } }));
  const pluginDir = join(checkout, 'cez-inert-plugin');
  mkdirSync(pluginDir);
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'cez-inert-plugin', version: '0.0.1', description: 'Inert qualification plugin' }));
  const { catalogRun, names, safeAllowedTools } = await discoverSafeAllowedTools();
  const run = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json', '--model', values.model,
    '--allowed-tools', safeAllowedTools.join(','), '--plugin-dir', pluginDir,
    'From your loaded skills, read the Superpowers brainstorming SKILL.md and report its first heading. Do not search the filesystem for a disabled skill.',
  ], checkout, 45_000);
  const frames = framesOf(run.stdout);
  const reads = frames.filter(frame => frame.type === 'tool_call' && frame.tool_call?.readToolCall)
    .map(frame => JSON.stringify(frame.tool_call.readToolCall));
  const marketplaceSkillRead = reads.some(read => /\.cursor\/plugins\/cache\/.*superpowers.*SKILL\.md/i.test(read));
  const claudeSkillRead = reads.some(read => /\.claude\/plugins\/.*superpowers.*SKILL\.md/i.test(read));
  return {
    schema: 1, case: 'plugins', cliVersion: version, model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--allowed-tools <non-agent catalog>', '--plugin-dir <disposable inert plugin>'],
    projectSettings: '.claude/settings.json enabledPlugins=false for known Superpowers IDs in disposable worktree',
    globalConfigurationWritten: false,
    catalogValidatedBeforeInference: catalogRun.code === 1 && names.includes('read_tool_call'),
    readToolFrames: reads.length, marketplaceSkillRead, claudeSkillRead,
    outcome: run.code === 0 && !run.timedOut && !run.truncated && marketplaceSkillRead
      ? 'blocked' : 'inconclusive',
  };
}

async function probeResumeMissing(version) {
  const nonexistentId = randomUUID();
  const run = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json', '--model', values.model,
    '--resume', nonexistentId, '--allowed-tools', 'read_todos_tool_call',
    'What exact phrase did I ask you to remember in the previous turn of this chat? If this chat has no previous turn, answer NO_PRIOR_TURN.',
  ], checkout, 45_000);
  const frames = framesOf(run.stdout);
  const result = resultOf(frames);
  const successWithRequestedId = run.code === 0 && result?.subtype === 'success'
    && result.session_id === nonexistentId;
  const noPriorTurn = String(result?.result ?? '').includes('NO_PRIOR_TURN');
  return {
    schema: 1, case: 'resume-missing', cliVersion: version, model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--resume <random never-seen UUID>', '--allowed-tools read_todos_tool_call'],
    exitCode: run.code, timedOut: run.timedOut, outputTruncated: run.truncated,
    successWithRequestedId, noPriorTurn,
    missingSessionError: /not found|missing|resume|session/i.test(run.stderr),
    outcome: !run.timedOut && !run.truncated && successWithRequestedId && noPriorTurn
      ? 'blocked' : run.code !== 0 && !result ? 'pass' : 'inconclusive',
  };
}

function writeStripedPng(path) {
  // A small randomized red/blue control, generated locally and never retained.
  const colors = Math.random() < 0.5
    ? [[255, 0, 0], [0, 0, 255]] : [[0, 0, 255], [255, 0, 0]];
  const width = 40;
  const height = 20;
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.from([
    0, ...Array.from({ length: width }, (_, x) => colors[x < width / 2 ? 0 : 1]).flat(),
  ])));
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const label = Buffer.from(type);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([label, data])));
    return Buffer.concat([size, label, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  return colors[0][0] === 255 ? 'RED_BLUE' : 'BLUE_RED';
}

async function probeFields(version) {
  const modelListing = await runAgent(['--list-models'], checkout, 15_000);
  const advertisedModel = modelListing.code === 0
    && modelListing.stdout.split('\n').some(line => line.startsWith(`${values.model} - `));
  const lowEffortModel = values.model.replace(/-medium$/, '-low');
  const lowEffortAdvertised = lowEffortModel !== values.model && modelListing.stdout.split('\n')
    .some(line => line.startsWith(`${lowEffortModel} - `));
  const lowEffort = lowEffortAdvertised ? await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', lowEffortModel, '--allowed-tools', 'read_todos_tool_call', 'Reply OK.',
  ], checkout, 45_000) : undefined;
  const invalid = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', 'cez-nonexistent-model-pin', 'Reply OK.',
  ], checkout, 15_000);
  const invalidRejectedBeforeInference = invalid.code !== 0
    && !framesOf(invalid.stdout).some(frame => frame.type === 'assistant' || frame.type === 'result');

  const extraRoot = join(scratch, 'extra-root');
  mkdirSync(extraRoot);
  const canary = randomBytes(12).toString('hex');
  writeFileSync(join(extraRoot, 'root-canary.txt'), canary, { mode: 0o600 });
  const image = join(checkout, 'stripes.png');
  const colorOrder = writeStripedPng(image);
  const args = [
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--allowed-tools', 'read_tool_call',
    '--add-dir', extraRoot, '--image', image,
  ];
  const first = await runAgent([...args,
    `Read ${join(extraRoot, 'root-canary.txt')} with the native Read tool. Then describe the image's colors from left to right as RED_BLUE or BLUE_RED. Reply with the file contents and that code only.`,
  ], checkout, 45_000);
  const firstFrames = framesOf(first.stdout);
  const firstResult = resultOf(firstFrames);
  const firstId = firstResult?.session_id;
  const second = firstId ? await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json', '--model', values.model,
    '--resume', firstId, '--allowed-tools', 'read_todos_tool_call',
    'What was the image color-order code from the previous turn? Reply with just that code.',
  ], checkout, 45_000) : undefined;
  const secondResult = second ? resultOf(framesOf(second.stdout)) : undefined;
  const rootRead = firstFrames.some(frame => frame.type === 'tool_call' && frame.tool_call?.readToolCall);
  const readCall = firstFrames.find(frame => frame.type === 'tool_call' && frame.subtype === 'completed'
    && frame.tool_call?.readToolCall)?.tool_call.readToolCall;
  const text = String(firstResult?.result ?? '');
  return {
    schema: 1, case: 'fields', cliVersion: version, model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--model <advertised ID>', '--allowed-tools read_tool_call', '--add-dir <disposable root>', '--image <disposable PNG>', '--resume <exact native ID>'],
    advertisedModel, invalidRejectedBeforeInference,
    advertisedEffortVariant: lowEffortAdvertised,
    advertisedEffortVariantAdmitted: lowEffort?.code === 0 && resultOf(framesOf(lowEffort.stdout))?.subtype === 'success',
    extraRootToolRead: rootRead, extraRootCanarySeen: text.includes(canary),
    readArgKeys: readCall?.args && typeof readCall.args === 'object' ? Object.keys(readCall.args).sort() : [],
    readResultKeys: readCall?.result && typeof readCall.result === 'object' ? Object.keys(readCall.result).sort() : [],
    imageOrderSeen: text.includes(colorOrder),
    sameNativeSession: Boolean(firstId && secondResult?.session_id === firstId),
    currentInstructionFollowedOnResume: String(secondResult?.result ?? '').trim() === colorOrder,
    freshExitCode: first.code, resumedExitCode: second?.code ?? null,
    timedOut: first.timedOut || Boolean(second?.timedOut),
    outputTruncated: first.truncated || Boolean(second?.truncated),
    outcome: advertisedModel && lowEffortAdvertised && lowEffort?.code === 0
      && resultOf(framesOf(lowEffort.stdout))?.subtype === 'success'
      && invalidRejectedBeforeInference && first.code === 0
      && second?.code === 0 && rootRead && text.includes(canary)
      && text.includes(colorOrder) && secondResult?.session_id === firstId
      && String(secondResult?.result ?? '').trim() === colorOrder ? 'pass' : 'blocked',
  };
}

async function probeErrors(version) {
  const invalidKey = `cez-invalid-${randomBytes(16).toString('hex')}`;
  const auth = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--allowed-tools', 'read_todos_tool_call', 'Reply OK.',
  ], checkout, 20_000, { ...process.env, CURSOR_API_KEY: invalidKey });
  const authFrames = framesOf(auth.stdout);
  const authFailedWithoutSuccess = auth.code !== 0
    && !authFrames.some(frame => frame.type === 'result' && frame.subtype === 'success');
  const timeout = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--allowed-tools', 'read_todos_tool_call', 'Reply OK.',
  ], checkout, 10);
  return {
    schema: 1, case: 'errors', cliVersion: version, model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--allowed-tools read_todos_tool_call', 'invalid synthetic CURSOR_API_KEY in process env', '10 ms timeout in disposable worktree'],
    invalidKeyNotEchoed: !auth.stdout.includes(invalidKey) && !auth.stderr.includes(invalidKey),
    invalidKeyRejected: authFailedWithoutSuccess,
    noFallbackToLoggedInAccount: authFailedWithoutSuccess,
    authProcessGroupGone: auth.processGroupGone,
    timeoutTriggered: timeout.timedOut,
    timeoutProcessGroupGone: timeout.processGroupGone,
    outcome: authFailedWithoutSuccess && !auth.stdout.includes(invalidKey)
      && !auth.stderr.includes(invalidKey) && auth.processGroupGone
      && timeout.timedOut && timeout.processGroupGone ? 'pass' : 'blocked',
  };
}

async function probePluginLifecycle(version) {
  const { catalogRun, names, safeAllowedTools } = await discoverSafeAllowedTools();
  const pluginDir = join(checkout, 'cez-print-qualification-plugin');
  const manifestDir = join(pluginDir, '.cursor-plugin');
  const hooksDir = join(pluginDir, 'hooks');
  const skillDir = join(pluginDir, 'skills', 'print-qualification');
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(hooksDir);
  mkdirSync(skillDir, { recursive: true });
  const heading = `# Print qualification ${randomBytes(6).toString('hex')}`;
  const hookPhrase = randomBytes(12).toString('hex');
  writeFileSync(join(skillDir, 'SKILL.md'), `${heading}\nA local test skill.\n`);
  writeFileSync(join(manifestDir, 'plugin.json'), JSON.stringify({
    name: 'cez-print-qualification', version: '0.0.1',
    description: 'Disposable local plugin for fork 590 qualification',
    skills: './skills/', hooks: './hooks/hooks.json',
  }));
  const hookOutput = join(hooksDir, 'started');
  writeFileSync(join(hooksDir, 'start.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(hookOutput)}, '1\\n');\nprocess.stdout.write(JSON.stringify({ additional_context: ${JSON.stringify(`Remember this hook phrase for later: ${hookPhrase}`)} }));\n`);
  writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({
    version: 1, hooks: { sessionStart: [{ command: `node ${join(hooksDir, 'start.mjs')}` }] },
  }));
  const hookCount = () => existsSync(hookOutput) ? readFileSync(hookOutput, 'utf8').split('\n').filter(Boolean).length : 0;
  const base = ['-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--allowed-tools', safeAllowedTools.join(',')];
  const first = await runAgent([...base, '--plugin-dir', pluginDir,
    'Use your loaded print-qualification skill. Read its SKILL.md with the native Read tool and report the first heading exactly.',
  ], checkout, 45_000);
  const firstFrames = framesOf(first.stdout);
  const firstId = resultOf(firstFrames)?.session_id;
  const firstHookCount = hookCount();
  const localSkillRead = firstFrames.some(frame => frame.type === 'tool_call'
    && frame.tool_call?.readToolCall && JSON.stringify(frame.tool_call.readToolCall).includes('print-qualification/SKILL.md'));
  const second = firstId ? await runAgent([...base, '--resume', firstId, '--plugin-dir', pluginDir,
    'From your enabled marketplace plugins, read the Superpowers brainstorming SKILL.md with the native Read tool. Then report its first heading and the hook phrase injected at the start of this session.',
  ], checkout, 45_000) : undefined;
  const secondFrames = second ? framesOf(second.stdout) : [];
  const secondId = resultOf(secondFrames)?.session_id;
  const secondHookCount = hookCount();
  const marketplaceSkillRead = secondFrames.some(frame => frame.type === 'tool_call'
    && frame.tool_call?.readToolCall
    && /\.cursor\/plugins\/cache\/.*superpowers.*SKILL\.md/i.test(JSON.stringify(frame.tool_call.readToolCall)));
  rmSync(pluginDir, { recursive: true, force: true });
  const absent = await runAgent([...base,
    'If a loaded skill named print-qualification is available, read its SKILL.md. Otherwise reply ABSENT. Do not search the filesystem.',
  ], checkout, 45_000);
  const absentFrames = framesOf(absent.stdout);
  const absentLocalRead = absentFrames.some(frame => frame.type === 'tool_call'
    && frame.tool_call?.readToolCall && JSON.stringify(frame.tool_call.readToolCall).includes('print-qualification/SKILL.md'));
  return {
    schema: 1, case: 'plugin-lifecycle', cliVersion: version, model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--allowed-tools <non-agent catalog>', '--plugin-dir <disposable local plugin>', '--resume <exact native ID>'],
    catalogValidatedBeforeInference: catalogRun.code === 1 && names.includes('read_tool_call'),
    localSkillRead, localHeadingSeen: String(resultOf(firstFrames)?.result ?? '').includes(heading),
    marketplaceSkillRead, sameNativeSession: Boolean(firstId && secondId === firstId),
    freshHookRan: firstHookCount > 0, resumedHookRan: secondHookCount > firstHookCount,
    hookContextRecalledOnResume: String(resultOf(secondFrames)?.result ?? '').includes(hookPhrase),
    absentLocalSkillRead: absentLocalRead,
    absentModelReportedMissing: String(resultOf(absentFrames)?.result ?? '').includes('ABSENT'),
    globalConfigurationWritten: false,
    outcome: catalogRun.code === 1 && first.code === 0 && second?.code === 0 && absent.code === 0
      && localSkillRead && String(resultOf(firstFrames)?.result ?? '').includes(heading)
      && marketplaceSkillRead && firstId === secondId && firstHookCount > 0
      && String(resultOf(secondFrames)?.result ?? '').includes(hookPhrase)
      && !absentLocalRead
      && String(resultOf(absentFrames)?.result ?? '').includes('ABSENT') ? 'pass' : 'blocked',
  };
}

let added = false;
let cleaned = true;
try {
  const version = await runAgent(['--version'], process.cwd(), 10_000);
  if (version.code !== 0 || version.timedOut) throw new Error('Cursor version check failed');
  git(['worktree', 'add', '--quiet', '--detach', checkout, 'HEAD']);
  added = true;

  const probes = { 'native-question': probeNativeQuestion, delegation: probeDelegation, mcp: probeMcp, 'portable-ask': probePortableAsk, plugins: probePlugins, 'resume-missing': probeResumeMissing, fields: probeFields, 'plugin-lifecycle': probePluginLifecycle, errors: probeErrors };
  const summary = await probes[values.case](version.stdout.trim());
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, `print-${values.case}.json`);
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${output}\n`);
  process.exitCode = summary.outcome === 'pass' ? 0 : summary.outcome === 'blocked' ? 2 : 1;
} catch (error) {
  process.stderr.write(`Probe failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
} finally {
  if (added) {
    const removed = spawnSync('git', ['worktree', 'remove', '--force', checkout], { encoding: 'utf8', timeout: 15_000 });
    if (removed.status !== 0) {
      process.stderr.write(`Probe cleanup failed; inspect ${checkout}\n`);
      process.exitCode = 1;
      cleaned = false;
    }
  }
  if (cleaned) rmSync(scratch, { recursive: true, force: true });
}
