// Pi 0.87.0 extension API accepts JSON Schema (TypeBox-compatible parameters).
// Resolve beside this installed script; no private workspace dependency or download.
import { existsSync } from 'node:fs';
const source = new URL('../src/ci-wait/mcp.ts', import.meta.url);
const { ciToolDefinition, invokeCiTool } = await import(existsSync(source) ? source.href : new URL('../dist/ci-wait/mcp.js', import.meta.url).href);
export default function ciWaitExtension(pi) {
  pi.registerTool({
    name: ciToolDefinition.name,
    label: 'Wait for CI',
    description: ciToolDefinition.description,
    parameters: ciToolDefinition.inputSchema,
    async execute(_toolCallId, params) { return invokeCiTool(params); },
  });
}
