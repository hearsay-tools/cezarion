import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ciToolDefinition, createCiMcpServer } from './mcp.ts';

// #497: tools reach a deferred-tool harness as bare names, so the initialize
// instructions are the only text an agent sees before it spends a ToolSearch.
describe('cezar-ci MCP server instructions', () => {
  it('returns an introduction and one trigger line per listed tool on initialize', async () => {
    const server = createCiMcpServer();
    const client = new Client({ name: 'instructions-test', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
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
      for (const key of Object.keys(ciToolDefinition.inputSchema.properties ?? {})) expect(instructions).not.toMatch(new RegExp(`\\b${key}\\b`));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
