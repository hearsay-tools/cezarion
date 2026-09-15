import {
  firstConfiguredModel,
  firstConfiguredProvider,
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
 */
export const piModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'pi',
  async read(repoRoot, env) {
    const files = await readNativeSettingsFiles('pi', repoRoot, env);
    const provider = firstConfiguredProvider(files);
    const model = firstConfiguredModel(files);
    return {
      ...(model ? { model: provider && !model.includes('/') ? `${provider}/${model}` : model } : {}),
      ...(provider ? { provider } : {}),
    };
  },
};
