import { TriangleAlertIcon, ZapIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useHealth, useLaunchKey, useProjects, useSkills } from '@/api/queries'
import type { Skill } from '@open-mercato/cezar-api-client'
import { repoChipOf } from '@/components/app-shell-container'
import { CenteredState } from '@/components/centered-state'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { bookmarkletUrl } from '@/lib/bookmarklet'
import { useActiveProjectId } from '@/lib/project-router'
import { orderSkills } from '@/lib/skills'

/** Settings → Bookmarklets (spec 011): the legacy generic and per-skill launchers promoted
 *  to a first-class, discoverable Settings subpage. */
export function BookmarkletsSection() {
  const skillsQuery = useSkills()

  // Without this the in-flight catalog renders as the panel's empty state, which tells the
  // user "(no skills yet)" — a claim that is simply false while the fetch is still running.
  if (skillsQuery.isPending) {
    return (
      <p data-slot="bookmarklets-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading bookmarklets…
      </p>
    )
  }
  if (skillsQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load bookmarklets"
        subtitle={skillsQuery.error.message}
      />
    )
  }

  return (
    <div className="flex min-h-full flex-1 overflow-y-auto">
      <BookmarkletPanel skills={orderSkills(skillsQuery.data ?? [])} />
    </div>
  )
}

/**
 * The bookmarklet generator panel (spec 011, ported from the legacy cockpit): draggable
 * `javascript:` links against the protected `/new?skill=&key=` contract (`lib/bookmarklet`).
 * A failed key fetch degrades exactly like legacy — the links still generate, auto-start
 * just will not arm.
 *
 * Project-scoped since the multi-project spec (step 3.6): the pane lives under each project's
 * settings, and the links it makes carry that project's URL prefix AND that project's launch
 * key. Both fall out of the surrounding scope machinery — nothing here picks a project.
 *
 * Exported so the former Settings → Skills deep link remains compatible while the same
 * generator also has its own Settings subpage.
 */
export function BookmarkletPanel({ skills }: { skills: readonly Skill[] }) {
  const launchKey = useLaunchKey()
  const health = useHealth()
  const projects = useProjects()
  const [auto, setAuto] = useState(false)
  const [filter, setFilter] = useState('')
  // THIS project's own launch key: `useLaunchKey` goes through the scoped API client, so under
  // `/p/<id>/settings` it reads `/api/p/<id>/launch-key` — that repo's `.ai/cezar/launch-key`,
  // which is the only secret the target cockpit scope will accept (multi-project spec, 3.6).
  const key = launchKey.data?.key ?? ''
  // Bake THIS cockpit's origin into the bookmarklets so a click opens the very instance that
  // generated them — no localhost port-scan (GitHub's CSP blocks that fetch). See bookmarklet.ts.
  const origin = window.location.origin
  // …and the project the URL should land in. The boot project mounts UNSCOPED, so the context
  // says null and the URL's own `/p/<id>` prefix is what answers (see `useActiveProjectId`);
  // `bootProject` covers the sliver of time a legacy flat URL is still mid-redirect. Null all
  // the way down degrades to the legacy flat `/new`, which redirects to the boot project — so
  // the generator never emits a URL that fails to land.
  const projectId = useActiveProjectId() ?? health.data?.bootProject ?? null
  // The project name stamped into the bookmark's visible label, so a person with several
  // projects (or several cockpits) open can tell their bookmarks apart in the bar (#422). The
  // REGISTRY answers per project: `/api/health` is workspace-level (never scoped) and always
  // describes the boot repo, so reading the name from it would stamp the boot project's name
  // onto every other project's launchers. It stays the fallback for the registry-unavailable
  // case. Null (outside a git repo, nothing known): the label drops the stamp rather than
  // guessing a name.
  const repoName =
    projects.data?.projects.find((project) => project.id === projectId)?.name ??
    repoChipOf(health.data)?.name ??
    null
  const needle = filter.trim().toLowerCase()
  const shown = skills.filter((skill) => skill.name.toLowerCase().includes(needle))

  return (
    <div data-slot="bookmarklet-panel" className="flex w-full min-w-0 flex-col gap-[18px] p-5">
      <span className="w-fit rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
        BOOKMARKLETS{repoName ? ` · ${repoName}` : ''}
      </span>
      <h2 className="text-xl font-semibold">Run from GitHub</h2>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Drag a launcher to your browser&apos;s bookmarks bar. Then open a GitHub PR or issue and
        click that bookmark. Cezar must be running: <span className="font-mono">npx cezarion</span>.
      </p>

      <label className="flex min-h-11 items-center gap-2.5 text-[13px] font-medium">
        <input
          type="checkbox"
          data-slot="bm-auto"
          checked={auto}
          onChange={(event) => setAuto(event.target.checked)}
          className="size-[18px] shrink-0"
        />
        One-click launch (auto-submit)
      </label>
      <p className="text-xs leading-relaxed text-soft-foreground">
        Off by default. Re-drag the launchers after changing this option.
      </p>

      <div data-slot="bm-generic" className="rounded-lg border border-border bg-muted/30 p-3.5">
        {/* Generic launcher: no skill, auto forced off — it only prefills the form. */}
        <BookmarkletRow
          label={repoName ? `cezar (${repoName}): this PR/issue` : 'cezar: this PR/issue'}
          url={bookmarkletUrl('', false, key, origin, projectId)}
          generic
          hint="Prefills the form only—never auto-starts, even when auto-submit is on."
        />
      </div>

      <Input
        data-slot="bm-filter"
        placeholder="Filter bookmarklet skills…"
        aria-label="Filter bookmarklet skills"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="h-11 text-[13px]"
      />
      <div
        data-slot="bm-list"
        className="flex flex-col divide-y divide-border [&>[data-slot=bm-row]]:py-3.5"
      >
        {shown.length > 0 ? (
          shown.map((skill) => (
            <BookmarkletRow
              key={skill.path}
              label={repoName ? `/${skill.name} (${repoName})` : `/${skill.name}`}
              url={bookmarkletUrl(skill.name, auto, key, origin, projectId)}
            />
          ))
        ) : (
          <p className="text-xs text-soft-foreground">
            {skills.length > 0
              ? '(no skills match)'
              : '(no skills yet — the generic launcher above still works)'}
          </p>
        )}
      </div>
      <p className="text-xs leading-relaxed text-soft-foreground">
        These are bookmarklet drag sources, not run buttons. Clicking one here explains
        installation; it does not start a task.
      </p>
      <p className="text-xs leading-relaxed text-soft-foreground md:hidden">
        No drag-and-drop? Copy the URL for manual bookmark setup where your browser allows it, or
        install using a desktop browser.
      </p>
    </div>
  )
}

function BookmarkletRow({
  label,
  url,
  hint,
  generic = false,
}: {
  label: string
  url: string
  hint?: string
  generic?: boolean
}) {
  // React (rightly) refuses `javascript:` hrefs at render time — but a bookmarklet IS one by
  // definition, and dragging to the bookmarks bar needs the real href on the DOM node. The
  // link is a drag source only (the click handler below never lets it execute), so setting
  // the attribute imperatively is the honest escape hatch.
  const anchor = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    anchor.current?.setAttribute('href', url)
  }, [url])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast('Bookmarklet URL copied.')
    } catch {
      toast('Copy failed — drag the button instead.', { tone: 'danger' })
    }
  }
  return (
    <div data-slot="bm-row" className="flex min-w-0 flex-col gap-2.5">
      <p className="break-words text-[13px] font-medium">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        {/* A drag SOURCE only — the cockpit page never executes the javascript: URL itself
          (spec 011 §5), so a plain click just explains the gesture. */}
        <a
          ref={anchor}
          draggable
          data-slot="bm-link"
          title="Drag me to your bookmarks bar"
          aria-label={`${generic ? 'Drag to bookmarks' : 'Drag launcher'}: ${label}`}
          onClick={(event) => {
            event.preventDefault()
            toast('Drag me to your bookmarks bar')
          }}
          className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted ${generic ? "after:content-['Drag_to_bookmarks']" : "after:content-['Drag_launcher']"}`}
        >
          <ZapIcon aria-hidden="true" className="size-3 text-link-foreground" />
          {/* Keep the actual link text as the bookmark name when the browser saves a drag. */}
          <span className="sr-only">{label}</span>
        </a>
        <button
          type="button"
          data-slot="bm-copy"
          title="Copy the bookmarklet URL"
          onClick={() => void copy()}
          className="min-h-11 shrink-0 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Copy URL
        </button>
      </div>
      {hint ? <p className="text-xs leading-relaxed text-soft-foreground">{hint}</p> : null}
    </div>
  )
}
