import { useMemo, useState } from 'react'

import { useRefreshSelfUpdateDevelopment, useSelfUpdateDevelopment } from '@/api/self-update-queries'
import type { CezarCheckout, PullBuild, SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The PR number a preview version was cut for (`0.13.0-pr1169.1234` → 1169), else null. */
export function pullOfVersion(version: string): number | null {
  const match = /-pr(\d+)\./.exec(version)
  return match ? Number(match[1]) : null
}

type Tab = 'worktrees' | 'pulls'
type Pulls = NonNullable<ReturnType<typeof useSelfUpdateDevelopment>['data']>['pulls']

function matchesCheckout(checkout: CezarCheckout, needle: string): boolean {
  if (!needle) return true
  return [checkout.branch, checkout.task?.title, checkout.task?.id, checkout.commit?.subject, checkout.worktree, checkout.pr ? `#${checkout.pr}` : '']
    .filter(Boolean)
    .some((field) => field!.toLowerCase().includes(needle))
}

function matchesPull(pull: PullBuild, needle: string, showUnbuilt: boolean): boolean {
  if (!pull.version && !showUnbuilt) return false
  if (!needle) return true
  return [`#${pull.number}`, String(pull.number), pull.title, pull.branch, pull.author ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  )
}

/** The picked build and what switching to it takes. */
interface Pick {
  checkout: CezarCheckout | undefined
  pull: PullBuild | undefined
  /** An unbuilt or stale worktree is built on the server before the switch — even the one that
   *  is running, which is how "rebuild what I am on" is spelled. */
  needsBuild: boolean
}

function actionLabelOf(pick: Pick, activeId: string | undefined): string {
  if (pick.pull && !pick.pull.installed) return 'Install & restart'
  if (!pick.needsBuild) return 'Switch & restart'
  return `${pick.checkout!.built ? 'Rebuild' : 'Build'} & ${pick.checkout!.id === activeId ? 'restart' : 'switch'}`
}

function pickHint(pick: Pick, tab: Tab): string {
  if (pick.checkout) {
    if (!pick.needsBuild) return pick.checkout.worktree
    return `${pick.checkout.built ? 'Needs rebuild' : 'Not built yet'} — runs npm run build in ${pick.checkout.worktree} first (about a minute).`
  }
  if (pick.pull) return `Installs ${pick.pull.version} from npm.`
  return tab === 'worktrees'
    ? 'Linked, not copied: a worktree with uncommitted changes, a missing build, or a build older than its last commit is built before the switch.'
    : 'Preview builds CI publishes for green same-repo pull requests.'
}

type DevelopmentData = ReturnType<typeof useSelfUpdateDevelopment>['data']

function pickOf(tab: Tab, checkouts: CezarCheckout[], pulls: Pulls | undefined, picked: string | null): Pick {
  const checkout = tab === 'worktrees' ? checkouts.find((entry) => entry.id === picked) : undefined
  const pull = tab === 'pulls' ? pulls?.items.find((entry) => entry.version && entry.version === picked) : undefined
  return { checkout, pull, needsBuild: !!checkout && (!checkout.built || checkout.stale) }
}

/** Everything the panel shows that follows from the fetched builds and the user's choices. */
function useDevelopmentView(
  devData: DevelopmentData,
  { chosenTab, needle, picked, showUnbuilt }: { chosenTab: Tab; needle: string; picked: string | null; showUnbuilt: boolean },
) {
  const checkouts = useMemo(() => devData?.checkouts ?? [], [devData])
  const pulls = devData?.pulls
  const pullItems = useMemo(() => pulls?.items ?? [], [pulls])
  // No cezar clone among the registered projects: the Worktrees tab would only ever be empty, so
  // it is not offered and pull requests are all there is.
  const hasWorktrees = !devData || checkouts.length > 0
  const tab: Tab = hasWorktrees ? chosenTab : 'pulls'
  const shownCheckouts = useMemo(() => checkouts.filter((checkout) => matchesCheckout(checkout, needle)), [checkouts, needle])
  const shownPulls = useMemo(() => pullItems.filter((pull) => matchesPull(pull, needle, showUnbuilt)), [pullItems, needle, showUnbuilt])
  const unbuilt = pullItems.filter((pull) => !pull.version).length
  const tabs = [
    ...(hasWorktrees ? [{ value: 'worktrees', label: 'Worktrees', count: checkouts.length } as const] : []),
    { value: 'pulls', label: 'Pull requests', count: pullItems.length - unbuilt } as const,
  ]
  return { pulls, tab, tabs, shownCheckouts, shownPulls, unbuilt, pick: pickOf(tab, checkouts, pulls, picked) }
}

/**
 * The development channel: run one of cezar's own worktrees (linked, not copied) or the preview
 * build CI published for an open pull request. Branch names alone do not tell forty task
 * worktrees apart, so every row carries what does: the task's title, the last commit and its
 * age, whether the build predates it, and the PR the branch belongs to.
 */
export function DevelopmentPanel({
  data,
  onApply,
  applying,
}: {
  data: SelfUpdateStatus
  onApply: (target: string) => void
  applying: boolean
}) {
  const dev = useSelfUpdateDevelopment()
  const refresh = useRefreshSelfUpdateDevelopment()
  const [chosenTab, setTab] = useState<Tab>('worktrees')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  // Most open PRs have no build (a fork waiting on CI approval): listing them by default buries
  // the few that can actually be installed.
  const [showUnbuilt, setShowUnbuilt] = useState(false)
  const needle = query.trim().toLowerCase()
  const view = useDevelopmentView(dev.data, { chosenTab, needle, picked, showUnbuilt })
  const { tab, pick } = view
  const activeId = data.installed.find((entry) => entry.active)?.id

  return (
    <div data-slot="self-update-development" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <DevelopmentTabs
          tabs={view.tabs}
          tab={tab}
          showCounts={!!dev.data}
          onTab={(value) => {
            setTab(value)
            setPicked(null)
          }}
        />
        <Button variant="ghost" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending || dev.isFetching}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <Input
        aria-label="Filter"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={tab === 'worktrees' ? 'Filter by task, branch, commit or #PR' : 'Filter by #number, title, branch or author'}
        className="h-8 text-[13px]"
      />

      {/* Status lines and the "show unbuilt" toggle sit beside the listbox, not in it: a listbox
          may only hold options. */}
      <div className="max-h-72 min-h-24 overflow-y-auto rounded-md border border-border">
        {dev.isPending ? (
          <p className="px-3 py-3 text-[12.5px] text-muted-foreground">Looking for worktrees and pull requests…</p>
        ) : dev.error ? (
          <p className="px-3 py-3 text-[12.5px] text-danger">{dev.error.message}</p>
        ) : tab === 'worktrees' ? (
          <WorktreeList checkouts={view.shownCheckouts} activeId={activeId} picked={picked} onPick={setPicked} />
        ) : (
          <PullList
            pulls={view.pulls}
            shown={view.shownPulls}
            filtered={!!needle}
            unbuilt={view.unbuilt}
            showUnbuilt={showUnbuilt}
            onToggleUnbuilt={() => setShowUnbuilt((value) => !value)}
            activeId={activeId}
            picked={picked}
            onPick={setPicked}
          />
        )}
      </div>

      <PickFooter data={data} pick={pick} tab={tab} activeId={activeId} applying={applying} onApply={onApply} />
    </div>
  )
}

function PickFooter({
  data,
  pick,
  tab,
  activeId,
  applying,
  onApply,
}: {
  data: SelfUpdateStatus
  pick: Pick
  tab: Tab
  activeId: string | undefined
  applying: boolean
  onApply: (target: string) => void
}) {
  const jobBusy = data.job?.status === 'running' || data.job?.status === 'restarting'
  const target = pick.checkout?.id ?? pick.pull?.version ?? null
  const targetIsActive = !!target && target === activeId && !pick.needsBuild
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <p className="min-w-0 truncate text-[11.5px] text-muted-foreground" title={pick.checkout?.worktree}>
        {pickHint(pick, tab)}
      </p>
      <Button
        size="sm"
        variant="contrast"
        onClick={() => target && onApply(target)}
        disabled={!target || targetIsActive || !data.canSelfUpdate || applying || jobBusy}
      >
        {actionLabelOf(pick, activeId)}
      </Button>
    </div>
  )
}

function DevelopmentTabs({
  tabs,
  tab,
  showCounts,
  onTab,
}: {
  tabs: readonly { value: Tab; label: string; count: number }[]
  tab: Tab
  showCounts: boolean
  onTab: (value: Tab) => void
}) {
  return (
    <div role="tablist" aria-label="Development builds" className="flex rounded-md border border-border bg-muted/40 p-0.5">
      {tabs.map((entry) => (
        <button
          key={entry.value}
          type="button"
          role="tab"
          aria-selected={tab === entry.value}
          onClick={() => onTab(entry.value)}
          className={cn(
            'rounded-[5px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
            tab === entry.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {entry.label}
          {showCounts ? <span className="ml-1.5 font-normal text-muted-foreground">{entry.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

function WorktreeList({
  checkouts,
  activeId,
  picked,
  onPick,
}: {
  checkouts: CezarCheckout[]
  activeId: string | undefined
  picked: string | null
  onPick: (id: string) => void
}) {
  return (
    <>
      {checkouts.length === 0 ? <p className="px-3 py-3 text-[12.5px] text-muted-foreground">Nothing matches.</p> : null}
      <div role="listbox" aria-label="Worktrees">
        {checkouts.map((checkout) => (
          <CheckoutRow
            key={checkout.worktree}
            checkout={checkout}
            active={checkout.id === activeId}
            selected={picked === checkout.id}
            onSelect={() => onPick(checkout.id)}
          />
        ))}
      </div>
    </>
  )
}

function emptyPullsMessage(pulls: NonNullable<Pulls>, filtered: boolean): string {
  if (pulls.items.length === 0) return `No open pull requests on ${pulls.repo}.`
  return filtered ? 'Nothing matches.' : 'No open pull request has a preview build.'
}

function PullList({
  pulls,
  shown,
  filtered,
  unbuilt,
  showUnbuilt,
  onToggleUnbuilt,
  activeId,
  picked,
  onPick,
}: {
  pulls: Pulls | undefined
  shown: PullBuild[]
  filtered: boolean
  unbuilt: number
  showUnbuilt: boolean
  onToggleUnbuilt: () => void
  activeId: string | undefined
  picked: string | null
  onPick: (version: string) => void
}) {
  return (
    <>
      {pulls && !pulls.available ? <p className="px-3 py-2 text-[12px] text-muted-foreground">{pulls.reason}</p> : null}
      {pulls?.available && shown.length === 0 ? (
        <p className="px-3 py-3 text-[12.5px] text-muted-foreground">{emptyPullsMessage(pulls, filtered)}</p>
      ) : null}
      <div role="listbox" aria-label="Pull requests">
        {shown.map((pull) => (
          <PullRow
            key={pull.number}
            pull={pull}
            active={!!pull.version && pull.version === activeId}
            selected={!!pull.version && picked === pull.version}
            onSelect={() => pull.version && onPick(pull.version)}
          />
        ))}
      </div>
      {unbuilt > 0 ? (
        <button
          type="button"
          onClick={onToggleUnbuilt}
          className="w-full border-t border-border px-3 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
        >
          {showUnbuilt
            ? `Hide the ${unbuilt} without a preview build`
            : `${unbuilt} more without a preview build (forks, CI not green yet) — show`}
        </button>
      ) : null}
    </>
  )
}

function Row({
  selected,
  disabled,
  onSelect,
  title,
  children,
}: {
  selected: boolean
  disabled: boolean
  onSelect: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title={title}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 border-b border-border px-3 py-2 last:border-b-0 outline-none',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/60',
        selected && 'bg-accent-strong/10 hover:bg-accent-strong/10',
      )}
    >
      {children}
    </div>
  )
}

function CheckoutRow({
  checkout,
  active,
  selected,
  onSelect,
}: {
  checkout: CezarCheckout
  active: boolean
  selected: boolean
  onSelect: () => void
}) {
  const headline = checkout.task?.title ?? checkout.commit?.subject ?? checkout.branch
  return (
    <Row selected={selected} disabled={!checkout.id} onSelect={onSelect} title={checkout.worktree}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{headline}</span>
        {checkout.pr ? <Badge variant="outline">#{checkout.pr}</Badge> : null}
        {active ? <Badge variant="secondary">current</Badge> : null}
        {!checkout.built ? (
          <Badge variant="outline">not built</Badge>
        ) : checkout.stale ? (
          <Badge variant="outline">needs rebuild</Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="shrink-0 font-mono">{checkout.branch}</span>
        {checkout.task ? <span className="shrink-0">· {checkout.task.status}</span> : null}
        {checkout.commit ? (
          <span className="min-w-0 truncate">
            · {checkout.commit.sha} {checkout.task ? checkout.commit.subject : ''} · {shortAge(checkout.commit.at)} ago
          </span>
        ) : null}
        {checkout.builtAt ? <span className="shrink-0">· built {shortAge(checkout.builtAt)} ago</span> : null}
      </div>
    </Row>
  )
}

function PullRow({
  pull,
  active,
  selected,
  onSelect,
}: {
  pull: PullBuild
  active: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Row selected={selected} disabled={!pull.version} onSelect={onSelect} title={pull.url}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[13px] text-muted-foreground">#{pull.number}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{pull.title}</span>
        {pull.draft ? <Badge variant="outline">draft</Badge> : null}
        {active ? (
          <Badge variant="secondary">current</Badge>
        ) : !pull.version ? (
          <Badge variant="outline">no build</Badge>
        ) : pull.installed ? (
          <Badge variant="outline">installed</Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {pull.author ? <span className="shrink-0">{pull.author}</span> : null}
        <span className="min-w-0 truncate font-mono">· {pull.branch}</span>
        <span className="shrink-0">· updated {shortAge(pull.updatedAt)} ago</span>
        {pull.version ? (
          <span className="shrink-0">· build {pull.publishedAt ? `${shortAge(pull.publishedAt)} ago` : pull.version}</span>
        ) : null}
      </div>
    </Row>
  )
}
