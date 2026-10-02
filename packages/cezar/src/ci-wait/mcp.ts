import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { monitorCiOwner } from './client.ts';
import { cezarServerInstructions, cezarTools } from './tools.ts';

// Existing importers read the CI tool from here.
export { ciToolDefinition, invokeCiTool } from './tools.ts';

// #497: deferred-tool harnesses show a bare tool name until the agent loads its
// schema, so the initialize instructions carry one trigger line per listed tool.
export function createCiMcpServer(env: NodeJS.ProcessEnv = process.env): Server {
  const tools = cezarTools(env);
  const server = new Server({ name: 'cezar-ci', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: cezarServerInstructions(env) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => tool.definition) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.find(candidate => candidate.definition.name === request.params.name);
    return tool ? tool.invoke(request.params.arguments) : { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] };
  });
  return server;
}
export async function serveCiMcp(): Promise<void> {
  const server = createCiMcpServer();
  const finish = () => { void server.close().finally(() => process.exit(0)); };
  const stop = monitorCiOwner(finish);
  process.stdin.once('end', finish);
  server.onclose = () => { stop(); process.stdin.removeListener('end', finish); };
  await server.connect(new StdioServerTransport());
}
// The module also supplies Pi with the same contract/renderer; importing it must not start stdio.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serveCiMcp();
