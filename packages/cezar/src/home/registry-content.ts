/** Count only registry collections. Other home files never acquire a reset flag. */
export function registryCount(file: string, bytes: Buffer | null): number | undefined {
  const key = file === 'config.json' ? 'projects' : file === 'agent-accounts.json' ? 'accounts' : undefined;
  if (!key || bytes === null) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries: unknown = (value as Record<string, unknown>)[key];
    return Array.isArray(entries) ? entries.length : 0;
  } catch { return undefined; }
}

