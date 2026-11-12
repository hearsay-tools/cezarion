import assert from 'node:assert/strict';
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport as McpTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CiToolController as Controller } from '../../src/ci-wait/controller.ts';
import type { createRunner as RunnerFactory } from '../../src/core/runner-factory.ts';
import type { AgentEvent } from '../../src/core/agent-runner.ts';
import type { SquawkTool } from '../../src/ci-wait/tools.ts';
import type { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';

export type CiProbeScenario = {
  kind: typeof WAIT_KIND.pr;
  phase: typeof WAIT_PHASE.open;
  source: typeof WAIT_SOURCE.agent;
  via: typeof WAIT_VIA.cezar_wait;
};

// The extension scripts are plain JS. Model the registration surface they expose,
// deriving invocation and result types from the shared tool contract.
type RegisteredTool = {
  name: string;
  execute(callId: string, params: Parameters<SquawkTool['invoke']>[0]): ReturnType<SquawkTool['invoke']>;
};
type Extension = (api: { registerTool(tool: RegisteredTool): void }) => void;

// Application types resolve from src at compile time. The bootstrap supplies only
// installed runtime modules; this probe has no application value imports.
export async function probe({ Client, StdioClientTransport, CiToolController, createRunner, piExtension, ompExtension }: {
  Client: typeof McpClient;
  StdioClientTransport: typeof McpTransport;
  CiToolController: typeof Controller;
  createRunner: typeof RunnerFactory;
  piExtension: Extension;
  ompExtension: Extension;
}, scenario: CiProbeScenario): Promise<void> {
  assert.deepEqual(process.execArgv, []);
  assert.equal(process.env.NODE_OPTIONS, '');
  // Live preview is opt-in: the flag-off assertions below must not depend on the caller's environment.
  delete process.env.CEZ_PREVIEW;
  delete process.env.CEZ_AUTOMATIONS;
  const controller = await CiToolController.start();
  let count = 0;
  const wait = { id:'11111111-1111-4111-8111-111111111111', generation:'generation', turnId:'turn', timeoutSeconds:1800, prUrl:'https://github.com/owner/repo/pull/1', repository:'owner/repo', prNumber:1, headSha:'a'.repeat(40), registeredAt:'2026-09-22T00:00:00.000Z', deadline:'2026-09-22T00:30:00.000Z', until:'checks' as const, wakeOnConflict:true, phase:'registered' as const };
  const session = controller.provision({
    registerWait: async () => { count++; return { answer: { ok:true, wait_id:wait.id, kind:scenario.kind, deadline:wait.deadline, open_waits:[] }, wait: { ...wait, ...scenario } }; },
    cancelWait: async () => ({ cancelled:true, wait_id:wait.id, open_waits:[] }),
    ask: async () => { throw new Error('Unexpected ask in installed CI smoke'); },
    finishTurn: async () => { throw new Error('Unexpected finish in installed CI smoke'); },
  });
  assert.equal(session.descriptor.args.length, 1);
  assert.match(session.descriptor.args[0]!, /mcp\.js$/);
  const client = new Client({ name:'installed-ci-smoke', version:'1' });
  try {
   await client.connect(new StdioClientTransport({ ...session.descriptor, env:session.env, stderr:'pipe' }));
   assert.match(client.getInstructions() ?? '', /^The interface to (Cezarion|Squawk)[^\n]*\n- cezar_wait: /);
   // hearsay-tools/cezarion#1236: the deprecated CI alias is gone.
   assert.ok(!(client.getInstructions() ?? '').includes('cezar_wait_for_ci'));
   const tools = await client.listTools();
   const defaultTools = ['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_schedule_task', 'cezar_scheduled_tasks'];
   assert.deepEqual(tools.tools.map(tool => tool.name), defaultTools);
   const optedOutClient = new Client({ name:'installed-opt-out-smoke', version:'1' });
   try {
     await optedOutClient.connect(new StdioClientTransport({ ...session.descriptor, env:{ ...session.env, CEZ_AUTOMATIONS:'0', HSQ_AUTOMATIONS:'0' }, stderr:'pipe' }));
     assert.deepEqual((await optedOutClient.listTools()).tools.map(tool => tool.name), defaultTools.slice(0, 4));
   } finally { await optedOutClient.close(); }
   // Flag unset: neither preview tool appears in the listing or in the instructions.
   assert.ok(!tools.tools.some(tool => tool.name === 'cezar_preview_serve'));
   assert.ok(!(client.getInstructions() ?? '').includes('cezar_preview_serve'));
   assert.ok(!tools.tools.some(tool => tool.name === 'cezar_preview_stop'));
   assert.ok(!(client.getInstructions() ?? '').includes('cezar_preview_stop'));
   assert.equal(count, 0);
   // Flag set: the installed adapter lists both preview tools with their trigger lines.
   const previewClient = new Client({ name:'installed-preview-smoke', version:'1' });
   try {
     await previewClient.connect(new StdioClientTransport({ ...session.descriptor, env:{ ...session.env, CEZ_PREVIEW:'1' }, stderr:'pipe' }));
     assert.deepEqual((await previewClient.listTools()).tools.map(tool => tool.name), [...defaultTools.slice(0, 4), 'cezar_preview_serve', 'cezar_preview_stop', ...defaultTools.slice(4)]);
     assert.match(previewClient.getInstructions() ?? '', /^- cezar_preview_serve: load when you have started, or are about to start, a web server the user should click through\.$/m);
     assert.match(previewClient.getInstructions() ?? '', /^- cezar_preview_stop: load when your Cezar-started preview server needs stopping or restarting\.$/m);
   } finally { await previewClient.close(); }
   const opened = await client.callTool({ name:'cezar_wait', arguments:{ kind:scenario.kind, pr:wait.prUrl } });
   assert.notEqual(opened.isError, true);
   assert.match(JSON.stringify(opened), new RegExp(wait.id));
   assert.match(JSON.stringify(opened), /End your turn to wait/);
   const closed = await client.callTool({ name:'cezar_cancel_wait', arguments:{ wait_id:wait.id } });
   assert.notEqual(closed.isError, true);
   assert.equal(count, 1);
   Object.assign(process.env, session.env);
   const registered: RegisteredTool[] = [];
   piExtension({ registerTool(tool) { registered.push(tool); } });
   assert.deepEqual(registered.map(tool => tool.name), defaultTools);
   const piResult = await registered[0]!.execute('pi-call', {kind:scenario.kind, pr:wait.prUrl});
   assert.notEqual(piResult.isError, true);
   assert.equal(count, 2);
   const ompRegistered: RegisteredTool[] = [];
   ompExtension({ registerTool(tool) { ompRegistered.push(tool); } });
   assert.deepEqual(ompRegistered.map(tool => tool.name), defaultTools);
   const ompResult = await ompRegistered[0]!.execute('omp-call', {kind:scenario.kind, pr:wait.prUrl});
   assert.notEqual(ompResult.isError, true);
   assert.equal(count, 3);
   process.env.CEZ_DRY_RUN = '1';
   delete process.env.CEZ_CODEX_BIN;
   delete process.env.CEZ_OPENCODE_BIN;
   delete process.env.CEZ_OMP_BIN;
   for (const backend of ['codex', 'opencode', 'omp'] as const) {
     const events: AgentEvent[] = [];
     await createRunner(backend).run({ cwd:process.cwd(), userPrompt:'mock:ci-wait ' + wait.prUrl, toolGrant:{kind:'unset'}, squawkTools:session.descriptor, env:session.env, timeoutMs:10_000 }, event => events.push(event));
     assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events));
   }
   assert.equal(count, 6);
   console.log('installed CI adapters passed');
  } finally { await client.close(); await controller.close(); }
}
