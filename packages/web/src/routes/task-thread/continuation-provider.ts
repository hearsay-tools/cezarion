import { useConfig, useProviderStatus } from '@/api/queries'
import { providersRequiredByWorkflow } from '@open-mercato/cezar-api-client/contract/workflows'
import type { ApiRun, Runner } from '@open-mercato/cezar-api-client'
import { usableRunners } from '@/lib/provider-status'
import { resolveRunner } from '@/routes/new-task-form'
import { isStoppedBeforeStarting } from './run-actions'

/** Every question the reason chain asks, in the priority order it asks them. */
interface ContinuationReasonInput {
  needsConfig: boolean
  configPending: boolean
  configError: boolean
  providersPending: boolean
  providersError: boolean
  canContinue: boolean
  untouched: boolean
  missing: string[]
}

/** Why this surface cannot continue yet: the task-settings checks first, then the provider
 *  checks, then the connect prompt. */
function continuationReason(input: ContinuationReasonInput): string | undefined {
  return input.needsConfig && input.configPending
    ? 'Checking task settings…'
    : input.needsConfig && input.configError
      ? 'Task settings could not be loaded.'
      : input.providersPending
        ? 'Checking agent providers…'
        : input.providersError
          ? 'Provider authentication could not be verified.'
          : input.canContinue
            ? undefined
            : input.untouched
              ? `Connect the required workflow providers (${input.missing.join(', ')}) to continue.`
              : 'Connect an agent provider to continue.'
}

/** One provider decision for every UI path that reopens an existing agent session. */
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null) {
  const providers = useProviderStatus()
  const config = useConfig()
  const untouched = isStoppedBeforeStarting(run)
  const needsConfig = untouched && !run.runner
  const runners = usableRunners(providers.data)
  const currentRunner = run.runner ?? (untouched ? config.data?.defaultRunner : undefined) ?? 'claude'
  const runner = resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  const required = untouched ? providersRequiredByWorkflow(run.workflowDef!, runner) : [runner]
  const missing = required.filter(provider => !runners.includes(provider))
  const canContinue = providers.isSuccess && (!needsConfig || config.isSuccess) && missing.length === 0
  const reason = continuationReason({
    needsConfig,
    configPending: config.isPending,
    configError: config.isError,
    providersPending: providers.isPending,
    providersError: providers.isError,
    canContinue,
    untouched,
    missing,
  })

  return {
    runners,
    currentRunner,
    runner,
    currentRunnerConnected,
    canContinue,
    providerPending: providers.isPending || (needsConfig && config.isPending),
    providerError: providers.isError,
    reason,
    runnerOverride:
      pickedRunner !== null || !currentRunnerConnected
        ? runner
        : undefined,
  }
}
