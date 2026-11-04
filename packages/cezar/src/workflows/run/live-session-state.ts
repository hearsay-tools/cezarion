import type { AgentSession } from '../../core/agent-runner.ts';
import type { DelegationExecutionSettings } from './types.ts';
import { ReadonlySetView } from './readonly-collections.ts';

/** The live session handles have one owner. The runner session remains the same capability. */
export class SessionGroup {
  #delegationSettings: DelegationExecutionSettings | undefined;
  #revokeDelegation: (() => void) | undefined;
  #revokeCiTools: (() => void) | undefined;
  #ciGeneration: string | undefined;
  #cancelled = false;
  #finishRequested: boolean | undefined;
  #interrupt: () => void = () => undefined;
  #cwd: string;
  #session: AgentSession | undefined;
  #pendingPermissions = new Set<string>();
  #permissionsView = new ReadonlySetView(this.#pendingPermissions);
  #agentSessionError: string | undefined;
  #currentStepId: string | undefined;
  #sessionEverOpened: boolean | undefined;
  #releaseRepoRoot: (() => void) | undefined;

  constructor(cwd: string) { this.#cwd = cwd; Object.freeze(this); }
  get delegationSettings(): DelegationExecutionSettings | undefined { return this.#delegationSettings; }
  get revokeDelegation(): (() => void) | undefined { return this.#revokeDelegation; }
  get revokeCiTools(): (() => void) | undefined { return this.#revokeCiTools; }
  get ciGeneration(): string | undefined { return this.#ciGeneration; }
  get cancelled(): boolean { return this.#cancelled; }
  /** Explicit human Finish survives disposal; shutdown-only results do not settle. */
  get finishRequested(): boolean | undefined { return this.#finishRequested; }
  get interrupt(): () => void { return this.#interrupt; }
  /** The task worktree, or the repository root. */
  get cwd(): string { return this.#cwd; }
  get session(): AgentSession | undefined { return this.#session; }
  /** Native grants belong only to this live session generation. */
  get pendingPermissions(): ReadonlySet<string> { return this.#permissionsView; }
  get agentSessionError(): string | undefined { return this.#agentSessionError; }
  get currentStepId(): string | undefined { return this.#currentStepId; }
  /** Distinguishes startup buffering from a genuinely closed session. */
  get sessionEverOpened(): boolean | undefined { return this.#sessionEverOpened; }
  /** Exclusive repository-root execution lease; worktree-backed runs do not need it. */
  get releaseRepoRoot(): (() => void) | undefined { return this.#releaseRepoRoot; }

  captureDelegationSettings(settings: DelegationExecutionSettings): void {
    this.#delegationSettings = immutableSettings(settings);
  }
  installDelegationRevoker(revoke: (() => void) | undefined): void { this.#revokeDelegation = revoke; }
  clearDelegationRevoker(): void { this.#revokeDelegation = undefined; }
  installCiRevoker(revoke: () => void): void { this.#revokeCiTools = revoke; }
  clearCiRevoker(): void { this.#revokeCiTools = undefined; }
  beginCiGeneration(generation: string): void { this.#ciGeneration = generation; }
  cancel(): void { this.#cancelled = true; }
  requestFinish(): void { this.#finishRequested = true; }
  installInterrupt(interrupt: () => void): void { this.#interrupt = interrupt; }
  changeWorkingDirectory(cwd: string): void { this.#cwd = cwd; }
  attachSession(session: AgentSession): void { this.#session = session; }
  retireSession(): void { this.#session = undefined; }
  markSessionOpened(): void { this.#sessionEverOpened = true; }
  selectStep(stepId: string): void { this.#currentStepId = stepId; }
  clearStep(): void { this.#currentStepId = undefined; }
  recordSessionError(error: string | undefined): void { this.#agentSessionError = error; }
  retainRepoRootRelease(release: () => void): void { this.#releaseRepoRoot = release; }
  clearRepoRootRelease(): void { this.#releaseRepoRoot = undefined; }
  requestPermission(requestId: string): void { this.#pendingPermissions.add(requestId); }
  resolvePermission(requestId: string): boolean { return this.#pendingPermissions.delete(requestId); }
  clearPermissions(): void { this.#pendingPermissions.clear(); }
  resetPermissions(): void {
    this.#pendingPermissions = new Set();
    this.#permissionsView = new ReadonlySetView(this.#pendingPermissions);
  }
}

/** Copy only value containers. Never freeze the shared launch/profile inputs. */
function immutableSettings(settings: DelegationExecutionSettings): DelegationExecutionSettings {
  const owned = structuredClone(settings);
  if (owned.accountBinding?.claudeLayout) Object.freeze(owned.accountBinding.claudeLayout);
  if (owned.accountBinding) Object.freeze(owned.accountBinding);
  if (owned.allowedTools) Object.freeze(owned.allowedTools);
  if (owned.bashAllowlist) Object.freeze(owned.bashAllowlist);
  return Object.freeze(owned);
}

Object.freeze(SessionGroup.prototype);
Object.freeze(SessionGroup);
export function createSessionGroup(cwd: string): SessionGroup { return new SessionGroup(cwd); }
