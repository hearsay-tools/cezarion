import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-api-client/contract/agent-profiles'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { hasAccountChoice, useAgentAccounts } from '@/api/agent-accounts'
import { useAgentProfiles, useConfig } from '@/api/queries'

/** What ran this task (#416, #546): runner, account, model, effort and the canonical model
 *  identity, resolved the way the run itself resolved them. Read by the Session activity card's
 *  Usage & agent row (hearsay-tools/cezarion#1333), and before that by the header's agent badge. */
export interface AgentIdentity {
  runner: string
  account?: string
  model: string
  effort: string
  identity?: string
}

export function useAgentIdentity(run: ApiRun): AgentIdentity {
  // The record keeps only what the caller ASKED for: `POST /api/runs` persists the raw optional
  // `runner` (`src/runs/store.ts`), while the run actually executes as
  // `input.runner ?? config.defaultRunner` (`src/workflows/run.ts`). Mirror that resolution —
  // hardcoding 'claude' would name the wrong agent on a repo whose `defaultRunner` is
  // codex/opencode, and "which agent produced this?" is the one question #416 exists to answer.
  // 'claude' stays the last resort only while the active project's config is in flight.
  // `/api/health` describes the boot project and can name the wrong runner on scoped routes.
  const config = useConfig()
  const profiles = useAgentProfiles()
  const { accounts } = useAgentAccounts()
  const runner = run.runner ?? config.data?.defaultRunner ?? 'claude'
  const model = run.model ?? 'auto'
  // Unset effort means the harness default, the same way unset model reads `auto` (#411):
  // the badge answers "what am I running here?" and names the default instead of pretending
  // the question was never asked (#52's omit decision, superseded for the unpinned case).
  const effort = run.effort || 'auto'
  // The account is read from the STEP that actually spawned, never from the run's composer
  // override or the project's current selection (spec 2026-07-29-agent-profiles): the override is
  // absent whenever the run just followed the project, and the project's selection can have been
  // changed since — both would name an account this run may never have touched. The last step that
  // recorded one is what ran; `sessionId` and `profileId` are a pair for exactly this reason.
  const profileStep = [...run.steps].reverse().find((step) => step.profileId)
  const accountId = profileStep?.profileId
  // The choice count is judged against the backend that RECORDED the account, not the run's
  // `runner`: spec 2026-07-29-agent-profiles puts the account on the spawning step, and a step
  // may run a different backend than the run label — counting Claude's logins for a Codex
  // account both hides Codex accounts on a lone-Claude host and shows lone Codex logins on a
  // multi-Claude one. Steps from before the field existed fall back to the run runner.
  const accountBackend = profileStep?.backend ?? runner
  // One login is not a choice (#251, spec 2026-07-29-agent-profiles): a KNOWN account is named
  // only when its backend has two or more defined accounts — the same `hasAccountChoice`
  // count the composer pill applies — and the badge stays silent while the profiles query is in
  // flight, so a lone `default` never paints the summary just to vanish a moment later. A REMOVED
  // account is the exception to the count: the id is the only remaining pointer to the folder its
  // sessions live in, so `<id> (removed)` shows regardless of how many logins are left — deleting
  // an account must not retroactively erase which one a historical run ran under. A FAILED query
  // never settles, so silence there would be permanent; the recorded id shows verbatim, without
  // a `(removed)` claim the unreadable catalog cannot back.
  // The row must match on id AND backend: ids are unique per provider only, so a same-id
  // account on another backend is a different login (#411) — matching it would let the badge
  // claim "not removed" for a folder that is gone.
  const known = profiles.data?.profiles.find(
    (p) => p.id === accountId && p.provider === accountBackend,
  )
  const account = accountId === undefined || profiles.isPending
    ? undefined
    : profiles.isError
      ? accountId
      : accountId === DEFAULT_AGENT_ACCOUNT_ID
        // The recorded `default` is the backend's own home: discovered, never deletable — so an
        // empty or failed catalog cannot make it "(removed)" (#411), and a lone default stays
        // omitted exactly as the count rule above intends.
        ? hasAccountChoice(accounts, accountBackend) ? 'default' : undefined
        : known
          ? hasAccountChoice(accounts, accountBackend)
            ? known.label
            : undefined
          : `${accountId} (removed)`
  // The canonical `provider/model` the run actually resolved to (#405), shown only when it says
  // something `model` does not (#546). `model` is the free-text the caller ASKED for — `opus`,
  // `auto`, a gateway id — so on a repo whose Claude runner points at a custom endpoint the two
  // genuinely differ, and "which provider served this?" is a question only this field answers.
  // Absent on pre-#405 records and skipped when it merely repeats `model`, following the same
  // omitted-not-guessed rule as the account line below: an identity nothing wrote down is not
  // one this header may invent.
  const identity = run.modelIdentity && run.modelIdentity !== model ? run.modelIdentity : undefined
  return {
    runner,
    ...(account ? { account } : {}),
    model,
    effort,
    ...(identity ? { identity } : {}),
  }
}
