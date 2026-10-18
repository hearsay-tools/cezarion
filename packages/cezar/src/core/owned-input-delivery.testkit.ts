import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_ADAPTERS } from './harness-parity.testkit.ts';
import { patchMockOnce } from './mock-patch.testkit.ts';

const patch = (mockBin: string, source: string, anchor: string, replacement: string | ((anchor: string) => string)) =>
  patchMockOnce('owned-input-delivery.testkit.ts', mockBin, source, anchor, replacement);

/** The patched copy runs from a temporary directory: point the mock's sibling `import('./…')`
 *  calls (turn messages, cezar tools) back at the originals. */
const writeMock = (mock: string, mockBin: string, source: string) => writeFileSync(mock, '#!/usr/bin/env node\n' +
  source.replace(/import\('(\.\/[^']+)'\)/g, (_match, path: string) => `import(${JSON.stringify(pathToFileURL(join(dirname(mockBin), path)).href)})`), { mode: 0o755 });

/** Reject exactly one identified command through the real protocol; a reopened
 * process accepts it. No session/manager mock and no transport-error inference. */
export async function withRejectedCommand(backend: 'codex' | 'opencode' | 'pi' | 'omp', body: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-reject-'));
  const once = join(root, 'rejected-once');
  const adapter = HARNESS_ADAPTERS[backend] as { mockBin: string };
  const original = adapter.mockBin, mock = join(root, 'mock.mjs');
  // mock-omp-rpc.mjs already imports both; a second import of the same name is a SyntaxError.
  let source = (backend === 'omp' ? '' : "import {existsSync,writeFileSync} from 'node:fs';\n") + readFileSync(original, 'utf8').replace(/^#!.*\n/, '');
  const rejected = `existsSync(${JSON.stringify(once)})`, mark = `writeFileSync(${JSON.stringify(once)},'rejected')`;
  try {
    if (backend === 'codex') {
      const anchor = "  } else if (msg.method === 'turn/start') {";
      source = patch(original, source, anchor, found => found + `\n    if(JSON.stringify(msg.params).includes('reject-owned-turn') && !${rejected}) {${mark};emit({id:msg.id,error:{code:-32603,message:'owned turn rejected'}});return;}`);
    } else if (backend === 'opencode') {
      const anchor = "      if (body.includes('mock:reject-agent-post')) {";
      source = patch(original, source, anchor, `      if (body.includes('mock:reject-agent-post') && !${rejected}) {${mark};`);
    } else if (backend === 'omp') {
      // Rejected before admission: OMP's error response only, no prompt_result (rpc-mode.ts).
      const anchor = "async function prompt(command) {\n  const message = command.message;\n";
      source = patch(original, source, anchor, found => found + `  if(message.includes('reject-owned-turn') && !${rejected}) {${mark};fail(command,'owned turn rejected');return;}\n`);
    } else {
      const anchor = "  } else if (command.type === 'prompt' && command.message.includes('mock:agent-echo')) {";
      source = patch(original, source, anchor, found => `  } else if(command.type==='prompt' && command.message.includes('reject-owned-turn') && !${rejected}) {${mark};send({id:command.id,type:'response',command:'prompt',success:false,error:{message:'owned turn rejected'}});` + found);
    }
    writeMock(mock, original, source);
    adapter.mockBin = mock;
    await body();
  } finally {
    adapter.mockBin = original;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Hold only the transport ACK; normal real turn frames still reach the runner. */
export async function withDelayedCommand(backend: 'codex' | 'opencode' | 'pi' | 'omp', body: (release: () => void) => Promise<void>, marker = 'delay-owned-ack'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-delay-'));
  const released = join(root, 'released');
  const adapter = HARNESS_ADAPTERS[backend] as { mockBin: string };
  const original = adapter.mockBin, mock = join(root, 'mock.mjs');
  let source = readFileSync(original, 'utf8').replace(/^#!.*\n/, '');
  // Aliased: a mock may already import `existsSync` itself (mock-omp-rpc.mjs does).
  const delay = `function delayedAck(send) { const timer=setInterval(()=>{if(ackReleased(${JSON.stringify(released)})){clearInterval(timer);send();}},5); }`;
  source = `import {existsSync as ackReleased} from 'node:fs';\n${delay}\n${source}`;
  try {
    if (backend === 'codex') {
      const anchor = "    emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });";
      source = patch(original, source, anchor, found => `    if(JSON.stringify(msg.params).includes(${JSON.stringify(marker)})) delayedAck(()=>{${found}}); else {${found}}`);
    } else if (backend === 'opencode') {
      const anchor = "      res.end(JSON.stringify({ info: info({}), parts: [] }));";
      source = patch(original, source, anchor, found => `      if(body.includes(${JSON.stringify(marker)})) delayedAck(()=>{${found}}); else {${found}}`);
    } else if (backend === 'omp') {
      // The baseline echoes the prompt, so only the ack moves; the turn frames stream on.
      const anchor = "  respond(command);\n  beginTurn(command);\n";
      source = patch(original, source, anchor, `  if(message.includes(${JSON.stringify(marker)})) delayedAck(()=>respond(command)); else respond(command);\n  beginTurn(command);\n`);
    } else {
      const anchor = "    send({ id: command.id, type: 'response', command: 'prompt', success: true });\n    send({ type: 'agent_start' });\n    send({ type: 'turn_start' });\n    sendText([command.message]);";
      source = patch(original, source, anchor, `    if(command.message.includes(${JSON.stringify(marker)})) delayedAck(()=>send({id:command.id,type:'response',command:'prompt',success:true}));
    else send({id:command.id,type:'response',command:'prompt',success:true});
    send({type:'agent_start'}); send({type:'turn_start'}); sendText([command.message]);`);
    }
    // The marker's turn also takes the agent-echo branch; OMP needs no patch, its baseline already echoes.
    const echo = { codex: 'turnText', opencode: 'body', pi: 'command.message', omp: undefined }[backend];
    if (echo && marker !== 'mock:provider-error') {
      source = patch(original, source, `${echo}.includes('mock:agent-echo')`, found => `(${found} || ${echo}.includes(${JSON.stringify(marker)}))`);
    }
    writeMock(mock, original, source);
    adapter.mockBin = mock;
    await body(() => writeFileSync(released, ''));
  } finally { adapter.mockBin = original; rmSync(root, { recursive: true, force: true }); }
}

/** Executable pipe-write ACK exemption (Claude stream-json and Cursor ACP).
 * Hold the provider response after it reads an owned input. Both real runners
 * acknowledge the local stdin write independently; withholding a protocol
 * response therefore cannot construct a turn-end-before-ACK race. */
export async function withHeldPipeResponse(
  backend: 'claude',
  body: (release: () => void, responseHeld: () => boolean) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-pipe-'));
  const released = join(root, 'released'), received = join(root, 'received');
  const adapter = HARNESS_ADAPTERS[backend] as { mockBin: string };
  const original = adapter.mockBin, mock = join(root, 'mock.mjs');
  let source = readFileSync(original, 'utf8').replace(/^#!.*\n/, '');
  const anchor = "  if (userText.includes('mock:agent-echo')) {";
  source = patch(original, `import * as pipeGateFs from 'node:fs';\n${source}`, anchor, found => `${found}
    pipeGateFs.writeFileSync(${JSON.stringify(received)}, '');
    while (!pipeGateFs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 5));
  `);
  try {
    writeMock(mock, original, source);
    adapter.mockBin = mock;
    await body(() => writeFileSync(released, ''), () => existsSync(received));
  } finally { adapter.mockBin = original; rmSync(root, { recursive: true, force: true }); }
}

/** Print has no pipe-write ACK: owned input is admitted on first model work.
 * Hold that native work to prove delivery cannot clear before admission. */
export async function withHeldPrintResponse(
  body: (release: () => void, responseHeld: () => boolean) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-print-'));
  const released = join(root, 'released'), received = join(root, 'received');
  const adapter = HARNESS_ADAPTERS.cursor as { mockBin: string };
  const original = adapter.mockBin, mock = join(root, 'mock.mjs');
  let source = readFileSync(original, 'utf8').replace(/^#!.*\n/, '');
  const anchor = "if (prompt.includes('mock:agent-echo')) { finish(prompt); process.exit(0); }";
  source = patch(original, source, anchor, found => `${found.replace('finish(prompt);', () => `
    pipeGateFs.writeFileSync(${JSON.stringify(received)}, '');
    while (!pipeGateFs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 5));
    finish(prompt);`)}`);
  source = `import * as pipeGateFs from 'node:fs';\n${source}`;
  try {
    writeMock(mock, original, source);
    adapter.mockBin = mock;
    await body(() => writeFileSync(released, ''), () => existsSync(received));
  } finally { adapter.mockBin = original; rmSync(root, { recursive: true, force: true }); }
}
