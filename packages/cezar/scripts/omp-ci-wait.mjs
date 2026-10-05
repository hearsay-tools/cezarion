// OMP (Oh My Pi) extension: registers cezar's tools in OMP's own process (#595). Same shape as
// pi-ci-wait.mjs; OMP's `pi.registerTool` takes the JSON Schema `parameters` as Pi does.
// Resolve beside this installed script; no private workspace dependency or download.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = new URL('../src/ci-wait/tools.ts', import.meta.url);
const built = new URL('../dist/ci-wait/tools.js', import.meta.url);
// Unlike Pi's loader, OMP's cannot resolve the workspace contract package from a source checkout
// (v18.4.11), so a failed source import falls back to the built output, but only when it exists:
// otherwise the source error is the real cause and is rethrown, not hidden behind a missing dist.
const loadBuilt = (error) => {
  if (!existsSync(fileURLToPath(built))) throw error;
  process.stderr.write('cezar: loading built cezar tools from dist/; rebuild after changing src/ci-wait\n');
  return import(built.href);
};
const { cezarTools } = await (existsSync(source) ? import(source.href).catch(loadBuilt) : import(built.href));
// #781: the shared cezar tool list, read in OMP's own process, whose env carries the opt-in.
// `ompTools` admits exactly these names to `--tools`: OMP exits 2 on a name nothing registered.
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
