import '@/routes/skills-workflows.css'
import { ArrowRightIcon } from '@/components/design-icons'
import { Link } from '@/lib/project-router'

import type { Skill } from '@open-mercato/cezar-api-client'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { isProjectSkill } from '@/lib/skills'
import { cn } from '@/lib/utils'

import { Markdown } from '@/routes/task-thread/markdown'

/**
 * The ONE skill detail rendering (R6 Step 1.4, spec §"Skills, Workflows, Inbox"): the
 * Settings → Skills catalog pane and the read-only "View skill" preview the pickers open
 * (GitHub tab, /new composer) both render THIS component — the two surfaces can never drift.
 *
 * Body is markdown (the redesign upgrade over the legacy `<pre>`), through the same
 * Streamdown/Shiki path the thread uses.
 */

/** The source tag every skill listing shows — project sources read emphasized (#377). */
export function SkillSourceTag({ source, className }: { source: Skill['source']; className?: string }) {
  const project = isProjectSkill({ source })
  return (
    <span
      data-slot="skill-source"
      data-source={source}
      className={cn(
        'shrink-0 rounded bg-accent-strong/10 px-2 py-1 text-[12px]',
        project ? 'font-semibold text-foreground' : 'text-soft-foreground',
        className,
      )}
    >
      {source === 'team' ? 'Team' : source}
    </span>
  )
}

/**
 * Whether a skill is enabled for this project, and how to change it (hearsay-tools/cezarion#1408).
 * A `locked` switch is on for good: local and global skills, and team skills from a repo the
 * project configured itself. Only default (vendor) team skills have a live switch.
 */
export interface SkillActivation {
  ariaLabel: string
  checked: boolean
  disabled: boolean
  locked: boolean
  onCheckedChange: () => void
}

/** The activation switch: a real `role="switch"`, its own tab stop. The track is 24×40 px; a
 *  transparent `before:` layer on the button itself widens the hit area to 44×48 px. */
export function SkillSwitch({ skill, activation }: { skill: Pick<Skill, 'name'>; activation: SkillActivation }) {
  return (
    <span className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
      <Switch
        data-slot="skill-switch"
        data-skill={skill.name}
        data-locked={activation.locked || undefined}
        aria-label={activation.ariaLabel}
        checked={activation.checked}
        disabled={activation.disabled}
        onCheckedChange={() => activation.onCheckedChange()}
        className="relative before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[''] disabled:cursor-default"
      />
    </span>
  )
}

export function SkillDetailBody({
  skill,
  usedBy,
  activation,
  heading: Heading = 'h2',
}: {
  skill: Skill
  /** "workflow › step" breadcrumbs (`skillUsedBy`). Omit to hide the section (the pickers'
   *  preview has no workflow catalog at hand — absence must not read as "unused"). */
  usedBy?: readonly string[]
  /** The catalog's switch for this skill. Omit where the skill cannot be switched (pickers). */
  activation?: SkillActivation
  heading?: 'h2' | 'h3'
}) {
  return (
    <div data-slot="skill-detail" className="min-w-0">
      <div className="flex min-w-0 flex-col items-start gap-4">
        <span className="sw-detail-source text-[12px]"><SkillSourceTag source={skill.source} /> skill</span>
        <div className="flex w-full min-w-0 items-start justify-between gap-3">
          <Heading className="min-w-0 text-[19px] font-normal md:text-2xl break-words [overflow-wrap:anywhere]">
            {skill.name}
          </Heading>
          {activation ? <SkillSwitch skill={skill} activation={activation} /> : null}
        </div>
      </div>
      {activation && !activation.checked ? (
        <p
          data-slot="skill-inactive-notice"
          className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-[13px] text-muted-foreground"
        >
          Not enabled for this project — agents can’t pick it.
        </p>
      ) : null}
      <p data-slot="skill-path" className="mt-4 text-[12px] break-all text-soft-foreground">
        {skill.path}
        {skill.team ? ` · from ${skill.team.repo}` : ''}
      </p>
      {skill.description ? (
        <p data-slot="skill-description" className="mt-2.5 text-[13px] text-muted-foreground">
          {skill.description}
        </p>
      ) : null}

      {usedBy !== undefined ? (
        <section data-slot="skill-used-by" className="mt-5">
          <h3 className="text-[13px] font-semibold">Used by</h3>
          {usedBy.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-1">
              {usedBy.map((entry) => (
                <li key={entry} className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
                  {entry}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-xs text-soft-foreground">
              Not referenced by a workflow yet. quick-task can use it when the task mentions it.
            </p>
          )}
        </section>
      ) : null}

      <section className="mt-5">
        <div data-slot="skill-body" className="mt-2 text-sm">
          <Markdown>{skill.body}</Markdown>
        </div>
      </section>
    </div>
  )
}

/**
 * The read-only "View skill" preview the cmdk pickers open. `skill === null` keeps the dialog
 * mounted-but-closed so open/close animates. The footer link jumps to the full catalog entry
 * under Settings — the browsable home of the same detail.
 */
export function SkillPreviewDialog({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  return (
    <Dialog open={skill !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-slot="skill-preview" className="block max-h-[80dvh] overflow-y-auto sm:max-w-2xl">
        {skill ? (
          <>
            {/* The visible title is SkillDetailBody's heading; these two feed the dialog a11y contract. */}
            <DialogTitle className="sr-only">{skill.name}</DialogTitle>
            <DialogDescription className="sr-only">Read-only skill preview</DialogDescription>
            <SkillDetailBody skill={skill} heading="h3" />
            <p className="mt-5">
              <Link
                to={`/skills?skill=${encodeURIComponent(skill.name)}`}
                data-slot="skill-preview-manage"
                onClick={onClose}
                className="text-xs font-semibold text-accent-text hover:underline"
              >
                Open in the Skills catalog
              </Link>
            </p>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
