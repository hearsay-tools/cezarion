import {
  configuredString,
  firstConfiguredModel,
  firstConfiguredProvider,
  type NativeSettingsFile,
  readNativeSettingsFiles,
} from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * pi's native-settings policy, expressed the same way every other runner's is.
 *
 * Pi keeps its startup model as two keys — `defaultProvider` and `defaultModel` — in
 * `~/.pi/agent/settings.json` and `.pi/settings.json` (project over global, per the catalog's
 * `modelPriority`). Its `--model` flag accepts `provider/id`, which is also the shape cezar's own
 * pi presets use, so the two keys compose into one id here; a bare `defaultModel` with no provider
 * passes through unchanged rather than being guessed at. No file at all reports "no native
 * default", and the cockpit falls back to cezar's preset for pi.
 *
 * The project file counts only when Pi itself would read it. cezar launches Pi in `--mode rpc`,
 * which never prompts for project trust: without a saved decision Pi falls back to the global
 * `defaultProjectTrust`, and `ask` (its default) or `never` ignore `.pi/settings.json` outright.
 * The run engine passes the native default on as `--model`, so a model read from a file Pi
 * ignores would be forced onto a run Pi would have started differently. Only the documented
 * `"always"` value in the global file is treated as trust; Pi's saved per-folder decisions
 * (`trust.json`) have no documented format and are not read, so a project trusted that way
 * under-reports to the global default rather than guessing.
 */
function trustedByGlobalSettings(files: readonly NativeSettingsFile[]): boolean {
  const global = files.find((file) => file.def.scope === 'user');
  return global !== undefined && configuredString(global, 'defaultProjectTrust') === 'always';
}

export const piModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'pi',
  async read(repoRoot, env) {
    const all = await readNativeSettingsFiles('pi', repoRoot, env);
    const files = trustedByGlobalSettings(all) ? all : all.filter((file) => file.def.scope !== 'project');
    const provider = firstConfiguredProvider(files);
    const model = firstConfiguredModel(files);
    return {
      ...(model ? { model: provider && !model.includes('/') ? `${provider}/${model}` : model } : {}),
      ...(provider ? { provider } : {}),
    };
  },
};
