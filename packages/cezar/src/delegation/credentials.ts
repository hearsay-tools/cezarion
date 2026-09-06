import { createHash, randomBytes } from 'node:crypto';

const callerBrand: unique symbol = Symbol('delegation caller');
const authenticatedCallers = new WeakSet<Caller>();

/** Internal identity minted by credential lookup, never deserialized from a request. */
export type Caller = Readonly<{
  projectId: string;
  runId: string;
  generation: string;
  [callerBrand]: true;
}>;

type Credential = {
  projectId: string;
  runId: string;
  generation: string;
  caller?: Caller;
};

/** Runtime check as well as a type brand: copied/forged/revoked objects carry no authority. */
export function isAuthenticatedCaller(caller: Caller): boolean {
  return authenticatedCallers.has(caller);
}

/** Ephemeral session credentials. Only SHA-256 token keys are retained, never the bearer token. */
export class CredentialRegistry {
  #credentials = new Map<string, Credential>();
  #closed = false;

  issue(projectId: string, runId: string, generation: string): string {
    if (this.#closed) throw new Error('Credential registry is closed');
    // Reprovisioning a run replaces its session authority, including on a new generation.
    this.revoke(runId);
    const token = randomBytes(32).toString('base64url');
    const key = createHash('sha256').update(token).digest('hex');
    this.#credentials.set(key, { projectId, runId, generation });
    return token;
  }

  authenticate(token: string): Caller | undefined {
    const key = createHash('sha256').update(token).digest('hex');
    const credential = this.#credentials.get(key);
    if (!credential) return undefined;
    if (!credential.caller) {
      credential.caller = Object.freeze({
        projectId: credential.projectId,
        runId: credential.runId,
        generation: credential.generation,
        [callerBrand]: true as const,
      });
      authenticatedCallers.add(credential.caller);
    }
    return credential.caller;
  }

  revoke(runId: string): void {
    for (const [key, credential] of this.#credentials) {
      if (credential.runId !== runId) continue;
      if (credential.caller) authenticatedCallers.delete(credential.caller);
      this.#credentials.delete(key);
    }
  }

  close(): void {
    this.#closed = true;
    for (const credential of this.#credentials.values()) {
      if (credential.caller) authenticatedCallers.delete(credential.caller);
    }
    this.#credentials.clear();
  }
}
