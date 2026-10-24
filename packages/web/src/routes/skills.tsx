import './skills-workflows.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MinusIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  ZapIcon,
} from '@/components/design-icons'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { refreshSkills } from '@/api/client'
import { queryKeys, useImportableSkills, useSkills, useWorkflows } from '@/api/queries'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { Skill, TeamSkillRef, WorkflowDef } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { SkillDetailBody, SkillSwitch, type SkillActivation } from '@/components/skill-detail'
import { SkillEmptyHint } from '@/components/skill-empty-hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import {
  buildSkillTree,
  groupActivation,
  matchingSkillKeys,
  revealKeys,
  treeGroupKeys,
  type GroupActivation,
  type SkillTreeGroup,
} from '@/lib/skill-groups'
import { isProjectSkill, orderSkills, skillUsedBy } from '@/lib/skills'
import { teamSkillRef, teamSkillRows, useTeamSkillSwitches } from '@/lib/use-skill-selection'
import { cn } from '@/lib/utils'
import { BookmarkletPanel } from './settings/bookmarklets-section'

/**
 * `/skills` — the skills catalog as its own top-level surface (was `/settings/skills`, moved
 * out of the Settings shell so it stops carrying the settings sub-nav): the grouped table,
 * Refresh and the bookmarklet panel. `/settings/skills` now redirects here (routes.tsx) so
 * pasted links keep working. Skills are playbooks agents follow, not a knob — so this is a page,
 * not a settings section.
 *
 * One table for every skill (hearsay-tools/cezarion#1607): enabled and disabled skills sit
 * together under foldable groups — source repository, then plugin or directory
 * (`lib/skill-groups.ts`). Folding and activation are separate controls. A team repository or
 * group has a tri-state control that switches every child, filtered ones included, in one save
 * (`useTeamSkillSwitches().setMany`); every team skill keeps its own switch
 * (hearsay-tools/cezarion#1494). Local, global and built-in skills stay locked on. Team rows are
 * keyed by source repo AND name, so the same name from two sources shows twice; the copy that
 * loses de-duplication says what hides it.
 *
 * The open skill lives in the URL (`?skill=<name>`, plus `&repo=` for a twin) and its details
 * open directly below its row; clicking the row again folds them. A link opens the skill's parent
 * groups. The rows are keyed React elements inside one persistent scroll container, so a Refresh
 * re-renders them in place and keeps the open skill and the scroll position (#384). Repositories
 * start open and plugin or directory groups start folded; the fold state lives in this page only.
 *
 * The legacy `__bm` sentinel opens the bookmarklet panel (spec 011), and `__import` opens the
 * first disabled skill.
 */

const BOOKMARKLETS = '__bm'
const IMPORT = '__import'

/** A team row's identity: the same name can come from two sources. */
const rowKey = (skill: Skill) => (skill.team ? `${skill.team.repo}\u0000${skill.name}` : skill.path)

/** Sources that always beat a team skill of the same name (`builtin` loses to it). */
const shadowsTeam = (skill: Skill) => skill.source !== 'team' && skill.source !== 'builtin'

type Entry = { skill: Skill; key: string; hiddenBy?: string }

export function SkillsRoute() {
  return (
    <div
      data-route="skills"
      className="mx-auto min-h-full w-full px-[18px] py-6 md:p-9"
    >
      <SkillsCatalog />
    </div>
  )
}

function SkillsCatalog() {
  const skillsQuery = useSkills()
  const workflowsQuery = useWorkflows()
  const importableQuery = useImportableSkills()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  // The same scope `queryKeys.skills` reads, so a save invalidates the catalog this page shows.
  const switches = useTeamSkillSwitches(queryScope())
  const refresh = useRefreshSkills()

  const catalog = useMemo(() => skillsQuery.data ?? [], [skillsQuery.data])
  const team = useMemo(() => importableQuery.data ?? [], [importableQuery.data])
  // Until the team list is known (loading or failed), no team skill can be switched: the
  // catalog's team skills show on with a disabled switch, and no switched-off skill is listed.
  const teamKnown = importableQuery.isSuccess
  const listed = useMemo(
    () => skillEntries(catalog, teamKnown ? team : null, switches.isOn),
    [catalog, team, teamKnown, switches.isOn],
  )
  const tree = useMemo(() => buildSkillTree(listed), [listed])

  // Two team copies of one name need the repo in the URL and in the switch's name.
  const nameCount = new Map<string, number>()
  for (const item of listed) nameCount.set(item.skill.name, (nameCount.get(item.skill.name) ?? 0) + 1)
  const twin = (skill: Skill) => (nameCount.get(skill.name) ?? 0) > 1 && skill.team !== undefined

  const isOn = (skill: Skill) => {
    const ref = teamSkillRef(skill)
    return ref && teamKnown ? switches.isOn(ref) : true
  }
  const activationFor = (skill: Skill): SkillActivation => {
    const ref = teamSkillRef(skill)
    if (!ref) {
      return { ariaLabel: `${skill.name} is always enabled`, checked: true, disabled: true, locked: true, onCheckedChange: () => {} }
    }
    return {
      ariaLabel: twin(skill) ? `Enable ${skill.name} from ${ref.repo}` : `Enable ${skill.name}`,
      checked: isOn(skill),
      disabled: !teamKnown || !switches.ready,
      locked: false,
      onCheckedChange: () => switches.toggle(ref),
    }
  }
  const linkFor = (skill: Skill) =>
    `/skills?skill=${encodeURIComponent(skill.name)}${twin(skill) ? `&repo=${encodeURIComponent(skill.team!.repo)}` : ''}`

  const param = searchParams.get('skill')
  const openKey = findOpenEntry(listed, param, searchParams.get('repo'), isOn)?.key ?? null
  const folds = useSkillFolds(tree, openKey)
  const onQuery = (value: string) => {
    setQuery(value)
    // A search opens the folded groups that hold a match; the user can fold them again.
    const found = matchingSkillKeys(tree, value)
    if (found && found.size > 0) folds.open(revealKeys(tree, found))
  }

  if (skillsQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load skills"
        subtitle={skillsQuery.error.message}
      />
    )
  }

  const showBookmarklets = param === BOOKMARKLETS
  // The page names how to add a source, and no vendor (hearsay-tools/cezarion#1494).
  const noTeamSkills = teamKnown && team.length === 0 && !skillsQuery.isPending
  const rows = skillsQuery.isPending
    ? []
    : tableRows({
        tree,
        matches: matchingSkillKeys(tree, query),
        isOpen: folds.isOpen,
        onFold: folds.toggle,
        openKey,
        workflows: workflowsQuery.data?.workflows ?? [],
        activationFor,
        linkFor,
        groupActivationFor: (node) => groupActivation(node, isOn),
        // Until the stored off-list has loaded too, an enabled count would be a guess.
        switchable: teamKnown && switches.ready,
        onActivate: switches.setMany,
      })

  return (
    <div data-slot="skills-section" className="@container flex min-w-0 flex-col gap-[22px]">
      <header className="flex flex-col gap-4 @min-[700px]:flex-row @min-[700px]:items-center @min-[700px]:justify-between">
        <div>
          <h1 className="text-[25px] font-semibold md:text-[30px]">Skills</h1>
          <p className="mt-2 text-xs text-muted-foreground md:text-[13px]">Markdown playbooks your agents can follow.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={showBookmarklets ? '/skills' : `/skills?skill=${BOOKMARKLETS}`}
            data-slot="bookmarklets-row"
            aria-current={showBookmarklets ? 'page' : undefined}
            aria-expanded={showBookmarklets}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-medium aria-[current=page]:bg-accent-strong/10 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ZapIcon aria-hidden="true" className="size-4 text-link-foreground" />
            Run from GitHub
          </Link>
        </div>
      </header>

      {showBookmarklets ? (
        <section data-slot="skills-bookmarklets" className="min-w-0 rounded-xl border border-border bg-card p-5">
          <BookmarkletPanel skills={listed.filter((item) => isOn(item.skill) && !item.hiddenBy).map((item) => item.skill)} />
        </section>
      ) : null}

      <SkillsToolbar
        query={query}
        onQuery={onQuery}
        refreshing={refresh.isPending}
        onRefresh={() => refresh.mutate()}
        onFoldAll={folds.setAll}
      />

      <section
        data-slot="skills-list"
        aria-label="Skills"
        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-2 @min-[520px]:p-3"
      >
        {importableQuery.isError ? (
          <TeamListError
            message={importableQuery.error.message}
            retrying={importableQuery.isFetching}
            onRetry={() => void importableQuery.refetch()}
          />
        ) : null}
        <div
          data-slot="skill-rows"
          className="min-h-0 overflow-y-auto md:max-h-[calc(100dvh-260px)]"
        >
          {skillsQuery.isPending ? (
            <p role="status" aria-busy="true" className="min-h-72 p-3 text-[13px] text-muted-foreground">
              Loading skills…
            </p>
          ) : rows.length > 0 ? (
            <table data-slot="skills-table" className="w-full table-fixed border-collapse text-left">
              <thead>
                <tr className="border-b border-border text-[12px] text-muted-foreground">
                  <th scope="col" className="px-2 py-2 font-semibold">Skill / group</th>
                  <th scope="col" className="hidden w-[30%] px-2 py-2 font-semibold @min-[520px]:table-cell">Used by</th>
                  <th scope="col" className="w-[116px] px-2 py-2 text-right font-semibold">Enabled</th>
                </tr>
              </thead>
              <tbody>{rows}</tbody>
            </table>
          ) : (
            <p className="px-2.5 py-2 text-xs leading-relaxed text-soft-foreground">
              {listed.length > 0 ? '(no skills match)' : <SkillEmptyHint />}
            </p>
          )}
        </div>
        {noTeamSkills ? (
          <p data-slot="skills-team-empty" className="px-2.5 py-2 text-xs leading-relaxed text-soft-foreground">
            No team skills. To add a source, list it under <span className="font-mono">skillsRepos</span> in{' '}
            <span className="font-mono">.ai/cezar/config.json</span>, then Refresh.
          </p>
        ) : null}
      </section>
    </div>
  )
}

function useRefreshSkills() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => refreshSkills(),
    onSuccess: (catalog) => {
      // The POST answers the merged catalog — seed the shared query instead of refetching.
      queryClient.setQueryData(queryKeys.skills, catalog)
      // The fetch can change which team skills exist too; the switches read that list.
      void queryClient.invalidateQueries({ queryKey: queryKeys.importableSkills })
      toast('Team skills refreshed.')
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })
}

/**
 * Every listed skill, enabled and switched off alike. `team` is null until the team list is
 * known. The catalog is the server's answer; the switches are the optimistic one, so a team row
 * follows its switch at once, before the catalog re-reads.
 */
function skillEntries(catalog: readonly Skill[], team: readonly Skill[] | null, isOn: (ref: TeamSkillRef) => boolean): Entry[] {
  // A local or global skill hides every team copy of its name, so that copy is not listed.
  const shadowed = new Set(catalog.filter(shadowsTeam).map((skill) => skill.name))
  const rows = team ? teamSkillRows(team.filter((skill) => !shadowed.has(skill.name)), catalog, isOn) : []
  const entry = (skill: Skill, hiddenBy?: string): Entry => ({ skill, key: rowKey(skill), ...(hiddenBy ? { hiddenBy } : {}) })
  // A catalog team skill the team list does not hold yet (a Refresh landed first) stays listed.
  const teamKeys = new Set((team ?? []).map(rowKey))
  const all = [
    ...catalog.filter((skill) => skill.source !== 'team' || !teamKeys.has(rowKey(skill))).map((skill) => entry(skill)),
    ...rows.map((row) => entry(row.skill, row.on ? row.hiddenBy : undefined)),
  ]
  // Sorted like the server's catalog (by name), then project-first (`orderSkills`). The sort is
  // stable, so two copies of one name keep the `skillsRepos` order.
  const sorted = all.sort((a, b) => a.skill.name.localeCompare(b.skill.name))
  const bySkill = new Map(sorted.map((item) => [item.skill, item]))
  return orderSkills(sorted.map((item) => item.skill)).map((skill) => bySkill.get(skill)!)
}

/**
 * The skill the URL opens: the named one if it is still listed (the `repo` copy for a twin); a
 * vanished one opens nothing, it never crashes. `__import` (the retired "Manage skills" panel)
 * opens the first switched-off skill.
 */
function findOpenEntry(listed: readonly Entry[], param: string | null, repo: string | null, isOn: (skill: Skill) => boolean) {
  if (param === null || param === BOOKMARKLETS) return null
  if (param === IMPORT) return listed.find((item) => !isOn(item.skill)) ?? null
  const named = listed.filter((item) => item.skill.name === param)
  return named.find((item) => repo === null || item.skill.team?.repo === repo) ?? named[0] ?? null
}

/**
 * The fold state: only the groups the user folded or opened are stored; the rest follow the
 * default (repositories open, plugin and directory groups folded). A link opens the open skill's
 * parent groups, once per skill it names.
 */
function useSkillFolds(tree: readonly SkillTreeGroup<Entry>[], openKey: string | null) {
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const open = (keys: readonly string[]) =>
    setFolds((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, true])) }))
  const openPath = openKey ? revealKeys(tree, new Set([openKey])).join('\u0001') : ''
  useEffect(() => {
    if (openPath) setFolds((current) => ({ ...current, ...Object.fromEntries(openPath.split('\u0001').map((key) => [key, true])) }))
  }, [openPath])
  return {
    isOpen: (node: SkillTreeGroup<Entry>, depth: number) => folds[node.key] ?? depth === 0,
    toggle: (key: string, next: boolean) => setFolds((current) => ({ ...current, [key]: next })),
    open,
    setAll: (next: boolean) => setFolds(Object.fromEntries(treeGroupKeys(tree).map((key) => [key, next]))),
  }
}

/** The table body: each visible group, then its open skills and their details, then its children. */
function tableRows(view: {
  tree: readonly SkillTreeGroup<Entry>[]
  matches: ReadonlySet<string> | null
  isOpen: (node: SkillTreeGroup<Entry>, depth: number) => boolean
  onFold: (key: string, open: boolean) => void
  openKey: string | null
  workflows: readonly WorkflowDef[]
  activationFor: (skill: Skill) => SkillActivation
  linkFor: (skill: Skill) => string
  groupActivationFor: (node: SkillTreeGroup<Entry>) => GroupActivation
  switchable: boolean
  onActivate: (refs: GroupActivation['refs'], on: boolean) => void
}): ReactNode[] {
  const rows: ReactNode[] = []
  const visible = (item: Entry) => view.matches === null || view.matches.has(item.key)
  const hasVisible = (node: SkillTreeGroup<Entry>): boolean => node.items.some(visible) || node.children.some(hasVisible)
  const addGroup = (node: SkillTreeGroup<Entry>, depth: number) => {
    if (!hasVisible(node)) return
    const open = view.isOpen(node, depth)
    rows.push(
      <GroupRow
        key={node.key}
        node={node}
        depth={depth}
        open={open}
        onFold={() => view.onFold(node.key, !open)}
        activation={view.groupActivationFor(node)}
        switchable={view.switchable}
        onActivate={view.onActivate}
      />,
    )
    if (!open) return
    for (const item of node.items.filter(visible)) {
      const expanded = item.key === view.openKey
      const usedBy = skillUsedBy(view.workflows, item.skill.name)
      const activation = view.activationFor(item.skill)
      rows.push(
        <SkillTableRow
          key={item.key}
          item={item}
          depth={depth + 1}
          href={expanded ? '/skills' : view.linkFor(item.skill)}
          expanded={expanded}
          usedBy={usedBy}
          activation={activation}
        />,
      )
      if (expanded) rows.push(<SkillDetailRow key={`${item.key}\u0000detail`} skill={item.skill} usedBy={usedBy} activation={activation} />)
    }
    for (const child of node.children) addGroup(child, depth + 1)
  }
  for (const node of view.tree) addGroup(node, 0)
  return rows
}

function SkillDetailRow({ skill, usedBy, activation }: { skill: Skill; usedBy: readonly string[]; activation: SkillActivation }) {
  return (
    <tr data-slot="skill-detail-row">
      <td colSpan={3} className="border-b border-border px-3 pb-5 @min-[520px]:px-5">
        <div data-slot="skills-detail" className="min-w-0 rounded-lg border border-border bg-background p-4 md:p-5">
          <SkillDetailBody skill={skill} usedBy={usedBy} activation={activation} />
        </div>
      </td>
    </tr>
  )
}

function SkillsToolbar({
  query,
  onQuery,
  refreshing,
  onRefresh,
  onFoldAll,
}: {
  query: string
  onQuery: (value: string) => void
  refreshing: boolean
  onRefresh: () => void
  onFoldAll: (open: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="sw-search relative min-w-0 basis-full sm:basis-auto sm:flex-1">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
        <Input
          data-slot="skills-filter"
          placeholder="Filter skills…"
          aria-label="Filter skills"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          className="h-11 min-w-0 bg-card pl-9 text-xs"
        />
      </div>
      <button
        type="button"
        data-slot="skills-refresh"
        title="git fetch the team skills repos"
        disabled={refreshing}
        onClick={onRefresh}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-55"
      >
        <RefreshCwIcon aria-hidden="true" className={cn('size-3', refreshing && 'motion-safe:animate-spin')} />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      <Button type="button" variant="outline" data-slot="skills-expand-all" className="h-11 text-xs" onClick={() => onFoldAll(true)}>
        Expand groups
      </Button>
      <Button type="button" variant="outline" data-slot="skills-collapse-all" className="h-11 text-xs" onClick={() => onFoldAll(false)}>
        Collapse groups
      </Button>
    </div>
  )
}

function TeamListError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-slot="skills-importable-error"
      className="flex flex-col items-start gap-2 rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground"
    >
      <span>
        Could not load the team skills, so they cannot be switched right now. Your saved choice is kept.
        {' '}
        {message}
      </span>
      <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={retrying} onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

const KIND_LABEL: Partial<Record<SkillTreeGroup<Entry>['kind'], string>> = {
  repo: 'repository',
  plugin: 'plugin',
  directory: 'directory',
}

/** Indent per nesting level, so a skill reads as part of its group. */
const indent = (depth: number) => ({ paddingInlineStart: `${depth * 16}px` })

function GroupRow({
  node,
  depth,
  open,
  onFold,
  activation,
  switchable,
  onActivate,
}: {
  node: SkillTreeGroup<Entry>
  depth: number
  open: boolean
  onFold: () => void
  activation: GroupActivation
  /** The team list and the stored off-list have loaded, so the counts are real. */
  switchable: boolean
  onActivate: (refs: GroupActivation['refs'], on: boolean) => void
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon
  const kind = KIND_LABEL[node.kind]
  const known = node.locked || switchable
  return (
    <tr
      data-slot="skill-group-row"
      data-group={node.label}
      data-kind={node.kind}
      data-level={depth}
      className={cn('border-b border-border', depth === 0 && 'bg-muted/40')}
    >
      <th scope="row" colSpan={2} className="min-w-0 p-0 text-left font-normal">
        <span className="flex min-w-0" style={indent(depth)}>
          <button
            type="button"
            data-slot="skill-group-toggle"
            aria-expanded={open}
            onClick={onFold}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-link-foreground"
          >
            <Chevron aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn('min-w-0 [overflow-wrap:anywhere]', depth === 0 ? 'text-[13px] font-semibold' : 'text-[13px] font-medium')}>
              {node.label}
            </span>
            {kind ? <span className="shrink-0 text-[12px] text-soft-foreground">{kind}</span> : null}
          </button>
        </span>
      </th>
      <td className="px-1 py-0 text-right">
        <span className="inline-flex items-center justify-end gap-1">
          <span data-slot="skill-group-count" className="text-[12px] tabular-nums text-muted-foreground">
            {known ? `${activation.enabled} / ${activation.total}` : '—'}
          </span>
          <GroupCheckbox
            label={node.label}
            locked={node.locked}
            state={known ? activation.state : null}
            disabled={node.locked || !switchable || activation.total === 0}
            onClick={() => onActivate(activation.refs, activation.state !== 'on')}
          />
        </span>
      </td>
    </tr>
  )
}

/**
 * A group's activation control: a tri-state checkbox. From mixed or off it enables every child;
 * from on it disables every child. `state === null` while the counts are unknown, so loading
 * never reads as "off". The box is 20 px; the button around it is a 44 px target.
 */
function GroupCheckbox({
  label,
  locked,
  state,
  disabled,
  onClick,
}: {
  label: string
  locked: boolean
  state: GroupActivation['state'] | null
  disabled: boolean
  onClick: () => void
}) {
  const checked = state === 'mixed' ? 'mixed' : state === 'on'
  return (
    <button
      type="button"
      role="checkbox"
      data-slot="skill-group-switch"
      data-state={state ?? 'unknown'}
      aria-checked={state === null ? undefined : checked}
      aria-busy={state === null ? true : undefined}
      aria-label={locked ? `${label} skills are always enabled` : `Enable all skills in ${label}`}
      disabled={disabled}
      onClick={onClick}
      className="group/check inline-flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-link-foreground disabled:cursor-default"
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-5 items-center justify-center rounded border-2 transition-colors',
          state === 'on' || state === 'mixed'
            ? 'border-accent-strong bg-accent-strong text-accent-strong-foreground'
            : 'border-muted-foreground bg-card text-transparent',
          state === null && 'border-dashed border-soft-foreground',
          'group-disabled/check:opacity-60',
        )}
      >
        {state === 'mixed' ? <MinusIcon className="size-3.5" /> : <CheckIcon className="size-3.5" />}
      </span>
    </button>
  )
}

function SkillTableRow({
  item,
  depth,
  href,
  expanded,
  usedBy,
  activation,
}: {
  item: Entry
  depth: number
  href: string
  expanded: boolean
  usedBy: readonly string[]
  activation: SkillActivation
}) {
  const { skill, hiddenBy } = item
  const project = isProjectSkill(skill)
  const workflows = [...new Set(usedBy.map((entry) => entry.split(' › ')[0]!))]
  return (
    <tr data-slot="skill-table-row" className={cn('border-b border-border', expanded && 'border-transparent')}>
      <td className="min-w-0 p-0" style={indent(depth)}>
        <Link
          to={href}
          data-slot="skill-row"
          data-skill={skill.name}
          data-repo={skill.team?.repo}
          data-project={project ? 'true' : undefined}
          data-enabled={activation.checked ? 'true' : undefined}
          aria-current={expanded ? 'page' : undefined}
          aria-expanded={expanded}
          className={cn(
            'selection-row flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-md px-3 py-2 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-link-foreground',
            expanded && 'bg-accent-strong/10',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {/* Project skills read bold (#377) — the visual half of the ordering rule. */}
            <span
              className={cn(
                'min-w-0 break-words text-[13px]',
                project ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground',
              )}
            >
              {skill.name}
            </span>
          </span>
          {skill.description ? (
            <span className="line-clamp-1 text-xs leading-relaxed text-supporting-foreground">{skill.description}</span>
          ) : null}
          {workflows.length > 0 ? (
            <span data-slot="skill-used-by-inline" className="text-xs text-supporting-foreground @min-[520px]:hidden">
              Used by {workflows.join(', ')}
            </span>
          ) : null}
          {hiddenBy ? (
            <span data-slot="skill-hidden-by" className="min-w-0 text-xs text-supporting-foreground [overflow-wrap:anywhere]">
              hidden by {hiddenBy}
            </span>
          ) : null}
        </Link>
      </td>
      <td data-slot="skill-used-by-cell" className="hidden px-2 py-2 align-middle text-xs text-supporting-foreground @min-[520px]:table-cell">
        {workflows.length > 0 ? (
          <span className="[overflow-wrap:anywhere]">{workflows.join(', ')}</span>
        ) : (
          <span className="text-soft-foreground">—</span>
        )}
      </td>
      <td className="px-1 py-0 text-right align-middle">
        <span className="inline-flex justify-end">
          <SkillSwitch skill={skill} activation={activation} />
        </span>
      </td>
    </tr>
  )
}

