import { productName } from '@/lib/product-name'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { RefreshCwIcon, TriangleAlertIcon, XIcon } from '@/components/design-icons'
import {
  isSafeSkillsRef,
  SKILLS_REPO_FORMATS,
  skillsRepoKind,
} from '@open-mercato/cezar-api-client/contract/skill-sources'
import type { TeamSkillSource, TeamSkillSourceRef, TeamSkillSourcesResponse } from '@open-mercato/cezar-api-client'
import {
  addSkillSource,
  getSkillSources,
  removeSkillSource,
  retrySkillSource,
  setSkillSourceEnabled,
  skillSourcesKey,
} from '@/api/skill-sources-client'
import { queryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

/**
 * Team skill sources on the Skills page (hearsay-tools/cezarion#279): add, remove, enable and
 * disable the `skillsRepos` entries in `.ai/cezar/config.json`. Each source shows its own state,
 * so one failing repo never hides the others. The per-skill switches stay in the skills table.
 */

/** How often a source that is still fetching is read again. */
const LOADING_POLL_MS = 1_000

const sourceLabel = (source: TeamSkillSourceRef) => `${source.repo} @ ${source.ref}`

function useSkillSources() {
  return useQuery({
    queryKey: skillSourcesKey(),
    queryFn: ({ signal }) => getSkillSources({ signal }),
    // Only while a fetch runs: the server has no event for "this source finished loading".
    refetchInterval: (query) =>
      query.state.data?.sources.some((source) => source.status.state === 'loading') ? LOADING_POLL_MS : false,
  })
}

/**
 * The keys a source change touches, read for the project that is open now. A write captures them
 * when it starts, so an answer that lands after a project switch never touches the other
 * project's cache.
 */
function sourceKeys() {
  return {
    sources: skillSourcesKey(),
    // The `wait=1` reads too: one still in flight from before the change would otherwise land
    // later and bring a removed source's skills back.
    lists: [queryKeys.skills, queryKeys.skillsReady, queryKeys.importableSkills, queryKeys.importableSkillsReady],
  }
}

function invalidateSkillLists(queryClient: QueryClient, keys = sourceKeys()) {
  for (const queryKey of keys.lists) void queryClient.invalidateQueries({ queryKey, exact: true })
}

/**
 * Writes answer the new source list; the skill lists it feeds are read again. Two writes can
 * answer out of order, so the source list is also read again after each one: the last read
 * reflects every write the server finished.
 */
function useSourceMutation<T>(write: (body: T) => Promise<TeamSkillSourcesResponse>, done?: (body: T) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: T) => {
      const keys = sourceKeys()
      return { answer: await write(body), keys }
    },
    onSuccess: ({ answer, keys }, body) => {
      queryClient.setQueryData(keys.sources, answer)
      // The reread also cancels a read sent before the change, which would otherwise land after
      // it and bring the old list back (`cancelRefetch` is on by default).
      void queryClient.invalidateQueries({ queryKey: keys.sources, exact: true })
      invalidateSkillLists(queryClient, keys)
      done?.(body)
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })
}

/** When the last fetch ends, the catalog and the team list pick up what it found. */
function useRefreshWhenLoaded(data: TeamSkillSourcesResponse | undefined) {
  const queryClient = useQueryClient()
  const wasLoading = useRef(false)
  const loading = data?.sources.some((source) => source.status.state === 'loading') ?? false
  useEffect(() => {
    if (wasLoading.current && !loading) invalidateSkillLists(queryClient)
    wasLoading.current = loading
  }, [loading, queryClient])
}

export function TeamSourcesPanel() {
  const sourcesQuery = useSkillSources()
  useRefreshWhenLoaded(sourcesQuery.data)
  const toggle = useSourceMutation(setSkillSourceEnabled)
  const remove = useSourceMutation(removeSkillSource, (source) =>
    toast(`Removed ${sourceLabel(source)}. Add it again to restore its skill switches.`))
  const retry = useSourceMutation(retrySkillSource)

  const data = sourcesQuery.data
  const editable = data?.editable === true && data.configIssue === null
  const busy = toggle.isPending || remove.isPending

  return (
    <section
      data-slot="skill-sources"
      aria-labelledby="skill-sources-heading"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3 @min-[520px]:p-4"
    >
      <div>
        <h2 id="skill-sources-heading" className="text-[15px] font-semibold">Team skill sources</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Repos whose skills this project can use. Changes are saved to{' '}
          <span className="font-mono">.ai/cezar/config.json</span>.
        </p>
      </div>

      {sourcesQuery.isError ? (
        <Notice slot="skill-sources-error" alert>
          Could not load the team skill sources: {sourcesQuery.error.message}{' '}
          <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11" disabled={sourcesQuery.isFetching} onClick={() => void sourcesQuery.refetch()}>
            Retry
          </Button>
        </Notice>
      ) : null}
      {data?.configIssue ? <Notice slot="skill-sources-config-issue" alert>{data.configIssue}</Notice> : null}
      {data && !data.editable ? (
        <Notice slot="skill-sources-read-only">
          Sources are read-only on this remote cockpit. To edit them here, run{' '}
          <span className="font-mono">cez remote-settings enable</span> on the machine running {productName('cezar')}.
        </Notice>
      ) : null}

      {sourcesQuery.isPending ? (
        <p role="status" aria-busy="true" className="text-xs text-muted-foreground">Loading sources…</p>
      ) : data && data.configIssue === null && data.sources.length === 0 ? (
        <p data-slot="skill-sources-empty" className="text-xs leading-relaxed text-soft-foreground">
          No team skill sources yet. Add a repo below to use its skills in this project.
        </p>
      ) : data && data.sources.length > 0 ? (
        <ul data-slot="skill-source-list" className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {data.sources.map((source) => (
            <SourceRow
              key={JSON.stringify([source.repo, source.ref])}
              source={source}
              editable={editable}
              busy={busy}
              retrying={retry.isPending}
              onToggle={() => toggle.mutate({ repo: source.repo, ref: source.ref, enabled: !source.enabled })}
              onRemove={() => remove.mutate({ repo: source.repo, ref: source.ref })}
              onRetry={() => retry.mutate({ repo: source.repo, ref: source.ref })}
            />
          ))}
        </ul>
      ) : null}

      {data ? <AddSourceForm disabled={!editable} /> : null}
    </section>
  )
}

function Notice({ slot, alert = false, children }: { slot: string; alert?: boolean; children: ReactNode }) {
  return (
    <div
      role={alert ? 'alert' : undefined}
      data-slot={slot}
      className="flex items-start gap-2 rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground"
    >
      {alert ? <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" /> : null}
      <div className="min-w-0 break-words">{children}</div>
    </div>
  )
}

function SourceRow({
  source,
  editable,
  busy,
  retrying,
  onToggle,
  onRemove,
  onRetry,
}: {
  source: TeamSkillSource
  editable: boolean
  busy: boolean
  retrying: boolean
  onToggle: () => void
  onRemove: () => void
  onRetry: () => void
}) {
  const statusId = useId()
  const status = statusText(source)
  const failed = source.status.state === 'error'
  const canRetry = source.enabled && (failed || source.status.state === 'idle')
  return (
    <li
      data-slot="skill-source"
      data-repo={source.repo}
      data-ref={source.ref}
      data-state={source.enabled ? source.status.state : 'disabled'}
      className="flex flex-col gap-2 p-2.5 @min-[520px]:flex-row @min-[520px]:items-center"
    >
      <div className="min-w-0 flex-1">
        <p className="break-all font-mono text-[13px] text-foreground">
          {source.repo} <span className="text-muted-foreground">@ {source.ref}</span>
        </p>
        <p
          id={statusId}
          data-slot="skill-source-status"
          role={failed ? 'alert' : undefined}
          aria-live={failed ? undefined : 'polite'}
          className={failed ? 'mt-1 text-xs leading-relaxed text-danger' : 'mt-1 text-xs leading-relaxed text-muted-foreground'}
        >
          {status}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="skill-source-retry"
            className="min-h-11"
            disabled={!editable || retrying}
            aria-label={`Retry ${sourceLabel(source)}`}
            onClick={onRetry}
          >
            <RefreshCwIcon aria-hidden="true" />
            Retry
          </Button>
        ) : null}
        <span className="inline-flex min-h-11 min-w-11 items-center justify-center">
          <Switch
            data-slot="skill-source-switch"
            aria-label={`Enable ${sourceLabel(source)}`}
            aria-describedby={statusId}
            checked={source.enabled}
            disabled={!editable || busy}
            onCheckedChange={onToggle}
            className="relative before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-['']"
          />
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-slot="skill-source-remove"
          className="size-11"
          disabled={!editable || busy}
          aria-label={`Remove ${sourceLabel(source)}`}
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}

/** One line on what the source does now, and for a failure what to try next. */
export function statusText(source: TeamSkillSource): string {
  if (!source.enabled) return 'Disabled. Its skills are hidden from the catalog and from tasks.'
  const status = source.status
  switch (status.state) {
    case 'loading':
      return 'Fetching…'
    case 'idle':
      return 'Not fetched yet. Use Retry to fetch it now.'
    case 'ok':
      return status.skillCount === 1 ? '1 skill' : `${status.skillCount} skills`
    case 'error': {
      const kept = status.skillCount > 0 ? ' Skills from an earlier fetch still show.' : ''
      if (status.cause === 'refused-format') {
        return `${productName('cezar')} does not accept this repo format. Remove it, then add it as ${SKILLS_REPO_FORMATS}.`
      }
      if (status.cause === 'ref-not-found') {
        return `${status.detail} Check the ref, or remove the source and add it with another ref.${kept}`
      }
      return `Could not fetch: ${sentence(status.detail)} Check the network and your access to the repo, then Retry.${kept}`
    }
  }
}

/** git's own message, ended as a sentence so the advice after it reads apart. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

/** Why the form cannot add these values, or null. The server checks the same rules. */
function formProblem(repo: string, ref: string): string | null {
  if (!repo.trim()) return 'Enter a repo.'
  if (skillsRepoKind(repo) === null) return `Use ${SKILLS_REPO_FORMATS}.`
  if (ref.trim() && !isSafeSkillsRef(ref.trim())) return 'Use a branch, tag or commit SHA for the ref, such as main.'
  return null
}

function AddSourceForm({ disabled }: { disabled: boolean }) {
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const repoId = useId()
  const refId = useId()
  const problemId = useId()
  const add = useSourceMutation(addSkillSource, () => {
    setRepo('')
    setRef('')
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = formProblem(repo, ref)
    setProblem(found)
    if (found) return
    add.mutate(ref.trim() ? { repo: repo.trim(), ref: ref.trim() } : { repo: repo.trim() })
  }

  return (
    <form
      data-slot="skill-source-add"
      aria-label="Add a team skill source"
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-2 @min-[520px]:flex-row @min-[520px]:flex-wrap @min-[520px]:items-end"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={repoId} className="text-xs font-medium">Repo</label>
        <Input
          id={repoId}
          data-slot="skill-source-repo"
          value={repo}
          placeholder="owner/name"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          onChange={(event) => { setRepo(event.target.value); setProblem(null) }}
          className="h-11 font-mono text-[13px]"
        />
      </div>
      <div className="flex flex-col gap-1 @min-[520px]:w-36">
        <label htmlFor={refId} className="text-xs font-medium">Ref</label>
        <Input
          id={refId}
          data-slot="skill-source-ref"
          value={ref}
          placeholder="main"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => { setRef(event.target.value); setProblem(null) }}
          className="h-11 font-mono text-[13px]"
        />
      </div>
      <Button type="submit" data-slot="skill-source-submit" className="h-11" disabled={disabled || add.isPending}>
        Add source
      </Button>
      {problem ? (
        <p id={problemId} role="alert" data-slot="skill-source-problem" className="text-xs text-danger @min-[520px]:basis-full">
          {problem}
        </p>
      ) : null}
    </form>
  )
}
