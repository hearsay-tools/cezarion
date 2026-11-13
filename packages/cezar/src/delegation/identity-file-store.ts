import { posixIdentityFileStore } from './posix-workspace-identity.ts';

/**
 * Where the ownership policy in `workspace-record.ts` keeps its identity files: the receipt directory,
 * receipts, cleanup checkpoints and Git administration markers. The store owns the platform's
 * safety rules; the policy owns what the files prove (ADR 0032).
 *
 * A process entry installs the store for its host. Only entries import the Windows store, so the
 * policy and its many importers never load it (hearsay-tools/cezarion#3244).
 */
export interface IdentityFileStore {
  /** Create the private receipt directory when `create` is set, and refuse an existing unsafe one. */
  directory(path: string, create: boolean): Promise<void>;
  /** Read an identity file of at most `cap` bytes. `privateParent` is false for a marker in Git's admin directory. */
  read(path: string, cap: number, privateParent: boolean): Promise<string>;
  /** Create a new private identity file; fail when one exists. */
  write(path: string, content: string, privateParent: boolean): Promise<void>;
  /** Replace a private identity file atomically. `assertCurrent` throws when the caller lost ownership. */
  replace(path: string, content: string, cap: number, assertCurrent?: () => void): Promise<void>;
}

let installed: IdentityFileStore | undefined;

/** Install the store for this process; `undefined` restores the host default. */
export function installIdentityFileStore(store: IdentityFileStore | undefined): void {
  installed = store;
}

/** The installed store, else the POSIX store on a non-Windows host. Windows has no default. */
export function identityFileStore(): IdentityFileStore {
  if (installed) return installed;
  if (process.platform === 'win32') {
    throw new Error('No workspace identity store is installed: a Windows process entry must call installWindowsIdentityStore');
  }
  return posixIdentityFileStore;
}
