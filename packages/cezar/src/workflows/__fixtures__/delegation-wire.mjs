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

// Cezar's no-wait nudge (hearsay-tools/cezarion#1234). The wire answers it at once in plain text,
// as an agent that ignores it, and gives it no turn number: tests number only the turns they drive.
const NO_WAIT_NUDGE = 'Your turn ended without a wait or done.';

export function runWire(control) {
  const id = process.env.CEZ_TASK_ID;
  const codex = process.argv.includes('app-server');
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const threadId = id;
  let serial = 0;
  let nudges = 0;
  let queue = Promise.resolve();
  // The session's own tool wiring: Claude's argv, or the Codex thread's params.
  let toolWire = codex ? undefined : process.argv.slice(2);
  const rl = createInterface({ input: process.stdin });
  if (!codex) emit({ type: 'system', subtype: 'init', session_id: id });
  async function turn(text, number, turnId = `turn-${number}`) {
    let result = { text: 'Nothing more to add.' };
    if (number !== undefined) {
      publishJson(join(control, `${id}.${number}.input.json`), { text, cwd: process.cwd(), backend: codex ? 'codex' : 'claude' });
      const gate = join(control, `${id}.${number}.reply.json`);
      while (!existsSync(gate)) await new Promise(done => setTimeout(done, 10));
      result = JSON.parse(readFileSync(gate, 'utf8'));
    }
    if (result.commit) {
      writeFileSync('shared.txt', result.commit + '\n');
      const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
      git('add', 'shared.txt'); git('commit', '-qm', `worker ${result.commit}`);
    }
    // `done` calls cezar_done over the session's own wire before the turn ends, and publishes the
    // tool's answer beside the turn's input (hearsay-tools/cezarion#2397).
    if (result.done) {
      const { probeCezarTool } = await import(new URL('../../../scripts/mock-ci-tool.mjs', import.meta.url).href);
      const answer = await probeCezarTool(codex ? 'codex' : 'claude', toolWire, 'cezar_done', {}, false);
      publishJson(join(control, `${id}.${number}.done.json`), JSON.parse(answer.response.content[0].text.split('\n')[0]));
    }
    const reply = result.text ?? 'Independent work paused';
    if (codex) {
      if (!result.error) emit({ method: 'item/completed', params: { threadId, turnId, item: { id: `item-${turnId}`, type: 'agentMessage', text: reply } } });
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: result.error ? 'failed' : 'completed', items: [], error: result.error ? { message: result.error, codexErrorInfo: 'other' } : null } } });
    } else {
      if (!result.error) emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input_tokens: 1, output_tokens: 1 } } });
      emit({ type: 'result', subtype: result.error ? 'error_during_execution' : 'success', is_error: !!result.error, result: result.error ?? reply, errors: result.error ? [result.error] : [], usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
    }
  }
  rl.on('line', line => {
    const message = JSON.parse(line);
    if (codex) {
      if (message.method === 'configRequirements/read') emit({ id: message.id, result: { requirements: null } });
      if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'delegation-integration' } });
      else if (message.method === 'thread/start' || message.method === 'thread/resume') { toolWire = message.params; emit({ id: message.id, result: { thread: { id: threadId } } }); }
      else if (message.method === 'turn/start') {
        const text = message.params.input.map(part => part.text ?? '').join('\n');
        const number = text.includes(NO_WAIT_NUDGE) ? undefined : ++serial;
        const turnId = number === undefined ? `nudge-${++nudges}` : `turn-${number}`;
        emit({ id: message.id, result: { turn: { id: turnId } } });
        emit({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
        queue = queue.then(() => turn(text, number, turnId));
      } else if (message.method === 'turn/interrupt') emit({ id: message.id, result: {} });
    } else if (message.type === 'user') {
      const content = message.message.content;
      const text = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('\n');
      const number = text.includes(NO_WAIT_NUDGE) ? undefined : ++serial;
      queue = queue.then(() => turn(text, number, number === undefined ? `nudge-${++nudges}` : undefined));
    }
  });
  rl.on('close', () => process.exit(0));
}
