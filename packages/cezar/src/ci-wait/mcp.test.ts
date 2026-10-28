import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCiMcpServer } from './mcp.ts';
import { cezarTools } from './tools.ts';

async function connect(env: NodeJS.ProcessEnv) {
  const server = createCiMcpServer(env);
  const client = new Client({ name: 'instructions-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// A trigger line names a situation, never the schema. One exception: research task 77dfb5c4
// tested the cezar_ask trigger that names its context field (hearsay-tools/cezarion#1458).
function expectNoSchemaKeyIn(instructions: string, env: NodeJS.ProcessEnv) {
  for (const { definition } of cezarTools(env)) {
    const keys = Object.keys(definition.inputSchema.properties ?? {}).filter(key => !(definition.name === 'cezar_ask' && key === 'context'));
    for (const key of keys) expect(instructions).not.toMatch(new RegExp(`\\b${key}\\b`));
  }
}

// #497: tools reach a deferred-tool harness as bare names, so the initialize
// instructions are the only text an agent sees before it spends a ToolSearch.
describe('cezar-ci MCP server instructions', () => {
  it('returns an introduction and one trigger line per listed tool on initialize', async () => {
    const { client, close } = await connect({ CEZ_PREVIEW: '1' });
    try {
      const instructions = client.getInstructions();
      expect(instructions).toBeTypeOf('string');
      const [intro, ...lines] = instructions!.split('\n').filter(Boolean);
      expect(intro).toMatch(/Cezarion/);
      const { tools } = await client.listTools();
      expect(lines).toHaveLength(tools.length);
      for (const tool of tools) expect(lines.some(line => line.startsWith(`- ${tool.name}:`))).toBe(true);
      expect(lines.some(line => line.startsWith('- cezar_wait_for_ci:'))).toBe(false);
      expect(lines.find(line => line.startsWith('- cezar_wait:'))).toMatch(/waiting on CI for a PR/);
      expect(lines.find(line => line.startsWith('- cezar_ask:'))).toMatch(/user decision or missing input; provide the full draft/);
      expectNoSchemaKeyIn(instructions!, { CEZ_PREVIEW: '1' });
    } finally { await close(); }
  });

  // #781: the preview tool is listed only under the exact opt-in.
  it('lists cezar_preview_serve with its trigger line only when CEZ_PREVIEW=1', async () => {
    const on = await connect({ CEZ_PREVIEW: '1' });
    try {
      expect((await on.client.listTools()).tools.map(tool => tool.name)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_preview_serve', 'cezar_preview_stop']);
      const instructions = on.client.getInstructions()!;
      expect(instructions).toContain('- cezar_wait: load when you are waiting on CI for a PR or on a background job you started, or want to re-check something later; end your turn after it answers.');
      expect(instructions).toContain('- cezar_preview_serve: load when you have started, or are about to start, a web server the user should click through.');
    } finally { await on.close(); }
    for (const value of [undefined, '0', 'true']) {
      const off = await connect(value === undefined ? {} : { CEZ_PREVIEW: value });
      try {
        expect((await off.client.listTools()).tools.map(tool => tool.name)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']);
        expect(off.client.getInstructions()).not.toContain('cezar_preview_serve');
      } finally { await off.close(); }
    }
  });

  // hearsay-tools/cezarion#1235: the worker kind is advertised through the MCP tool listing, with the contract's bounds.
  it('lists the worker fields of cezar_wait with their bounds', async () => {
    const { client, close } = await connect({});
    try {
      const wait = (await client.listTools()).tools.find(tool => tool.name === 'cezar_wait')!;
      const properties = wait.inputSchema.properties as Record<string, any>;
      expect(properties.kind.enum).toEqual(['pr', 'worker', 'request', 'peer', 'timer', 'process']);
      for (const [key, kind] of [['worker_ids', 'worker'], ['request_ids', 'request'], ['peer_ids', 'peer']]) {
        expect(properties[key!]).toMatchObject({ type: 'array', minItems: 1, maxItems: 32 });
        expect(properties[key!].description).toMatch(new RegExp(`^kind "${kind}":`));
      }
      expect(properties.mode.enum).toEqual(['one', 'any', 'all']);
      expect(properties.timeout_seconds.description).toMatch(/kind "worker", "request" or "peer": 1–1800, default 600/);
      expect(wait.description).toMatch(/worker/);
      expect((await client.listTools()).tools.find(tool => tool.name === 'cezar_cancel_wait')!.description).toMatch(/worker/);
    } finally { await close(); }
  });

  // hearsay-tools/cezarion#1465: the one-time schedule tools ride the automations opt-in.
  it('lists the schedule tools only with CEZ_AUTOMATIONS=1', async () => {
    const on = await connect({ CEZ_AUTOMATIONS: '1' });
    try {
      expect((await on.client.listTools()).tools.map(tool => tool.name)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done', 'cezar_schedule_task', 'cezar_scheduled_tasks']);
    } finally { await on.close(); }
    for (const value of [undefined, '0', 'true']) {
      const off = await connect(value === undefined ? {} : { CEZ_AUTOMATIONS: value });
      try {
        expect((await off.client.listTools()).tools.map(tool => tool.name)).not.toContain('cezar_schedule_task');
        expect(off.client.getInstructions()).not.toContain('cezar_scheduled_tasks');
      } finally { await off.close(); }
    }
  });

  it('server instructions carry one trigger line per schedule tool', async () => {
    const env = { CEZ_AUTOMATIONS: '1', CEZ_PREVIEW: '1' };
    const { client, close } = await connect(env);
    try {
      const instructions = client.getInstructions()!;
      expect(instructions).toContain('- cezar_schedule_task: load when work should start later as a new task (in an hour, tomorrow, next week) instead of keeping this session waiting.');
      expect(instructions).toContain('- cezar_scheduled_tasks: load when you need to list, change, pause, resume or cancel a one-time scheduled task.');
      expectNoSchemaKeyIn(instructions, env);
    } finally { await close(); }
  });

  it('tells the agent to pin the port and that cezar starts the command', () => {
    const preview = cezarTools({ CEZ_PREVIEW: '1' }).find(tool => tool.definition.name === 'cezar_preview_serve')!;
    expect(preview.definition.description).toContain('pin the port (`vite --strictPort`, `next dev -p`)');
    expect(preview.definition.description).toMatch(/cezar starts the command itself when the user opens the preview/i);
  });
});
