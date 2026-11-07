/**
 * Acquire run-family claims for a store. `RunStore.claimFamilies` is a thin call into
 * `claimStoreFamilies`; liveness is judged here (`claimOwnerLive`), outside the write
 * transaction.
 */
import { claimOwnerLive, type ClaimOwner } from './run-claims.ts';
import { RunDatabaseBusyError, type RunDatabase } from './run-database.ts';

/** How many times open (or an adoption) tries to take its claims while another connection holds
 *  the write lock, each waiting out the 50 ms busy timeout: recovery cannot start without them. */
const ADOPT_CLAIM_ATTEMPTS = 10;

type ClaimExpect = { session: string; generation: number } | null;
type ClaimTake = { family: string; expect: ClaimExpect };
type ClaimDb = Pick<RunDatabase, 'getClaims' | 'familyHasLive' | 'takeClaims'>;

/** The maps and database a store uses to take family claims. */
export interface FamilyClaimState {
  claimed: Map<string, number>;
  pendingClaims: Map<string, ClaimExpect>;
  db: ClaimDb | null;
  owner: ClaimOwner | undefined;
  scheduleSave(): void;
}

/**
 * Make sure this store claims each of `families`, taking every one no live process holds, and
 * return the ones it now holds. Liveness is judged here (`claimOwnerLive`), outside the write
 * transaction; `takeClaims` then takes a claim only if it is still exactly what was judged.
 *
 * `allowLive` also takes a family that still has a live row although no live process owns it.
 * Open and `adoptFamily` pass it, because recovery follows both, and so does a write moving a
 * run this store holds into a new family (a worker quarantined to `invalid` becomes its own):
 * an ordinary write must not quietly inherit a dead process's live run and leave it unrecovered.
 * `wait` retries a busy database instead of leaving the claim to the next write: recovery
 * cannot start without it.
 */
export function claimStoreFamilies(
  state: FamilyClaimState,
  families: Iterable<string>,
  opts: { allowLive?: boolean; wait?: boolean } = {},
): Set<string> {
  const { owned, wanted } = partitionClaimedFamilies(state, families);
  if (!state.db || !state.owner || wanted.length === 0) return owned;
  const take = familiesToTake(state.db, wanted, opts.allowLive);
  if (take.length === 0) return owned;
  return takeFamilyClaims(state, state.db, state.owner, owned, take, opts.wait);
}

function partitionClaimedFamilies(
  state: Pick<FamilyClaimState, 'claimed' | 'pendingClaims'>,
  families: Iterable<string>,
): { owned: Set<string>; wanted: string[] } {
  const owned = new Set<string>();
  const wanted: string[] = [];
  for (const family of new Set(families)) {
    if (state.claimed.has(family) || state.pendingClaims.has(family)) owned.add(family);
    else wanted.push(family);
  }
  return { owned, wanted };
}

function familiesToTake(
  db: Pick<RunDatabase, 'getClaims' | 'familyHasLive'>,
  wanted: readonly string[],
  allowLive?: boolean,
): ClaimTake[] {
  const claims = db.getClaims(wanted);
  const take: ClaimTake[] = [];
  for (const family of wanted) {
    const claim = claims.get(family);
    if (claim && claimOwnerLive(claim)) continue;
    if (!allowLive && db.familyHasLive(family)) continue;
    take.push({ family, expect: claim ? { session: claim.session, generation: claim.generation } : null });
  }
  return take;
}

function takeFamilyClaims(
  state: FamilyClaimState,
  db: Pick<RunDatabase, 'takeClaims'>,
  owner: ClaimOwner,
  owned: Set<string>,
  take: readonly ClaimTake[],
  wait?: boolean,
): Set<string> {
  let taken: Map<string, number>;
  try {
    taken = retryTakeClaims(db, owner, take, wait ? ADOPT_CLAIM_ATTEMPTS : 1);
  } catch (error) {
    if (!(error instanceof RunDatabaseBusyError)) throw error;
    // Recovery follows an adoption, so it must hold the claim first: those families stay
    // unclaimed and orphaned (a control or the next restart adopts them). A write does not wait:
    // its next transaction takes the claim (`fence`), or meets whoever took it meanwhile.
    if (wait) return owned;
    for (const { family, expect } of take) {
      state.pendingClaims.set(family, expect);
      owned.add(family);
    }
    state.scheduleSave();
    return owned;
  }
  for (const [family, generation] of taken) {
    state.claimed.set(family, generation);
    owned.add(family);
  }
  // A claim taken for a write that then changes nothing still leaves at the next sweep.
  if (taken.size > 0) state.scheduleSave();
  return owned;
}

/** `takeClaims`, retried while another connection holds the write lock (each try waits out the
 *  busy timeout), then the busy error. */
function retryTakeClaims(
  db: Pick<RunDatabase, 'takeClaims'>,
  owner: ClaimOwner,
  take: Parameters<RunDatabase['takeClaims']>[1],
  attempts: number,
): Map<string, number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return db.takeClaims(owner, take);
    } catch (error) {
      if (!(error instanceof RunDatabaseBusyError) || attempt >= attempts) throw error;
    }
  }
}
