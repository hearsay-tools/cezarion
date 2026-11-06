import type { Execution, ExecutionLaunch, RunModuleContext } from './run/types.ts';
import type { LaunchConfig, LaunchSource } from './run/launch-read-resolver.ts';

/** Compile-only escapes: removing an expected-error directive must produce a direct error. */
export function launchHandleEscapes(source: LaunchSource, config: LaunchConfig): void {
  const alias = source;
  const configAlias = config;
  // @ts-expect-error source aliases cannot expose authored launch fields
  void alias.model;
  // @ts-expect-error optional reads do not expose a runner
  void alias?.runner;
  // @ts-expect-error subscript reads do not expose a task
  void alias['task'];
  // @ts-expect-error destructuring cannot unpack effort
  const { effort } = source;
  // @ts-expect-error source storage is not a public property
  void source.raw;
  // @ts-expect-error a config alias cannot expose launch defaults
  void configAlias.defaultRunner;
  // @ts-expect-error config handles have no string index
  void config['systemPrompt'];
  // @ts-expect-error source handles cannot be forged from structural records
  const forged: LaunchSource = {};
  // @ts-expect-error source and config handles have distinct private identities
  const wrong: LaunchConfig = source;
  // @ts-expect-error config handles cannot be forged from structural records
  const forgedConfig: LaunchConfig = {};
  const spread = { ...source };
  // @ts-expect-error spreading an opaque token exposes no model
  void spread.model;
  void { effort, forged, forgedConfig, wrong };
}

/** The actual execution interfaces carry tokens, not structurally branded raw records. */
export function executionHandleEscapes(execution: Execution, launch: ExecutionLaunch): void {
  const accepted = execution.input;
  const settings = launch.config;
  // @ts-expect-error execution consumers cannot extract the accepted model
  void accepted.model;
  // @ts-expect-error execution consumers cannot unpack the task
  const { task } = accepted;
  // @ts-expect-error launch consumers cannot extract a config default
  void settings.defaultRunner;
  // @ts-expect-error launch config cannot leak through a bracket read
  void settings['systemPrompt'];
  void task;
}

/** Approved boundary: lifecycle-store aliases remain raw outside the opaque launch route. */
export function lifecycleStoreAlias(context: RunModuleContext, runId: string): string | undefined {
  const first = context.store.getRun(runId);
  const second = first;
  return second?.model;
}
