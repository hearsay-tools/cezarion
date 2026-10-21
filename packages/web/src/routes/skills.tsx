import './skills-workflows.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  TriangleAlertIcon,
  ZapIcon,
} from '@/components/design-icons'
import { useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { refreshSkills } from '@/api/client'
import { queryKeys, useImportableSkills, useProjects, useSkills, useWorkflows } from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { Skill } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { SkillDetailBody, SkillSourceTag, SkillSwitch, type SkillActivation } from '@/components/skill-detail'
import { SkillEmptyHint } from '@/components/skill-empty-hint'
import { SkillsUpdateCard } from '@/components/skills-update-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { filterSkills, isProjectSkill, orderSkills, skillUsedBy } from '@/lib/skills'
import { useSkillSelection } from '@/lib/use-skill-selection'
import { cn } from '@/lib/utils'
import { BookmarkletPanel } from './settings/bookmarklets-section'

/**
 * `/skills` — the skills catalog as its own top-level surface (was `/settings/skills`, moved
 * out of the Settings shell so it stops carrying the settings sub-nav): catalog + detail +
 * Refresh + the bookmarklet panel. `/settings/skills` now redirects here (routes.tsx) so pasted
 * links keep working. Skills are playbooks agents follow, not a knob — so this is a page, not a
 * settings section.
 *
 * The two standing feedback items stay built in:
 *  - #377 project-first and bold: the list renders through `orderSkills`/`filterSkills`, the
 *    same pure module every picker uses;
 *  - #384 stable scroll/selection: selection lives in the URL (`?skill=<name>`), the rows are
 *    keyed React elements inside one persistent scroll container — a refresh re-renders rows
 *    in place instead of rebuilding the pane, so neither the selection nor the scroll
 *    position can be lost (the legacy innerHTML rebuild lost both).
 *
 * The pinned "Run from GitHub" entry (spec 011 — must not drown under a long team catalog)
 * opens the bookmarklet panel via the legacy `__bm` sentinel in the same query param.
 *
 * One catalog for every skill (hearsay-tools/cezarion#1408, port of upstream open-mercato/cezar#1082):
 * **Enabled** lists what agents can pick, **Available** the default (vendor) team skills switched
 * off for this project. Any row previews in the detail pane, and a default skill's switch changes
 * this project's selection (`useSkillSelection`). The legacy `__import` sentinel now selects the
 * first Available skill.
 */

const BOOKMARKLETS = '__bm'
const IMPORT = '__import'

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
  const queryClient = useQueryClient()
  const projects = useProjects()
  const scope = useProjectScope()
  const updateProjectId = scope.projectId ?? projects.data?.bootProject ?? ''
  // The same scope `queryKeys.skills` reads, so a save invalidates the catalog this page shows.
  const selectionProject = queryScope()
  const importable = useMemo(() => importableQuery.data ?? [], [importableQuery.data])
  const importableNames = useMemo(() => importable.map((skill) => skill.name), [importable])
  const selection = useSkillSelection(selectionProject, importableNames)

  const refresh = useMutation({
    mutationFn: () => refreshSkills(),
    onSuccess: (catalog) => {
      // The POST answers the merged catalog — seed the shared query instead of refetching.
      queryClient.setQueryData(queryKeys.skills, catalog)
      // The fetch can change which team skills are defaults too; the switches read that list.
      void queryClient.invalidateQueries({ queryKey: queryKeys.importableSkills })
      toast('Team skills refreshed.')
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

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

  const catalog = skillsQuery.data ?? []
  // Until the default list is known (loading or failed), no team skill can be switched: its
  // switch shows on and disabled, and nothing is listed as Available.
  const defaultsKnown = importableQuery.isSuccess
  const defaults = new Set(importableNames)
  const isDefault = (skill: Skill) => skill.source === 'team' && defaults.has(skill.name)
  const catalogNames = new Set(catalog.map((skill) => skill.name))
  // The catalog is the server's answer; the selection is the optimistic one. A default skill
  // follows the selection at once, so a switch moves its row before the catalog re-reads.
  // Both groups sort like the server's catalog (by name), then project-first (`orderSkills`).
  const byName = (list: Skill[]) => orderSkills([...list].sort((a, b) => a.name.localeCompare(b.name)))
  const enabled = byName([
    ...catalog.filter((skill) => !defaultsKnown || !isDefault(skill) || selection.enabled.has(skill.name)),
    ...(defaultsKnown
      ? importable.filter((skill) => selection.enabled.has(skill.name) && !catalogNames.has(skill.name))
      : []),
  ])
  const enabledNames = new Set(enabled.map((skill) => skill.name))
  const available = defaultsKnown
    ? byName(importable.filter((skill) => !selection.enabled.has(skill.name) && !enabledNames.has(skill.name)))
    : []
  const listed = [...enabled, ...available]

  const activationFor = (skill: Skill): SkillActivation => {
    if (skill.source === 'team' && (!defaultsKnown || defaults.has(skill.name))) {
      const checked = defaultsKnown ? selection.enabled.has(skill.name) : true
      return {
        ariaLabel: `Enable ${skill.name}`,
        checked,
        disabled: !defaultsKnown || !selection.ready,
        locked: false,
        onCheckedChange: () => selection.toggle(skill.name),
      }
    }
    return {
      ariaLabel: `${skill.name} is always enabled`,
      checked: true,
      disabled: true,
      locked: true,
      onCheckedChange: () => {},
    }
  }

  const param = searchParams.get('skill')
  // Explicit choice if it is still listed, else the first enabled skill, else the first
  // available one, else the bookmarklet panel. A vanished selection degrades, it never crashes.
  // `__import` (the retired "Manage skills" panel) selects the first Available skill.
  const fallback = enabled[0]?.name ?? available[0]?.name ?? BOOKMARKLETS
  const current =
    param === BOOKMARKLETS
      ? param
      : param === IMPORT
        ? (available[0]?.name ?? fallback)
        : param !== null && listed.some((skill) => skill.name === param)
          ? param
          : fallback
  const selected = listed.find((skill) => skill.name === current) ?? null
  const shownEnabled = filterSkills(enabled, query)
  const shownAvailable = filterSkills(available, query)

  return (
    <div data-slot="skills-section" className="@container flex min-w-0 flex-col gap-[22px]">
      <header className="flex flex-col gap-4 @min-[700px]:flex-row @min-[700px]:items-center @min-[700px]:justify-between">
        <div>
          <h1 className="text-[25px] font-semibold md:text-[30px]">Skills</h1>
          <p className="mt-2 text-xs text-muted-foreground md:text-[13px]">Markdown playbooks your agents can follow.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/skills?skill=${BOOKMARKLETS}`}
            data-slot="bookmarklets-row"
            aria-current={current === BOOKMARKLETS ? 'page' : undefined}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-medium aria-[current=page]:bg-accent-strong/10 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ZapIcon aria-hidden="true" className="size-4 text-link-foreground" />
            Run from GitHub
          </Link>
        </div>
      </header>
      <div className={cn(
        'flex-col items-start gap-2 sm:flex-row sm:items-center md:flex',
        param === null ? 'flex' : 'hidden',
      )}>
        <div className="sw-search relative w-full min-w-0 flex-1">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
        <Input
          data-slot="skills-filter"
          placeholder="Filter skills…"
          aria-label="Filter skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-11 min-w-0 bg-card pl-9 text-xs"
        />
        </div>
        <button
          type="button"
          data-slot="skills-refresh"
          title="git fetch the team skills repos"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-55"
        >
          <RefreshCwIcon
            aria-hidden="true"
            className={cn('size-3', refresh.isPending && 'motion-safe:animate-spin')}
          />
          Refresh
        </button>
      </div>

      <div className="grid min-w-0 items-start gap-[22px] md:grid-cols-[minmax(220px,310px)_minmax(0,1fr)]">
        <section
          data-slot="skills-list"
          className={cn(
            'min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3 md:flex',
            param === null ? 'flex' : 'hidden',
          )}
        >
          {updateProjectId ? <SkillsUpdateCard projectId={updateProjectId} /> : null}
          {importableQuery.isError ? (
            <div
              role="alert"
              data-slot="skills-importable-error"
              className="flex flex-col items-start gap-2 rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground"
            >
              <span>
                Could not load the default skills, so they cannot be switched right now. Your saved choice is kept.
                {' '}
                {importableQuery.error.message}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={importableQuery.isFetching}
                onClick={() => void importableQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          <div
            data-slot="skill-rows"
            className="flex min-h-0 flex-col gap-4 overflow-y-auto md:max-h-[calc(100dvh-280px)]"
          >
            {skillsQuery.isPending ? (
              <p role="status" aria-busy="true" className="min-h-72 p-3 text-[13px] text-muted-foreground">
                Loading skills…
              </p>
            ) : shownEnabled.length + shownAvailable.length > 0 ? (
              <>
                {shownEnabled.length > 0 ? (
                  <SkillGroup slot="skills-group-enabled" title={`Enabled · ${shownEnabled.length}`}>
                    {shownEnabled.map((skill) => (
                      <SkillRow
                        key={skill.path}
                        skill={skill}
                        active={current === skill.name}
                        activation={activationFor(skill)}
                      />
                    ))}
                  </SkillGroup>
                ) : null}
                {shownAvailable.length > 0 ? (
                  <SkillGroup slot="skills-group-available" title={`Available · ${shownAvailable.length}`}>
                    {shownAvailable.map((skill) => (
                      <SkillRow
                        key={skill.path}
                        skill={skill}
                        active={current === skill.name}
                        activation={activationFor(skill)}
                      />
                    ))}
                  </SkillGroup>
                ) : null}
              </>
            ) : (
              <p className="px-2.5 py-2 text-xs leading-relaxed text-soft-foreground">
                {listed.length > 0 ? '(no skills match)' : <SkillEmptyHint />}
              </p>
            )}
          </div>
        </section>

        {/* Detail pane. On narrow containers, the URL switches between catalog and reader. */}
        <section
          data-slot="skills-detail"
          className={cn(
            'min-w-0 flex-col rounded-xl border border-border bg-card md:flex',
            param === null ? 'hidden' : 'flex',
          )}
        >
          <div className="min-w-0 p-5">
            <Link
              to="/skills"
              data-slot="skills-back"
              className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted md:hidden"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
              Back to skills
            </Link>

            {current === BOOKMARKLETS ? (
              <BookmarkletPanel skills={enabled} />
            ) : selected ? (
              <SkillDetailBody
                skill={selected}
                usedBy={skillUsedBy(workflowsQuery.data?.workflows ?? [], selected.name)}
                activation={activationFor(selected)}
              />
            ) : skillsQuery.isPending ? (
              <div role="status" aria-busy="true" className="min-h-72 text-xs text-muted-foreground">
                Loading skill…
              </div>
            ) : (
              <CenteredState
                icon={<SparklesIcon />}
                tone="neutral"
                heading="h2"
                title="No skill selected"
                subtitle="Pick a skill from the catalog."
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function SkillGroup({ slot, title, children }: { slot: string; title: string; children: ReactNode }) {
  return (
    <section data-slot={slot} aria-label={title} className="flex flex-col gap-1">
      <h2 className="px-2.5 text-[12px] font-semibold tracking-wide text-muted-foreground">{title}</h2>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  )
}

function SkillRow({ skill, active, activation }: { skill: Skill; active: boolean; activation: SkillActivation }) {
  const project = isProjectSkill(skill)
  return (
    <li className="flex min-w-0 items-start gap-1">
      <Link
        to={`/skills?skill=${encodeURIComponent(skill.name)}`}
        data-slot="skill-row"
        data-skill={skill.name}
        data-project={project ? 'true' : undefined}
        data-enabled={activation.checked ? 'true' : undefined}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'selection-row flex min-h-24 min-w-0 flex-1 flex-col gap-2 rounded-lg border-b border-border p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
          active && 'border-transparent bg-accent-strong/10',
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
          <span className="line-clamp-2 text-xs leading-relaxed text-supporting-foreground">
            {skill.description}
          </span>
        ) : null}
        <SkillSourceTag
          source={skill.source}
          className="self-start border-0 bg-transparent p-0 text-link-foreground"
        />
      </Link>
      <span className="pt-2">
        <SkillSwitch skill={skill} activation={activation} />
      </span>
    </li>
  )
}
