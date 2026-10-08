#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2026.10.01-mock\n'); process.exit(0); }
if (args.includes('--list-models')) { process.stdout.write('Available models\n\ngpt-5.4-mini-medium - Mock Mini\n'); process.exit(0); }
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const resumeId = flag('--resume');
const mode = process.env.CEZ_MOCK_CURSOR_PRINT_MODE ?? 'normal';
const turn = resumeId ? 2 : 1;
const id = resumeId && mode !== 'mismatch-on-resume' ? resumeId : randomUUID();
const prompt = args.at(-1) ?? '';
const frame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = process.env.CEZ_MOCK_CURSOR_PRINT_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, resumeId, id, args })}\n`);
if (mode === 'delay-init') await new Promise(resolve => setTimeout(resolve, 10_000));
frame({ type: 'system', subtype: 'init', session_id: id, model: flag('--model') ?? 'auto', cwd: process.cwd() });
if (mode === 'no-result') process.exit(0);
if (mode === 'portable-ask' && !resumeId) {
  const ask = 'CEZ:ASK {"questions":[{"header":"Library","question":"Which library?","multiSelect":false,"options":[{"label":"Vitest","description":"Use Vitest"},{"label":"Jest","description":"Use Jest"}]}]}';
  frame({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: `Choose one.\n${ask}` }] } });
  frame({ type: 'result', subtype: 'success', session_id: id, is_error: false, result: `Choose one.\n${ask}` });
  process.exit(0);
}
if (mode === 'provider-error') {
  frame({ type: 'result', subtype: 'error_during_execution', session_id: id, is_error: true,
    result: 'RetriableError: provider unavailable' });
  process.exit(0);
}
const text = mode === 'native-question' ? 'Question skipped.' : `turn ${turn}: ${prompt}`;
if (mode === 'delay-work' && resumeId) await new Promise(resolve => setTimeout(resolve, 200));
frame({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text }] } });
if (mode === 'crash-after-work') process.exit(1);
frame({ type: 'result', subtype: 'success', session_id: id, is_error: false, result: text });
if (mode === 'duplicate-result') frame({ type: 'result', subtype: 'success', session_id: id, is_error: false, result: text });
if (mode === 'late-frame') frame({ type: 'assistant', session_id: id,
  message: { role: 'assistant', content: [{ type: 'text', text: 'LATE_FRAME' }] } });
if (mode === 'result-before-exit') await new Promise(resolve => setTimeout(resolve, 250));
