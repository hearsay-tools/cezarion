import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ciWaitRequestSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { callCiWait, monitorCiOwner } from './client.ts';

export const ciToolDefinition = {
  name: 'cezar_wait_for_ci',
  description: 'Register a bounded CI wait for a GitHub pull request. End your turn after registration; Cezar resumes you with an observation. No marker is needed. Passing reported checks does not prove all expected workflows appeared and is not merge approval.',
  inputSchema: { ...z.toJSONSchema(ciWaitRequestSchema, { io: 'input' }), type: 'object' as const },
};
export async function invokeCiTool(input: unknown) {
  try {
    const receipt = await callCiWait(input);
    return { content: [{ type: 'text' as const, text: `${JSON.stringify(receipt)}\nRegistered. Please end your turn to wait; no marker is needed. This observation is not merge approval.` }], details: receipt };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'CI tool unavailable' }], details: {} };
  }
}
export async function serveCiMcp(): Promise<void> {
  const server = new Server({ name: 'cezar-ci', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [ciToolDefinition] }));
  server.setRequestHandler(CallToolRequestSchema, async request => request.params.name === ciToolDefinition.name ? invokeCiTool(request.params.arguments) : { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] });
  const finish = () => { void server.close().finally(() => process.exit(0)); };
  const stop = monitorCiOwner(finish);
  process.stdin.once('end', finish);
  server.onclose = () => { stop(); process.stdin.removeListener('end', finish); };
  await server.connect(new StdioServerTransport());
}
// The module also supplies Pi with the same contract/renderer; importing it must not start stdio.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serveCiMcp();
