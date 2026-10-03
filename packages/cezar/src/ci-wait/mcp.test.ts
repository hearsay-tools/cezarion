import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ciToolDefinition, createCiMcpServer } from './mcp.ts';
import { cezarTools } from './tools.ts';

async function connect(env: NodeJS.ProcessEnv) {
  const server = createCiMcpServer(env);
  const client = new Client({ name: 'instructions-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
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
      expect(lines.find(line => line.startsWith(`- ${ciToolDefinition.name}:`))).toMatch(/opening or updating a PR you want to watch CI on/);
      // A trigger line names a situation, never the schema.
      for (const { definition } of cezarTools({ CEZ_PREVIEW: '1' })) {
        for (const key of Object.keys(definition.inputSchema.properties ?? {})) expect(instructions).not.toMatch(new RegExp(`\\b${key}\\b`));
      }
    } finally { await close(); }
  });

  // #781: the preview tool is listed only under the exact opt-in.
  it('lists cezar_preview_serve with its trigger line only when CEZ_PREVIEW=1', async () => {
    const on = await connect({ CEZ_PREVIEW: '1' });
    try {
      expect((await on.client.listTools()).tools.map(tool => tool.name)).toEqual(['cezar_wait_for_ci', 'cezar_preview_serve']);
      const instructions = on.client.getInstructions()!;
      expect(instructions).toContain('- cezar_wait_for_ci: load when opening or updating a PR you want to watch CI on.');
      expect(instructions).toContain('- cezar_preview_serve: load when you have started, or are about to start, a web server the user should click through.');
    } finally { await on.close(); }
    for (const value of [undefined, '0', 'true']) {
      const off = await connect(value === undefined ? {} : { CEZ_PREVIEW: value });
      try {
        expect((await off.client.listTools()).tools.map(tool => tool.name)).toEqual(['cezar_wait_for_ci']);
        expect(off.client.getInstructions()).not.toContain('cezar_preview_serve');
      } finally { await off.close(); }
    }
  });

  it('tells the agent to pin the port and that cezar starts the command', () => {
    const preview = cezarTools({ CEZ_PREVIEW: '1' }).find(tool => tool.definition.name === 'cezar_preview_serve')!;
    expect(preview.definition.description).toContain('pin the port (`vite --strictPort`, `next dev -p`)');
    expect(preview.definition.description).toMatch(/cezar starts the command itself when the user opens the preview/i);
  });
});
