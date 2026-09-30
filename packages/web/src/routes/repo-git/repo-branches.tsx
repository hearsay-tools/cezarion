import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GitBranchIcon, GitPullRequestIcon, PlusIcon, SearchIcon } from '@/components/design-icons'
import { useState, type FormEvent } from 'react'

import { createRepoBranch } from '@/api/client'
import { queryKeys, useGithub, useHealth, useRepoBranches } from '@/api/queries'
import type { BranchClass, GithubItem, HealthResponse, RepoBranchEntry, RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { cn, isHttpUrl } from '@/lib/utils'

/**
 * The Git view's All branches section (R5 Step 1.7, issue 06 §3): the branch list `GET /api/repo`
 * already carries, with switch/create wired to `POST /api/repo/branch` (1.3) — every predictable
 * git refusal (dirty tree, invalid name) comes back as a 409 whose reason surfaces verbatim as a
 * danger toast. The agents' base-branch picker lives in the checkout block, so it is listed once.
 * Each row carries its class from `GET /repo/branches` (issue 08) as a small label, and a branch
 * that belongs to a task links to it. `GET /repo` leaves the task branches (`cez/*`) out of its
 * switch list; the classified list puts them back here, without a Switch: a task's branch is
 * opened through its task, and is usually checked out in its worktree anyway.
 *
 * Forge-specific rows (open PRs with checks badges) render ONLY when `/api/health` reports
 * the forge driver available — no driver, no PR surface, per the forge-seam doctrine. The
 * component gate doubles as the fetch gate: `<ForgePullRequests>` mounts (and so queries
 * `/api/github`) only behind it.
 */
export function RepoBranchesSection({ repo, info }: { repo: RepoResponse; info: RepoInfo }) {
  const health = useHealth()
  const classified = useRepoBranches()
  const byName = new Map((classified.data?.branches ?? []).map((entry) => [entry.name, entry]))
  const queryClient = useQueryClient()
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })

  const branchAction = useMutation({
    mutationFn: (name: string) => createRepoBranch({ name }),
    onSuccess: async (result) => {
      toast(result.created ? `Created and switched to ${result.branch}` : `Switched to ${result.branch}`)
      // Refresh the rest of both payloads first, then preserve the mutation's authoritative
      // checkout result even if a read races and briefly returns the previous HEAD.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repo }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ])
      queryClient.setQueryData<RepoResponse>(queryKeys.repo, (current) =>
        current?.info ? { ...current, info: { ...current.info, branch: result.branch } } : current,
      )
      // Health is workspace-level, so only patch it when it describes this repo.
      queryClient.setQueryData<HealthResponse>(queryKeys.health, (current) =>
        current?.repo?.root === info.root
          ? { ...current, repo: { ...current.repo, branch: result.branch } }
          : current,
      )
    },
    onError,
  })

  const [newName, setNewName] = useState('')
  const [branchQuery, setBranchQuery] = useState('')
  const normalizedBranchQuery = branchQuery.trim().toLowerCase()
  const allBranches = allBranchNames(repo, classified.data?.branches)
  const filteredBranches = normalizedBranchQuery
    ? allBranches.filter((name) => name.toLowerCase().includes(normalizedBranchQuery))
    : allBranches
  const submitCreate = (event: FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name) return
    branchAction.mutate(name, { onSuccess: () => setNewName('') })
  }

  return (
    <section data-slot="repo-branches" className="grid min-w-0 grid-cols-1 gap-5 px-[18px] py-[22px] md:grid-cols-[minmax(0,1fr)_290px] md:px-9">
      <div className="min-w-0 rounded-xl border border-border bg-card p-5">
        <h2 className="sr-only">Branches</h2>
        <label className="relative block">
        <SearchIcon size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
        <Input
          aria-label="Filter branches"
          placeholder="Filter branches…"
          value={branchQuery}
          onChange={(event) => setBranchQuery(event.target.value)}
          className="h-11 pl-10"
        />
        </label>
        <ul data-slot="repo-branch-list" className="mt-4 flex min-w-0 flex-col divide-y divide-border border-t border-border md:max-h-[40rem] md:overflow-y-auto md:overscroll-contain">
          {filteredBranches.map((name) => {
            const current = name === info.branch
            const entry = byName.get(name)
            return (
              <li key={name} data-slot="branch-row" data-branch={name} data-branch-class={entry?.class} className="flex min-h-20 flex-col items-start justify-center gap-2 py-3 md:flex-row md:items-center md:justify-start md:py-2.5">
                <span className="flex min-w-0 items-center gap-[8px]">
                  {entry?.runId ? (
                    <Link
                      to={`/tasks/${entry.runId}`}
                      data-slot="branch-task-link"
                      title={entry.title ? `Open the task ${entry.title}` : 'Open the task'}
                      className="min-w-0 truncate rounded-[2px] text-[13px] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {name}
                    </Link>
                  ) : (
                    <span className={cn('min-w-0 truncate text-[13px]', current && 'font-normal')}>{name}</span>
                  )}
                  {entry ? <BranchClassLabel entry={entry} /> : null}
                </span>
                {name.startsWith('cez/') && !current ? null : current ? (
                  <span
                    data-slot="branch-current"
                    className="md:ml-auto flex shrink-0 items-center rounded-md bg-accent-strong/10 px-2 py-1.5 text-[12px] font-medium text-accent-text"
                  >
                    Current
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    data-action="switch-branch"
                    className="md:ml-auto h-11"
                    disabled={branchAction.isPending}
                    onClick={() => branchAction.mutate(name)}
                  >
                    <GitBranchIcon size={16} aria-hidden="true" />
                    Switch
                  </Button>
                )}
              </li>
            )
          })}
          {filteredBranches.length === 0 ? (
            <li data-slot="branch-empty" className="py-3 text-xs text-soft-foreground">
              No branches match “{branchQuery.trim()}”.
            </li>
          ) : null}
        </ul>
      </div>

      <div className="min-w-0 self-start rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold">Create a branch</h2>
        <form data-slot="branch-create" className="mt-7 flex flex-col items-stretch gap-3" onSubmit={submitCreate}>
          <label htmlFor="new-branch-name" className="text-sm font-medium">Branch name</label>
          <p className="-mt-1 text-xs text-muted-foreground">Create from the selected base.</p>
          <Input
            id="new-branch-name"
            aria-label="New branch name"
            placeholder="new-branch-name"
            className="h-11 bg-background"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="min-h-11 self-start"
            data-action="create-branch"
            disabled={!newName.trim() || branchAction.isPending}
          >
            <PlusIcon size={16} aria-hidden="true" />
            Create branch
          </Button>
        </form>
        <p className="mt-3 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">Switching branches changes your working tree. Review uncommitted changes first.</p>
      </div>

      {health.data?.forge?.available ? <ForgePullRequests /> : null}
    </section>
  )
}

/** Mounted only behind the forge gate, so `/api/github` is fetched only when a driver is
 *  available. The payload itself still degrades (`available:false` + reason) — rendered
 *  honestly rather than hidden, since at this point a forge was detected. */
function ForgePullRequests() {
  const github = useGithub({ limit: 20 })
  return (
    <div data-slot="repo-prs" className="max-w-xl">
      <h2 className="text-xs font-semibold tracking-wide text-soft-foreground uppercase">Open pull requests</h2>
      {github.isPending ? (
        <p className="mt-2 text-xs text-soft-foreground">Loading pull requests…</p>
      ) : github.isError ? (
        <p className="mt-2 text-xs text-soft-foreground">{github.error.message}</p>
      ) : !github.data.available ? (
        <p data-slot="repo-prs-unavailable" className="mt-2 text-xs text-soft-foreground">
          {github.data.reason ?? 'The forge is unreachable right now.'}
        </p>
      ) : github.data.prs.length === 0 ? (
        <p className="mt-2 text-xs text-soft-foreground">No open pull requests.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {github.data.prs.map((pr) => (
            <PullRequestRow key={pr.number} pr={pr} />
          ))}
        </ul>
      )}
    </div>
  )
}

function PullRequestRow({ pr }: { pr: GithubItem }) {
  const inner = (
    <>
      <GitPullRequestIcon size={16} aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{pr.number}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{pr.title}</span>
      {pr.checks ? <ChecksBadge checks={pr.checks} /> : null}
    </>
  )
  const rowClass = 'flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-2'
  return (
    <li data-slot="pr-row" data-number={pr.number}>
      {/* href protocol guard (#431): link only for http(s) URLs, else inert row. */}
      {isHttpUrl(pr.url) ? (
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className={cn(rowClass, 'hover:bg-muted')}>
          {inner}
        </a>
      ) : (
        <span className={rowClass}>{inner}</span>
      )}
    </li>
  )
}

/** The checks badge — the same three words the GitHub tab uses, tinted by outcome. */
function ChecksBadge({ checks }: { checks: 'passing' | 'failing' | 'pending' }) {
  return (
    <span
      data-slot="pr-checks"
      data-checks={checks}
      className={cn(
        'shrink-0 text-[12px] font-medium',
        checks === 'passing' && 'text-success',
        checks === 'failing' && 'text-danger',
        checks === 'pending' && 'text-muted-foreground',
      )}
    >
      {checks}
    </span>
  )
}

/** The board's words for each class (issue 08 §C). `orphan` is not landed too: its task is gone. */
const CLASS_LABEL: Record<BranchClass, string> = {
  active: 'in use',
  'not-landed': 'not landed',
  orphan: 'not landed',
  merged: 'merged',
  empty: 'empty',
  other: 'yours',
}

function BranchClassLabel({ entry }: { entry: RepoBranchEntry }) {
  return (
    <span
      data-slot="branch-class"
      className={cn(
        'shrink-0 rounded-[4px] border px-[5px] py-[1px] text-[10.5px] leading-[14px]',
        entry.class === 'active' ? 'border-status-running/40 text-status-running'
          : entry.class === 'not-landed' || entry.class === 'orphan' ? 'border-inbox-count-foreground/40 text-inbox-count-foreground'
          : 'border-border text-soft-foreground',
      )}
    >
      {CLASS_LABEL[entry.class]}
    </span>
  )
}

/** Every branch the view lists: `GET /repo`'s switchable names (local and remote, `cez/*` left
 *  out) plus every classified local branch, which is where the `cez/*` ones come from. Sorted
 *  the way `GET /repo` sorts. Also the All branches count, so the sidebar and the list agree. */
export function allBranchNames(repo: RepoResponse, classified: readonly RepoBranchEntry[] | undefined): string[] {
  const names = new Set<string>(repo.branches)
  for (const entry of classified ?? []) names.add(entry.name)
  return [...names].sort((a, b) => a.localeCompare(b))
}
