// Manual real-harness probe for #505: does agent input sent while a slow tool runs
// reach the running turn, and when does the harness report the model read it?
//
// Spends ONE paid session on the named backend. Never run by CI or `npm test`, and
// never packed (it lives outside packages/). Usage, from the repo root:
//   node_modules/.bin/tsx .ai/scripts/probe-steering.ts <claude|codex|pi|opencode|cursor> [model]
// Expected on a steer runner: ACK ~instantly after SENT, CONSUMED after tool-result and
// before turn-end, a single turn-end, and RESULT.textHasToken true. Cursor refuses busy
// input (SENT refused) and receives it at the turn boundary instead.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../../packages/cezar/src/core/runner-factory.ts';
import { inputDeliveryOf, type AgentEvent, type RunnerId } from '../../packages/cezar/src/core/agent-runner.ts';

const [backend, model] = process.argv.slice(2) as [RunnerId, string | undefined];
if (!backend) { console.error('usage: probe-steering.ts <backend> [model]'); process.exit(2); }
const cwd = mkdtempSync(join(tmpdir(), `probe-steering-${backend}-`));
execFileSync('git', ['init', '-q'], { cwd }); writeFileSync(join(cwd, 'README.md'), 'probe\n');
const t0 = Date.now();
const rec = (kind: string, detail: unknown = '') => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), kind, detail }));
const TOKEN = 'PROBE-7731';
const PROMPT = `Use your shell tool to run exactly this one command in the FOREGROUND and wait for it (never run it in the background): node -e "setTimeout(() => console.log('SLEPT'), 40000)"
After it finishes, reply with every user message you received after this one, verbatim (or NONE), then end with FINISHED. Do not run any other command.`;
const runner = createRunner(backend);
rec('delivery', inputDeliveryOf(runner));
let sent = false; let turnEnds = 0;
const session = runner.startSession({ userPrompt: PROMPT, cwd, model, effort: 'low', allowedTools: ['Bash'], timeoutMs: 300_000 }, (event: AgentEvent) => {
  if (event.type === 'tool-call') { rec('tool-call', event.tool); if (!sent) { sent = true; setTimeout(send, 8_000); } }
  else if (event.type === 'tool-result') rec('tool-result', event.result.slice(0, 60));
  else if (event.type === 'text') rec('text', event.text.slice(0, 160));
  else if (event.type === 'turn-end') { turnEnds += 1; rec('turn-end', event); setTimeout(() => session.end(), 20_000); }
  else if (event.type === 'input-unconsumed' || event.type === 'error' || event.type === 'note') rec(event.type, event);
}, { onAgentInputConsumed: ids => rec('CONSUMED', ids), onAgentInputReady: () => { if (sent && pending) send(); } });
let pending = false;
function send() {
  const ack = session.sendAgentMessage([{ type: 'text', text: `${TOKEN}: this message arrived while your tool was running. Mention ${TOKEN} in your reply.` }], ['probe-1']);
  pending = ack === false;
  rec('SENT', ack === false ? 'refused' : 'accepted');
  if (ack) ack.then(() => rec('ACK'), error => rec('ACK-REJECTED', String(error)));
}
session.result.then(result => { rec('RESULT', { turnEnds, textHasToken: result.text.includes(TOKEN) }); process.exit(0); },
  error => { rec('RESULT-ERROR', String(error)); process.exit(1); });
setTimeout(() => { rec('TIMEOUT'); session.interrupt(); }, 280_000).unref();
