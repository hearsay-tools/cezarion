import { useConfig, useProviderStatus } from '@/api/queries'
import { providersRequiredByWorkflow, type ApiRun, type Runner } from '@open-mercato/cezar-api-client'
import { usableRunners } from '@/lib/provider-status'
import { resolveRunner } from '@/routes/new-task-form'
import { isStoppedBeforeStarting } from './run-actions'

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
  const reason = needsConfig && config.isPending
    ? 'Checking task settings…'
    : needsConfig && config.isError
      ? 'Task settings could not be loaded.'
      : providers.isPending
        ? 'Checking agent providers…'
        : providers.isError
          ? 'Provider authentication could not be verified.'
          : canContinue
            ? undefined
            : untouched
              ? `Connect the required workflow providers (${missing.join(', ')}) to continue.`
              : 'Connect an agent provider to continue.'

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
