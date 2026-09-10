// Test-only external process. Claude stream-json and Codex app-server envelopes
// follow core/__fixtures__; every turn waits on a file so tests choose ordering,
// never provider latency. Production runners, transport and process proof stay real.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function publishJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export function runWire(control) {
  const id = process.env.CEZ_TASK_ID;
  const codex = process.argv.includes('app-server');
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const threadId = id;
  let serial = 0;
  let queue = Promise.resolve();
  const rl = createInterface({ input: process.stdin });
  if (!codex) emit({ type: 'system', subtype: 'init', session_id: id });
  async function turn(text, number) {
    const turnId = `turn-${number}`;
    publishJson(join(control, `${id}.${number}.input.json`), { text, cwd: process.cwd(), backend: codex ? 'codex' : 'claude' });
    const gate = join(control, `${id}.${number}.reply.json`);
    while (!existsSync(gate)) await new Promise(done => setTimeout(done, 10));
    const result = JSON.parse(readFileSync(gate, 'utf8'));
    if (result.commit) {
      writeFileSync('shared.txt', result.commit + '\n');
      const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
      git('add', 'shared.txt'); git('commit', '-qm', `worker ${result.commit}`);
    }
    const reply = result.text ?? 'Independent work paused';
    if (codex) {
      if (!result.error) emit({ method: 'item/completed', params: { threadId, turnId, item: { id: `item-${number}`, type: 'agentMessage', text: reply } } });
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: result.error ? 'failed' : 'completed', items: [], error: result.error ? { message: result.error, codexErrorInfo: 'other' } : null } } });
    } else {
      if (!result.error) emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input_tokens: 1, output_tokens: 1 } } });
      emit({ type: 'result', subtype: result.error ? 'error_during_execution' : 'success', is_error: !!result.error, result: result.error ?? reply, errors: result.error ? [result.error] : [], usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
    }
  }
  rl.on('line', line => {
    const message = JSON.parse(line);
    if (codex) {
      if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'delegation-integration' } });
      else if (message.method === 'thread/start' || message.method === 'thread/resume') emit({ id: message.id, result: { thread: { id: threadId } } });
      else if (message.method === 'turn/start') {
        const number = ++serial;
        emit({ id: message.id, result: { turn: { id: `turn-${number}` } } });
        emit({ method: 'turn/started', params: { threadId, turn: { id: `turn-${number}`, status: 'inProgress', items: [] } } });
        queue = queue.then(() => turn(message.params.input.map(part => part.text ?? '').join('\n'), number));
      } else if (message.method === 'turn/interrupt') emit({ id: message.id, result: {} });
    } else if (message.type === 'user') {
      const number = ++serial;
      const content = message.message.content;
      queue = queue.then(() => turn(typeof content === 'string' ? content : content.map(part => part.text ?? '').join('\n'), number));
    }
  });
  rl.on('close', () => process.exit(0));
}
