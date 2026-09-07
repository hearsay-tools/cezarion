import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { HARNESS_ADAPTERS } from './harness-parity.testkit.ts';

/** Reject exactly one identified command through the real protocol; a reopened
 * process accepts it. No session/manager mock and no transport-error inference. */
export async function withRejectedCommand(backend: 'codex' | 'opencode' | 'pi', body: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-reject-'));
  const once = join(root, 'rejected-once');
  const adapter = HARNESS_ADAPTERS[backend] as { mockBin: string };
  const original = adapter.mockBin, mock = join(root, 'mock.mjs');
  let source = "import {existsSync,writeFileSync} from 'node:fs';\n" + readFileSync(original, 'utf8').replace(/^#!.*\n/, '');
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
export async function withDelayedCommand(backend: 'codex' | 'opencode' | 'pi', body: (release: () => void) => Promise<void>, marker = 'delay-owned-ack'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-delay-'));
  const released = join(root, 'released');
  const adapter = HARNESS_ADAPTERS[backend] as { mockBin: string };
  const original = adapter.mockBin, mock = join(root, 'mock.mjs');
  let source = readFileSync(original, 'utf8').replace(/^#!.*\n/, '');
  const delay = `function delayedAck(send) { const timer=setInterval(()=>{if(existsSync(${JSON.stringify(released)})){clearInterval(timer);send();}},5); }`;
  source = `import {existsSync} from 'node:fs';\n${delay}\n${source}`;
  try {
    if (backend === 'codex') {
      const anchor = "    emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `    if(JSON.stringify(msg.params).includes(${JSON.stringify(marker)})) delayedAck(()=>{${anchor}}); else {${anchor}}`);
    } else if (backend === 'opencode') {
      const anchor = "      res.end(JSON.stringify({ info: info({}), parts: [] }));";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `      if(body.includes(${JSON.stringify(marker)})) delayedAck(()=>{${anchor}}); else {${anchor}}`);
    } else {
      const anchor = "    send({ id: command.id, type: 'response', command: 'prompt', success: true });\n    send({ type: 'agent_start' });\n    send({ type: 'turn_start' });\n    sendText([command.message]);";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `    if(command.message.includes(${JSON.stringify(marker)})) delayedAck(()=>send({id:command.id,type:'response',command:'prompt',success:true}));
    else send({id:command.id,type:'response',command:'prompt',success:true});
    send({type:'agent_start'}); send({type:'turn_start'}); sendText([command.message]);`);
    }
    source = source.replace("turnText.includes('mock:agent-echo')", `(turnText.includes('mock:agent-echo') || turnText.includes(${JSON.stringify(marker)}))`)
      .replace("body.includes('mock:agent-echo')", `(body.includes('mock:agent-echo') || body.includes(${JSON.stringify(marker)}))`)
      .replace("command.message.includes('mock:agent-echo')", `(command.message.includes('mock:agent-echo') || command.message.includes(${JSON.stringify(marker)}))`);
    writeFileSync(mock, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
    adapter.mockBin = mock;
    await body(() => writeFileSync(released, ''));
  } finally { adapter.mockBin = original; rmSync(root, { recursive: true, force: true }); }
}
