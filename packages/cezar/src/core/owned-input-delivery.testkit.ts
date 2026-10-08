import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { HARNESS_ADAPTERS } from './harness-parity.testkit.ts';

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
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, anchor + `\n    if(JSON.stringify(msg.params).includes('reject-owned-turn') && !${rejected}) {${mark};emit({id:msg.id,error:{code:-32603,message:'owned turn rejected'}});return;}`);
    } else if (backend === 'opencode') {
      const anchor = "      if (body.includes('mock:reject-agent-post')) {";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `      if (body.includes('mock:reject-agent-post') && !${rejected}) {${mark};`);
    } else if (backend === 'omp') {
      // Rejected before admission: OMP's error response only, no prompt_result (rpc-mode.ts).
      const anchor = "async function prompt(command) {\n  const message = command.message;\n";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, anchor + `  if(message.includes('reject-owned-turn') && !${rejected}) {${mark};fail(command,'owned turn rejected');return;}\n`);
    } else {
      const anchor = "  } else if (command.type === 'prompt' && command.message.includes('mock:agent-echo')) {";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `  } else if(command.type==='prompt' && command.message.includes('reject-owned-turn') && !${rejected}) {${mark};send({id:command.id,type:'response',command:'prompt',success:false,error:{message:'owned turn rejected'}});` + anchor);
    }
    writeFileSync(mock, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
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
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `    if(JSON.stringify(msg.params).includes(${JSON.stringify(marker)})) delayedAck(()=>{${anchor}}); else {${anchor}}`);
    } else if (backend === 'opencode') {
      const anchor = "      res.end(JSON.stringify({ info: info({}), parts: [] }));";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `      if(body.includes(${JSON.stringify(marker)})) delayedAck(()=>{${anchor}}); else {${anchor}}`);
    } else if (backend === 'omp') {
      // The baseline echoes the prompt, so only the ack moves; the turn frames stream on.
      const anchor = "  respond(command);\n  beginTurn(command);\n";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `  if(message.includes(${JSON.stringify(marker)})) delayedAck(()=>respond(command)); else respond(command);\n  beginTurn(command);\n`);
    } else {
      const anchor = "    send({ id: command.id, type: 'response', command: 'prompt', success: true });\n    send({ type: 'agent_start' });\n    send({ type: 'turn_start' });\n    sendText([command.message]);";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `    if(command.message.includes(${JSON.stringify(marker)})) delayedAck(()=>send({id:command.id,type:'response',command:'prompt',success:true}));
    else send({id:command.id,type:'response',command:'prompt',success:true});
    send({type:'agent_start'}); send({type:'turn_start'}); sendText([command.message]);`);
    }
    if (marker !== 'mock:provider-error') source = source.replace("turnText.includes('mock:agent-echo')", `(turnText.includes('mock:agent-echo') || turnText.includes(${JSON.stringify(marker)}))`)
      .replace("body.includes('mock:agent-echo')", `(body.includes('mock:agent-echo') || body.includes(${JSON.stringify(marker)}))`)
      .replace("command.message.includes('mock:agent-echo')", `(command.message.includes('mock:agent-echo') || command.message.includes(${JSON.stringify(marker)}))`);
    writeFileSync(mock, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
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
  expect(source.split(anchor)).toHaveLength(2);
  source = `import * as pipeGateFs from 'node:fs';\n${source}`.replace(anchor, `${anchor}
    pipeGateFs.writeFileSync(${JSON.stringify(received)}, '');
    while (!pipeGateFs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 5));
  `);
  try {
    writeFileSync(mock, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
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
  expect(source.split(anchor)).toHaveLength(2);
  source = source.replace(anchor, `${anchor.replace('finish(prompt);', `
    pipeGateFs.writeFileSync(${JSON.stringify(received)}, '');
    while (!pipeGateFs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 5));
    finish(prompt);`)}`);
  source = `import * as pipeGateFs from 'node:fs';\n${source}`;
  try {
    writeFileSync(mock, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
    adapter.mockBin = mock;
    await body(() => writeFileSync(released, ''), () => existsSync(received));
  } finally { adapter.mockBin = original; rmSync(root, { recursive: true, force: true }); }
}
