// Manual real-harness probe for #505 PR B: a worker's CEZ:ASK question travels to its
// parent, and the parent's reply answers it on the real harness.
//
// Spends ONE paid worker session on the named backend. Never run by CI or `npm test`, and
// never packed (it lives outside packages/). The parent is a parked root record, so no
// second paid session runs; its reply is committed exactly as `worker reply` commits it.
// Usage, from the repo root:
//   node_modules/.bin/tsx .ai/scripts/probe-questions.ts <claude|codex|pi|opencode|cursor> [model]
// Expected: ASKED, ROUTED right behind it, REPLIED, ANSWERED (source parent), then worker
// text naming the chosen option, and no human input anywhere.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInput, ConversationMessage } from '../../packages/contract/src/index.ts';
import type { RunnerId } from '../../packages/cezar/src/core/agent-runner.ts';
import { planOwnedWorkspace } from '../../packages/cezar/src/delegation/workspace.ts';
import { RunStore } from '../../packages/cezar/src/runs/store.ts';
import { RunManager } from '../../packages/cezar/src/workflows/run.ts';

const [backend, model] = process.argv.slice(2) as [RunnerId, string | undefined];
if (!backend) { console.error('usage: probe-questions.ts <backend> [model]'); process.exit(2); }
delete process.env.CEZ_DRY_RUN; process.env.CEZ_AUTONAME = '0';
const repoRoot = mkdtempSync(join(tmpdir(), `probe-questions-${backend}-`));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'probe'); git('config', 'user.email', 'probe@local');
writeFileSync(join(repoRoot, 'README.md'), 'probe\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
const t0 = Date.now();
const rec = (kind: string, detail: unknown = '') => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), kind, detail }));

const store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
store.updateRun(parent.id, { status: 'waiting' });
store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer'], receipts: [] } }]);
const MARKER = JSON.stringify({ questions: [{ header: 'Color', question: 'Which color should the probe report?', options: [{ label: 'Teal' }, { label: 'Amber' }] }] });
const TASK = `Do not run any tools. First, ask which color to report: reply with one short sentence, then end your reply with this exact final line:\nCEZ:ASK ${MARKER}\nWhen you later receive the answer, reply with exactly "COLOR IS <the answer>" and nothing else.`;
const workerId = randomUUID();
const workspace = await planOwnedWorkspace(repoRoot, workerId, git('rev-parse', 'HEAD'));
store.createOwnedRun({ title: 'worker', task: TASK, workflow: 'quick-task', runner: backend, ...(model ? { model } : {}),
  steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }, parent.id, randomUUID(), { role: 'worker', parentRunId: parent.id, permissions: [], workspace },
'a'.repeat(64), { kind: 'internal' });
const manager = new RunManager(store, repoRoot);
const events = (type: string) => store.readEvents(workerId).filter(event => event.type === type);
const until = async (predicate: () => boolean, ms = 240_000) => {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
};
manager.enqueueOwnedRun(workerId);
try {
  await until(() => events('ask.requested').length > 0 || events('worker-question-fallback').length > 0);
  rec('ASKED', events('ask.requested')[0]?.questions ?? 'no ask');
  await until(() => events('worker-question-routed').length > 0 || events('worker-question-fallback').length > 0);
  const routed = events('worker-question-routed')[0];
  rec(routed ? 'ROUTED' : 'FALLBACK', routed ?? events('worker-question-fallback')[0]);
  if (!routed) throw new Error('question was not routed');
  await until(() => store.getRun(workerId)?.status === 'waiting');
  const root = store.getRun(parent.id)!.delegation!;
  if (root.role !== 'root' || !root.conversation) throw new Error('missing conversation');
  const question = root.conversation.messages.find(message => message.id === routed.messageId)!;
  rec('PARENT-RECEIVED', { inParentInbox: !!store.getRun(parent.id)?.agentInputs?.some(input => input.id === question.id), text: question.text });
  const id = randomUUID(); const now = new Date().toISOString();
  const attribution = { senderRunId: parent.id, recipientRunId: workerId, kind: 'reply' as const, requestId: question.id };
  const input: AgentInput = { id, source: 'agent', parentRunId: parent.id, text: 'Color: Amber', createdAt: now, conversation: attribution };
  const reply: ConversationMessage = { id, ...attribution, text: input.text, createdAt: now, requestHash: 'b'.repeat(64), state: 'accepted' };
  store.commitConversation(parent.id, { messages: [...root.conversation.messages, reply],
    outcomes: [...root.conversation.outcomes, { requestId: question.id, status: 'replied', observedAt: now, replyId: id }] }, { recipientRunId: workerId, input });
  manager.deliverConversationInput(workerId);
  rec('REPLIED', input.text);
  await until(() => events('human-input-delivered').length > 0);
  rec('ANSWERED', events('human-input-delivered')[0]);
  await until(() => events('text').some(event => /COLOR IS/i.test(String(event.text))));
  rec('WORKER-READ', events('text').filter(event => /COLOR IS/i.test(String(event.text))).map(event => String(event.text).slice(0, 80)));
  rec('RESULT', { userMessages: events('user-message').length, answeredBy: events('human-input-delivered')[0]?.source });
} catch (error) {
  rec('ERROR', String(error));
  rec('TAIL', store.readEvents(workerId).slice(-10).map(event => event.type + ('message' in event ? `:${String(event.message).slice(0, 80)}` : '')));
} finally {
  manager.cancel(workerId);
  await until(() => !manager.isActive(workerId), 30_000).catch(() => {});
  manager.dispose(); store.flush();
  process.exit(0);
}
