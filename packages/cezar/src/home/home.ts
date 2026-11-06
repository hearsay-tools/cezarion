/** Resolved cockpit paths. Legacy cache paths deliberately have a different root. */
export interface Home {
  readonly root: string;
  readonly workspaceConfig: string;
  readonly workspaceUiState: string;
  readonly agentAccounts: string;
  readonly remoteSettings: string;
  readonly serverInstances: string;
  readonly versions: string;
  readonly bin: string;
  readonly dryCache: string;
  readonly dryPrefix: string;
  readonly backups: string;
  readonly applicationUpdates: string;
  readonly cache: string;
  readonly skillsCache: string;
  readonly skillFilesCache: string;
  /** The nonempty legacy override, kept as data for the managed launcher. */
  readonly rootOverride: string | undefined;
  serverState(instance?: string): string;
  serverLock(instance?: string): string;
}
