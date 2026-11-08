/** Repair only installer-owned REMOTE entries; preserve launch commands and operator settings.
 * The new reader is already live with the release switch off. Both names must pin hosted mode. */
export function systemdRemoteEnv(unit: string): string {
  if (!/^Environment=CEZ_REMOTE=1$/m.test(unit)) return unit;
  return unit.replace(/^Environment=HSQ_REMOTE=.*\n/gm, '')
    .replace(/^Environment=CEZ_REMOTE=1$/gm, 'Environment=CEZ_REMOTE=1\nEnvironment=HSQ_REMOTE=1');
}

export function launchdRemoteEnv(xml: string): string {
  return xml.replace(/(<key>EnvironmentVariables<\/key>\s*<dict>)([\s\S]*?)(<\/dict>)/, (match, open: string, env: string, close: string) => {
    if (!/<key>CEZ_REMOTE<\/key>\s*<string>1<\/string>/.test(env)) return match;
    const kept = env.replace(/\s*<key>HSQ_REMOTE<\/key>\s*<string>[^<]*<\/string>/g, '');
    return open + kept.replace(/(<key>CEZ_REMOTE<\/key>\s*<string>1<\/string>)/, '$1\n      <key>HSQ_REMOTE</key>\n      <string>1</string>') + close;
  });
}
