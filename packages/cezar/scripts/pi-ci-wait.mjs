// Pi 0.87.0 extension API accepts JSON Schema (TypeBox-compatible parameters).
// Resolve beside this installed script; no private workspace dependency or download.
import { existsSync } from 'node:fs';
const source = new URL('../src/ci-wait/tools.ts', import.meta.url);
const { cezarTools } = await import(existsSync(source) ? source.href : new URL('../dist/ci-wait/tools.js', import.meta.url).href);
// #781: the shared cezar tool list, read in Pi's own process, whose env carries the opt-in.
export default function ciWaitExtension(pi) {
  for (const tool of cezarTools(process.env)) {
    pi.registerTool({
      name: tool.definition.name,
      label: tool.label,
      description: tool.definition.description,
      parameters: tool.definition.inputSchema,
      async execute(_toolCallId, params) { return tool.invoke(params); },
    });
  }
}
