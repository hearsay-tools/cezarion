import {
  isRuntimeProviderAuthFailure,
  type ProviderAuthService,
  type ProviderId,
  type ProviderStatus,
} from '../core/provider-auth.ts';
import type { RunEvent, RunStore } from '../runs/store.ts';
import {
  resolveRuntimeAuthVerificationTarget,
  type RuntimeAuthVerificationTarget,
} from '../workspace/agent-profiles.ts';

const AUTH_ERROR_EVENT_TYPES = new Set(['error', 'session.error', 'note']);

/** Where the self-check's probe is aimed. Injectable so tests can pin the account resolution;
 *  the default reads `~/.cezar/agent-accounts.json` (see {@link resolveRuntimeAuthVerificationTarget}).
 *  Resolving to `null` means "this incident cannot be checked" — the latch then stands. */
export type RuntimeAuthProfileResolver = (
  provider: ProviderId,
  profileId: string | undefined,
) => Promise<RuntimeAuthVerificationTarget | null>;

/**
 * Watch a run store for the vendor errors that mean "your credentials were rejected", latch the
 * provider, and — because the latch is only ever as good as the pattern match that raised it —
 * immediately ask the provider's own CLI whether it was true.
 *
 * The self-check is aimed at the account the failing step actually ran under (`step.profileId`,
 * falling back to the run's `agentProfile` for step-less errors): a named account can be rejected
 * while the default login is fine, and verifying the default would clear the latch and let every
 * future run on the broken account fail again. When the recorded account cannot be resolved at
 * all, the incident stays latched — an unverifiable rejection is not a recovered one.
 *
 * `onProviderStatus` carries BOTH edges: the invalidation, and the recovery when the self-check
 * finds the credentials were never gone. One callback rather than two on purpose — every caller
 * wires it to the same `provider-status` fan-out, and the cockpit already folds a `connected` row
 * over a latched one (`applyProviderStatusRow` drops the stale incident id), so recovery needs no
 * new wiring at any of the observer's construction sites.
 */
export function watchProviderRuntimeAuthFailures(
  store: RunStore,
  providerAuth: ProviderAuthService,
  onProviderStatus: (status: ProviderStatus) => void,
  resolveProfile: RuntimeAuthProfileResolver = resolveRuntimeAuthVerificationTarget,
): () => void {
  const onEvent = ({ runId, event }: { runId: string; event: RunEvent }): void => {
    if (!AUTH_ERROR_EVENT_TYPES.has(event.type)) return;
    const message = event.message;
    if (typeof message !== 'string' || !isRuntimeProviderAuthFailure(message)) return;

    const run = store.getRun(runId);
    if (!run) return;
    const step = typeof event.stepId === 'string'
      ? run.steps.find(({ id }) => id === event.stepId)
      : undefined;
    const provider: ProviderId = step?.backend ?? run.runner ?? 'claude';
    const report = providerAuth.reportRuntimeAuthFailure(provider);
    if (!report) return;
    if (report.transitioned) onProviderStatus(report.status);

    const duplicate = store.readEvents(runId).some((candidate) =>
      candidate.type === 'provider-auth-required'
      && candidate.provider === provider
      && candidate.authFailureId === report.status.authFailureId);
    if (!duplicate) {
      store.appendEvent(runId, {
        type: 'provider-auth-required',
        provider,
        authFailureId: report.status.authFailureId,
        ...(event.stepId ? { stepId: event.stepId } : {}),
      });
    }

    // The self-check rides the LATCH EDGE, not every matching line: the second and third auth-shaped
    // error of one failing run describe the incident already standing, and re-asking the CLI about it
    // would only spend spawns on an answer we have. The service's own cooldown backstops the case the
    // edge cannot see — a rejection that re-latches right after a successful recovery.
    if (!report.transitioned) return;
    void (async () => {
      const target = await resolveProfile(provider, step?.profileId ?? run.agentProfile);
      // An account we cannot name cannot be verified: leave the latch exactly as it stands and let
      // Settings' Try again — which asks no such question — stay the way out.
      if (!target) return;
      const recovered = target.kind === 'profile'
        ? await providerAuth.verifyRuntimeAuthFailure(provider, {
          id: target.id,
          configDir: target.configDir,
        })
        : await providerAuth.verifyRuntimeAuthFailure(provider);
      if (recovered) onProviderStatus(recovered);
    })().catch(() => {});
  };

  store.on('event', onEvent);
  return () => store.off('event', onEvent);
}

/**
 * Process-wide dedupe for store observation. The same boot store is wired
 * before recovery and again when the HTTP app is constructed; lazy stores are
 * wired both at creation and at the existing context-built hook. One listener
 * per RunStore keeps those lifecycle overlaps harmless.
 */
export class ProviderRuntimeAuthObserver {
  private readonly watched = new WeakSet<RunStore>();

  constructor(
    private readonly providerAuth: ProviderAuthService,
    private readonly onProviderStatus: (status: ProviderStatus) => void,
    private readonly resolveProfile: RuntimeAuthProfileResolver = resolveRuntimeAuthVerificationTarget,
  ) {}

  watch(store: RunStore): void {
    if (this.watched.has(store)) return;
    this.watched.add(store);
    watchProviderRuntimeAuthFailures(store, this.providerAuth, this.onProviderStatus, this.resolveProfile);
  }
}

/**
 * Boot ordering seam: observation must exist before recovery starts because a
 * resumed runner can emit its first normalized error before recover() returns.
 */
export async function recoverWithProviderRuntimeAuthObservation(
  store: RunStore,
  recover: () => Promise<void>,
  observer: ProviderRuntimeAuthObserver,
): Promise<void> {
  observer.watch(store);
  await recover();
}
