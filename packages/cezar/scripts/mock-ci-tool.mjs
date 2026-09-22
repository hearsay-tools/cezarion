// Offline harness fixtures share the real bundled MCP protocol, never a fake receipt.
import { writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function probeCiTool(backend, wire, pr = process.env.CEZ_MOCK_CI_PR) {
  if (!pr) return;
  let result;
  if (backend === 'pi') {
    const extensions = wire.flatMap((arg, index) => arg === '--extension' ? [wire[index + 1]] : []);
    const path = extensions.find(path => basename(path) === 'pi-ci-wait.mjs');
    if (!path) throw new Error('CI extension absent');
    // The real Pi loader compiles TS when running from source; installed script uses JS.
    if (existsSync(new URL('../src/ci-wait/mcp.ts', import.meta.url))) { const { register } = await import('tsx/esm/api'); register(); }
    const { default: extension } = await import(pathToFileURL(path));
    const tools = [];
    extension({ registerTool(tool) { tools.push(tool); } });
    result = { names: tools.map(tool => tool.name), response: await tools[0].execute('ci-1', { pr }) };
  } else {
    let server; let env;
    if (backend === 'claude') {
      server = Object.values(JSON.parse(wire[wire.indexOf('--mcp-config') + 1]).mcpServers)[0];
      env = Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')]));
    } else if (backend === 'codex') {
      server = Object.entries(wire.config ?? {}).find(([key]) => key.startsWith('mcp_servers.cezar_ci_'))?.[1];
      env = Object.fromEntries((server?.env_vars ?? []).map(name => [name, process.env[name]]));
    } else if (backend === 'cursor') {
      server = wire.mcpServers.find(server => server.name.startsWith('cezar_ci_'));
      env = Object.fromEntries(server?.env.map(({name,value}) => [name,value]) ?? []);
    } else {
      const local = Object.entries(wire.mcp ?? {}).find(([key]) => key.startsWith('cezar_ci_'))?.[1];
      server = local && { command: local.command[0], args: local.command.slice(1) };
      env = { ...process.env, ...local?.environment };
    }
    if (!server) throw new Error('CI server absent');
    const client = new Client({ name: 'offline-harness', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env, stderr: 'pipe' }));
      const list = await client.listTools();
      result = { names: list.tools.map(tool => tool.name), response: await client.callTool({ name: 'cezar_wait_for_ci', arguments: { pr } }) };
    } finally { await client.close(); }
  }
  if (process.env.CEZ_MOCK_CI_RESULT) writeFileSync(process.env.CEZ_MOCK_CI_RESULT, JSON.stringify(result));
  return result;
}

export async function ciPrompt(backend, wire, text) {
  const pr = /mock:ci-wait(?:\s+(https:\/\/[^\s\"\\]+))?/.exec(text)?.[1] ?? 'https://github.com/owner/repo/pull/1';
  const result = await probeCiTool(backend, wire, pr);
  return JSON.stringify(result.response);
}
