const KEPT_ENV = new Set(['ENV_PASSTHROUGH', 'AGENT_ENV_FULL', 'CODEX_BIN'].flatMap(suffix => [`CEZ_${suffix}`, `HSQ_${suffix}`]));

/** Live probes keep operator auth controls, but never inherit a task's session authority. */
export function scrubProbeSessionEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) {
    if ((/^(CEZ|HSQ)_/.test(name) && !KEPT_ENV.has(name)) || name.startsWith('CLAUDE_CODE_')) delete env[name];
  }
}
