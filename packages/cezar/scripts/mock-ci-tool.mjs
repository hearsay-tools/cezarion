// Offline harness fixtures share the real bundled MCP protocol, never a fake receipt.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function probeCiTool(backend, wire, pr = process.env.CEZ_MOCK_CI_PR) {
  if (!pr) return;
  return probeCezarTool(backend, wire, 'cezar_wait_for_ci', { pr });
}

// Calls one cezar tool the way the real harness would: through the wired MCP server (or Pi/OMP extension).
export async function probeCezarTool(backend, wire, name, args) {
  let result;
  if (backend === 'pi' || backend === 'omp') {
    const extensions = wire.flatMap((arg, index) => arg === '--extension' ? [wire[index + 1]] : []);
    const path = extensions.find(path => basename(path) === `${backend}-ci-wait.mjs`);
    if (!path) throw new Error('CI extension absent');
    // The real Pi loader compiles TS when running from source; installed script uses JS.
    if (existsSync(new URL('../src/ci-wait/mcp.ts', import.meta.url))) { const { register } = await import('tsx/esm/api'); register(); }
    const { default: extension } = await import(pathToFileURL(path));
    const tools = [];
    extension({ registerTool(tool) { tools.push(tool); } });
    const tool = tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`${name} not registered`);
    result = { names: tools.map(tool => tool.name), response: await tool.execute('ci-1', args) };
  } else {
    let server; let env;
    if (backend === 'claude') {
      server = Object.values(JSON.parse(wire[wire.indexOf('--mcp-config') + 1]).mcpServers)[0];
      env = Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')]));
    } else if (backend === 'codex') {
      server = Object.entries(wire.config ?? {}).find(([key]) => key.startsWith('mcp_servers.cezar_ci_'))?.[1];
      env = Object.fromEntries((server?.env_vars ?? []).map(name => [name, process.env[name]]));
    } else if (backend === 'cursor') {
      if (Array.isArray(wire)) {
        const dir = wire[wire.indexOf('--plugin-dir') + 1];
        const servers = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).mcpServers;
        server = Object.entries(servers).find(([name]) => name.startsWith('cezar_ci_'))?.[1];
        env = Object.fromEntries(Object.entries(server?.env ?? {}).map(([key, value]) =>
          [key, value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')]));
      } else {
        server = wire.mcpServers.find(server => server.name.startsWith('cezar_ci_'));
        env = Object.fromEntries(server?.env.map(({name,value}) => [name,value]) ?? []);
      }
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
      result = { names: list.tools.map(tool => tool.name), response: await client.callTool({ name, arguments: args }) };
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

// `mock:preview-serve <port>` registers the e2e fixture app (`node preview-app.mjs <port>`) as a live preview.
export async function previewPrompt(backend, wire, text) {
  const port = Number(/mock:preview-serve\s+(\d+)/.exec(text)?.[1]);
  const fixture = fileURLToPath(new URL('../../web/e2e/fixtures/preview-app.mjs', import.meta.url));
  const result = await probeCezarTool(backend, wire, 'cezar_preview_serve', { command: `node "${fixture}" ${port}`, port, label: 'web' });
  return JSON.stringify(result.response);
}
