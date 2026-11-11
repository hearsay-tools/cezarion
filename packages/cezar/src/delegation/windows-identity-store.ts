import { installIdentityFileStore, type IdentityFileStore } from './identity-file-store.ts';
import { windowsIdentityDirectory, windowsReadIdentity, windowsWriteIdentity } from './windows-workspace-identity.ts';

/** Protected ACLs through the native helper (ADR 0032); a replace overwrites in place, atomically. */
export const windowsIdentityFileStore: IdentityFileStore = {
  directory: async (path, create) => { windowsIdentityDirectory(path, create); },
  read: async (path, cap, privateParent) => windowsReadIdentity(path, cap, privateParent),
  write: async (path, content, privateParent) => { windowsWriteIdentity(path, content, false, privateParent); },
  replace: async (path, content) => { windowsWriteIdentity(path, content, true); },
};

/** Called by each process entry that reaches `workspace.ts`; installs the Windows store on a Windows host only. */
export function installWindowsIdentityStore(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') installIdentityFileStore(windowsIdentityFileStore);
}
