import './skills-workflows.css'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  DownloadIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  TriangleAlertIcon,
  ZapIcon,
} from '@/components/design-icons'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { refreshSkills } from '@/api/client'
import { queryKeys, useImportableSkills, useProjects, useSkills, useWorkflows } from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import type { Skill } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { ImportSkillsPanel } from '@/components/skills-import-panel'
import { SkillDetailBody, SkillSourceTag } from '@/components/skill-detail'
import { SkillEmptyHint } from '@/components/skill-empty-hint'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { filterSkills, isProjectSkill, orderSkills, skillUsedBy } from '@/lib/skills'
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

  const refresh = useMutation({
    mutationFn: () => refreshSkills(),
    onSuccess: (catalog) => {
      // The POST answers the merged catalog — seed the shared query instead of refetching.
      queryClient.setQueryData(queryKeys.skills, catalog)
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

  const skills = orderSkills(skillsQuery.data ?? [])
  // Only offer the import surface when a default (vendor) repo actually has skills to import —
  // a repo with its own configured `skillsRepos` gates nothing, so the endpoint answers empty.
  const canImport = (importableQuery.data?.length ?? 0) > 0
  const param = searchParams.get('skill')
  // Explicit choice if it still exists, else the first skill, else the bookmarklet panel —
  // the legacy fallback rule. A vanished selection degrades, it never crashes. The two pinned
  // panels (import, bookmarklets) are sentinels, not catalog names.
  const selection =
    param === BOOKMARKLETS || param === IMPORT
      ? param
      : param !== null && skills.some((skill) => skill.name === param)
        ? param
        : (skills[0]?.name ?? (canImport ? IMPORT : BOOKMARKLETS))
  const selected = skills.find((skill) => skill.name === selection) ?? null
  const shown = filterSkills(skills, query)

  return (
    <div data-slot="skills-section" className="@container flex min-w-0 flex-col gap-[22px]">
      <header className="flex flex-col gap-4 @min-[700px]:flex-row @min-[700px]:items-center @min-[700px]:justify-between">
        <div>
          <h1 className="text-[25px] font-semibold md:text-[30px]">Skills</h1>
          <p className="mt-2 text-xs text-muted-foreground md:text-[13px]">Markdown playbooks your agents can follow.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canImport ? (
            <Link
              to={`/skills?skill=${IMPORT}`}
              data-slot="import-skills-row"
              aria-current={selection === IMPORT ? 'page' : undefined}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-medium aria-[current=page]:bg-accent-strong/10 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <DownloadIcon aria-hidden="true" className="size-4 text-link-foreground" />
              Manage skills
            </Link>
          ) : null}
          <Link
            to={`/skills?skill=${BOOKMARKLETS}`}
            data-slot="bookmarklets-row"
            aria-current={selection === BOOKMARKLETS ? 'page' : undefined}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-medium aria-[current=page]:bg-accent-strong/10 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ZapIcon aria-hidden="true" className="size-4 text-link-foreground" />
            Run from GitHub
          </Link>
        </div>
      </header>
      <div className={cn(
        'flex-col items-start gap-2 sm:flex-row sm:items-center @min-[650px]:flex',
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

      <div className="grid min-w-0 items-start gap-[22px] @min-[650px]:grid-cols-[minmax(220px,310px)_minmax(0,1fr)]">
        <section
          data-slot="skills-list"
          className={cn(
            'min-w-0 flex-col rounded-xl border border-border bg-card p-3 @min-[650px]:flex',
            param === null ? 'flex' : 'hidden',
          )}
        >
          <ul
            data-slot="skill-rows"
            className="flex min-h-0 flex-col gap-1 overflow-y-auto @min-[650px]:max-h-[calc(100dvh-280px)]"
          >
            {skillsQuery.isPending ? (
              <li role="status" aria-busy="true" className="min-h-72 p-3 text-[13px] text-soft-foreground">
                Loading skills…
              </li>
            ) : shown.length > 0 ? (
              shown.map((skill) => (
                <SkillRow key={skill.path} skill={skill} active={selection === skill.name} highlighted={(selection === IMPORT || selection === BOOKMARKLETS) && skill === skills[0]} />
              ))
            ) : (
              <li className="px-2.5 py-2 text-xs leading-relaxed text-soft-foreground">
                {skills.length > 0 ? '(no skills match)' : <SkillEmptyHint />}
              </li>
            )}
          </ul>
        </section>

        {/* Detail pane. On narrow containers, the URL switches between catalog and reader. */}
        <section
          data-slot="skills-detail"
          className={cn(
            'min-w-0 flex-col rounded-xl border border-border bg-card @min-[650px]:flex',
            param === null ? 'hidden' : 'flex',
          )}
        >
          <div className="min-w-0 p-5">
            <Link
              to="/skills"
              data-slot="skills-back"
              className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted @min-[650px]:hidden"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
              Back to skills
            </Link>

            {selection === IMPORT ? (
              <ImportSkillsPanel projectId={updateProjectId} />
            ) : selection === BOOKMARKLETS ? (
              <BookmarkletPanel skills={skills} />
            ) : selected ? (
              <SkillDetailBody
                skill={selected}
                usedBy={skillUsedBy(workflowsQuery.data?.workflows ?? [], selected.name)}
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

function SkillRow({ skill, active, highlighted }: { skill: Skill; active: boolean; highlighted: boolean }) {
  const project = isProjectSkill(skill)
  return (
    <li>
      <Link
        to={`/skills?skill=${encodeURIComponent(skill.name)}`}
        data-slot="skill-row"
        data-skill={skill.name}
        data-highlighted={highlighted || undefined}
        data-project={project ? 'true' : undefined}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'selection-row flex min-h-24 flex-col gap-2 rounded-lg border-b border-border p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
          (active || highlighted) && 'border-transparent bg-accent-strong/10',
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
    </li>
  )
}
