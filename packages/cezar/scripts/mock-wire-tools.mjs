// Evidence-only tool endpoint. Use the real tool definitions and stable unavailable
// receipts, without starting a controller, registering waits or reaching GitHub.
import { createCiMcpServer } from '../dist/ci-wait/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = createCiMcpServer();
await server.connect(new StdioServerTransport());
process.stdin.once('end', () => { void server.close(); });
