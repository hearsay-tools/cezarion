import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';

export const CHANNEL_WIRES = {
  claude: { missing: false, refresh: false, reason: 'whole assistant/result text feeds both channels' },
  codex: { missing: true, refresh: true, reason: 'v1 buffers absent snapshots and deduplicates completed ids; v2 maps each snapshot' },
  opencode: { missing: true, refresh: false, reason: 'v1 buffers absent snapshots; both channels deduplicate completed parts' },
  pi: { missing: false, refresh: false, reason: 'text_end snapshot/delta fallback feeds both channels' },
  cursor: { missing: false, refresh: false, reason: 'v1 is emitted directly from completed v2 messages' },
} as const satisfies Record<RunnerId, { missing: boolean; refresh: boolean; reason: string }>;

/** Change native completion frames only. No runner or normalized-event injection.
 * Unsupported directions execute their ordinary coupled-wire control instead. */
export async function withChannelWire(backend: RunnerId, direction: 'missing' | 'refresh', body: () => Promise<void>): Promise<void> {
  if (!CHANNEL_WIRES[backend][direction]) { await body(); return; }
  const adapter = HARNESS_ADAPTERS[backend] as { mockBin: string };
  const original = adapter.mockBin;
  const dir = mkdtempSync(join(tmpdir(), 'cez-channel-wire-'));
  const mock = join(dir, 'mock.mjs');
  let source = readFileSync(original, 'utf8').replaceAll("import('./", `import('${dirname(original)}/`);
  try {
    if (backend === 'codex') {
      const anchor = "      for (const text of turnMessages(turnText)) emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: `item_multi_${++echoSerial}`, text } } });";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `      const messages = turnMessages(turnText);
      let firstId;
      for (let n = 0; n < messages.length; n++) {
        const text = messages[n], id = n === 1 && ${direction === 'refresh'} ? firstId : 'channel_' + (++echoSerial);
        if (n === 0) firstId = id;
        if (n === 1 && ${direction === 'missing'}) {
          emit({method:'item/started',params:{threadId:'th_mock_1',turnId:'turn_mock_1',item:{type:'agentMessage',id}}});
          emit({method:'item/agentMessage/delta',params:{threadId:'th_mock_1',turnId:'turn_mock_1',itemId:id,delta:text}});
          emit({method:'item/completed',params:{threadId:'th_mock_1',turnId:'turn_mock_1',item:{type:'agentMessage',id}}});
        } else emit({method:'item/completed',params:{threadId:'th_mock_1',turnId:'turn_mock_1',item:{type:'agentMessage',id,text:n === 1 && ${direction === 'refresh'} ? messages[0] + '\\n' + text : text}}});
      }`);
    } else {
      const anchor = "          send({ type: 'message.part.updated', properties: { part: { id: `prt_multi_${++echoSerial}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text, time: { start: 1, end: 2 } } } });";
      expect(source.split(anchor)).toHaveLength(2);
      source = source.replace(anchor, `          const id = 'channel_' + (++echoSerial);
          if (text.includes('CEZ:MONITORING') || text.includes('CEZ:DONE')) {
            send({type:'message.part.updated',properties:{part:{id,messageID:MESSAGE_ID,sessionID:SESSION_ID,type:'text',text}}});
            send({type:'message.part.updated',properties:{part:{id,messageID:MESSAGE_ID,sessionID:SESSION_ID,type:'text',time:{start:1,end:2}}}});
          } else send({type:'message.part.updated',properties:{part:{id,messageID:MESSAGE_ID,sessionID:SESSION_ID,type:'text',text,time:{start:1,end:2}}}});`);
    }
    writeFileSync(mock, source, { mode: 0o755 });
    adapter.mockBin = mock;
    await body();
  } finally { adapter.mockBin = original; rmSync(dir, { recursive: true, force: true }); }
}
