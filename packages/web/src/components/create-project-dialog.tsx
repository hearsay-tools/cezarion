import { productName } from '@/lib/product-name'
import { useCallback, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { useCreateProject, useGithubOwners, useProjects } from '@/api/queries'
import { PROJECT_NAME_PATTERN } from '@open-mercato/cezar-api-client/contract/project-limits'
import type { GithubOwner } from '@open-mercato/cezar-api-client'
import { TriangleAlertIcon } from '@/components/design-icons'
import { GithubTemplateInput } from '@/components/github-template-input'
import { useCheckoutProgress } from '@/components/use-checkout-progress'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/** What the owners query says: the usable owner list, or why GitHub is unavailable. The column
 *  shows placeholders while `gh` answers and the reason when it fails, so the dialog does not
 *  change shape under the user. */
function githubAvailability(owners: ReturnType<typeof useGithubOwners>) {
  const available: GithubOwner[] | null = owners.data?.available ? owners.data.owners : null
  const unavailableReason = owners.isError
    ? `GitHub is unavailable: ${owners.error instanceof Error ? owners.error.message : 'could not ask gh'}`
    : owners.data && !owners.data.available
      ? owners.data.reason
      : null
  return { available, unavailableReason }
}

/** GitHub is on only when the user asked for it AND the owners query delivered a usable list. */
function githubEnabled(githubOn: boolean, available: GithubOwner[] | null): boolean {
  return githubOn && available !== null && available.length > 0
}

/** The owner the form acts on: the user's pick, else the signed-in account (the first owner). */
function resolvedOwner(owner: string | null, available: GithubOwner[] | null): string | null {
  return owner ?? available?.[0]?.login ?? null
}

/** The checkout root's projects folder, without its trailing slash, for the path preview. */
function projectsDirectory(projects: ReturnType<typeof useProjects>): string {
  return (projects.data?.projectsDir ?? '').replace(/\/+$/, '')
}

/** Create is enabled once the name is valid, nothing is in flight, and the GitHub half of the
 *  form is complete: an owner chosen, and a template named when starting from one. */
function createProjectReady({ nameValid, isPending, created, github, chosenOwner, effectiveStart, template }: {
  nameValid: boolean
  isPending: boolean
  created: { projectId: string; warning: string } | null
  github: boolean
  chosenOwner: string | null
  effectiveStart: 'empty' | 'template'
  template: string
}): boolean {
  return nameValid &&
    !isPending &&
    created === null &&
    (!github || (chosenOwner !== null && (effectiveStart === 'empty' || template.trim() !== '')))
}

/** The mutation body: the local project, plus the GitHub half only when it is on and an owner is
 *  chosen — with the template only when starting from one. */
function createProjectPayload({ trimmed, checkoutId, github, chosenOwner, effectiveStart, template }: {
  trimmed: string
  checkoutId: string
  github: boolean
  chosenOwner: string | null
  effectiveStart: 'empty' | 'template'
  template: string
}) {
  return {
    name: trimmed,
    checkoutId,
    ...(github && chosenOwner
      ? { github: { owner: chosenOwner, ...(effectiveStart === 'template' ? { template: template.trim() } : {}) } }
      : {}),
  }
}

/** A 200 with `warning`: the project exists and is registered but its GitHub repository was left
 *  unfinished — shown instead of the form until the user moves on, so the command stays readable
 *  and copyable. The warning's host div stays in the dialog so the element type at that position
 *  is the same in both branches and React keeps the scroll container. */
function CreatedWarning({ created }: { created: { projectId: string; warning: string } }) {
  return (
    <>
      <TriangleAlertIcon aria-hidden="true" className="mbs-0.5 size-5 shrink-0 text-warning" />
      <div className="grid min-w-0 gap-2">
        <p className="font-medium">The project was created, but its GitHub repository is not finished.</p>
        <p className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs">{created.warning}</p>
      </div>
    </>
  )
}

/** The project name: typed as you go into a folder/repository name, invalid names flagged, and
 *  the path preview underneath. Enter creates. */
function NameField({ fieldId, name, setName, trimmed, nameValid, projectsDir, isPending, create }: {
  fieldId: string
  name: string
  setName: (value: string) => void
  trimmed: string
  nameValid: boolean
  projectsDir: string
  isPending: boolean
  create: () => void
}) {
  const nameHintId = `${fieldId}-name-hint`
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`${fieldId}-name`}>Name</Label>
      <Input
        id={`${fieldId}-name`}
        data-slot="create-project-name"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="my-project"
        value={name}
        disabled={isPending}
        aria-invalid={trimmed !== '' && !nameValid}
        aria-describedby={trimmed !== '' && !nameValid ? nameHintId : undefined}
        // GitHub's own form suggests a dash for a space; doing it as you type keeps the
        // folder and the repository spelled the same.
        onChange={(event) => setName(event.target.value.replace(/\s/g, '-'))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') create()
        }}
      />
      {trimmed !== '' && !nameValid ? (
        <p id={nameHintId} data-slot="create-project-name-hint" className="text-xs text-danger">
          Use letters, digits, “.”, “-” and “_” only, starting with a letter or digit — it names the folder
          and the repository.
        </p>
      ) : null}
      <p
        data-slot="create-project-path"
        className="min-w-0 truncate font-mono text-[11px] text-soft-foreground"
        title={`${projectsDir}/${trimmed}`}
      >
        {trimmed === '' ? `${projectsDir}/…` : `${projectsDir}/${trimmed}`}
      </p>
    </div>
  )
}

/** Also create a private GitHub repository: off when the dialog opens, and only switchable once
 *  `gh` answered with a usable owner list. */
function GithubSwitchRow({ fieldId, github, setGithubOn, isPending, available }: {
  fieldId: string
  github: boolean
  setGithubOn: (on: boolean) => void
  isPending: boolean
  available: GithubOwner[] | null
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={`${fieldId}-github`}
        data-slot="create-project-github"
        checked={github}
        disabled={isPending || available === null || available.length === 0}
        onCheckedChange={setGithubOn}
        className="mbs-0.5"
      />
      <div className="grid min-w-0 gap-0.5">
        <Label htmlFor={`${fieldId}-github`}>Also create a private GitHub repository</Label>
        <p className="text-xs text-muted-foreground">
          Under the account you choose. You can change its visibility on GitHub later.
        </p>
      </div>
    </div>
  )
}

/** Empty repository or a GitHub template; the template choice needs the GitHub half on, and
 *  starting from one asks for the template while it is selected. */
function StartOptionsFieldset({ fieldId, effectiveStart, setStart, isPending, github, template, setTemplate }: {
  fieldId: string
  effectiveStart: 'empty' | 'template'
  setStart: (start: 'empty' | 'template') => void
  isPending: boolean
  github: boolean
  template: string
  setTemplate: (template: string) => void
}) {
  return (
    <>
      <fieldset className="grid gap-2" disabled={isPending}>
        <legend className="mbe-2 text-sm font-medium">Start with</legend>
        <StartOption
          slot="create-project-start-empty"
          name={`${fieldId}-start`}
          checked={effectiveStart === 'empty'}
          disabled={isPending}
          onChange={() => setStart('empty')}
          title="Empty repository"
          detail="One empty first commit, no files."
        />
        <StartOption
          slot="create-project-start-template"
          name={`${fieldId}-start`}
          checked={effectiveStart === 'template'}
          disabled={isPending || !github}
          onChange={() => setStart('template')}
          title="From a template"
          detail={github ? 'GitHub generates the repository from a template.' : 'Needs the GitHub repository.'}
        />
      </fieldset>

      {effectiveStart === 'template' ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${fieldId}-template`}>Template</Label>
          <GithubTemplateInput id={`${fieldId}-template`} value={template} onChange={setTemplate} disabled={isPending} />
        </div>
      ) : null}
    </>
  )
}

/** The transient lines between form and footer: the checkout progress while creating, and the
 *  creation failure with its message on its own line. */
function CreateProjectStatus({ isPending, progress, failed, error }: {
  isPending: boolean
  progress: string | null
  failed: boolean
  error: unknown
}) {
  return (
    <>
      {isPending ? (
        <p data-slot="create-project-progress" className="flex-none truncate font-mono text-[11px] text-muted-foreground">
          {progress ?? 'Starting…'}
        </p>
      ) : null}

      {failed ? (
        <p
          data-slot="create-project-error"
          role="alert"
          className="flex-none min-w-0 whitespace-pre-wrap break-words text-[13px] text-danger"
        >
          {error instanceof Error ? error.message : 'could not create the project'}
        </p>
      ) : null}
    </>
  )
}

/** The footer: once created, the only action is opening the project; before that, cancel and
 *  create — the submit button naming the retry after a failure. */
function CreateProjectFooter({ created, goToProject, isPending, onCancel, ready, onCreate, failed }: {
  created: { projectId: string; warning: string } | null
  goToProject: () => void
  isPending: boolean
  onCancel: () => void
  ready: boolean
  onCreate: () => void
  failed: boolean
}) {
  return (
    <DialogFooter className="flex-none">
      {created ? (
        <Button data-slot="create-project-open" onClick={goToProject}>
          Go to project
        </Button>
      ) : (
        <>
          <Button variant="outline" disabled={isPending} onClick={onCancel}>
            Cancel
          </Button>
          <Button data-slot="create-project-submit" disabled={!ready} onClick={onCreate}>
            {isPending ? 'Creating…' : failed ? 'Try again' : 'Create project'}
          </Button>
        </>
      )}
    </DialogFooter>
  )
}

/**
 * "Add project → New project…" (spec 2026-10-15-create-new-project; a port of
 * open-mercato/cezar#1402): a git repository in the checkout root with one empty commit,
 * optionally backed by a new PRIVATE GitHub repository, optionally from a template.
 *
 * - **GitHub is off when the dialog opens**, even with `gh` signed in: creating something on
 *   GitHub is an explicit choice, never a default. There is no visibility control — the server
 *   only ever creates private repositories.
 * - **The owner column never disappears.** It shows placeholders while `gh` answers, the owner
 *   cards once it has, or why GitHub is unavailable — so the dialog does not change shape under
 *   the user, and a failed or malformed owners read leaves local creation fully available.
 * - **A warning keeps the dialog open.** A 200 with `warning` means the project exists and is
 *   registered but its GitHub repository was left unfinished; the toast would vanish before
 *   anyone copied the command that finishes it, so the dialog shows it until the user moves on.
 * - **Progress** is the `checkout-progress` stream filtered to THIS dialog's id, recovered through
 *   the same route the clone dialog uses.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [githubOn, setGithubOn] = useState(false)
  const [owner, setOwner] = useState<string | null>(null)
  const [start, setStart] = useState<'empty' | 'template'>('empty')
  const [template, setTemplate] = useState('')
  const [created, setCreated] = useState<{ projectId: string; warning: string } | null>(null)
  const projects = useProjects()
  const owners = useGithubOwners({ enabled: open })
  const createProject = useCreateProject()
  const { mutate, isPending } = createProject
  const navigate = useNavigate()
  const fieldId = useId()
  // A second Enter lands before React re-renders with `isPending`; the ref closes that gap.
  const inFlight = useRef(false)

  const { checkoutId, progress, setProgress } = useCheckoutProgress('np-', isPending)

  const { available, unavailableReason } = githubAvailability(owners)
  const github = githubEnabled(githubOn, available)
  const chosenOwner = resolvedOwner(owner, available)
  const effectiveStart = github ? start : 'empty'

  const trimmed = name.trim()
  const nameValid = PROJECT_NAME_PATTERN.test(trimmed)
  const projectsDir = projectsDirectory(projects)
  const ready = createProjectReady({ nameValid, isPending, created, github, chosenOwner, effectiveStart, template })

  const create = useCallback(() => {
    if (!ready || inFlight.current) return
    inFlight.current = true
    setProgress(null)
    mutate(
      createProjectPayload({ trimmed, checkoutId, github, chosenOwner, effectiveStart, template }),
      {
        onSettled: () => {
          inFlight.current = false
        },
        onSuccess: ({ project, warning }) => {
          if (warning) {
            setCreated({ projectId: project.id, warning })
            return
          }
          onOpenChange(false)
          // A deliberate cross-project jump, exactly as the clone dialog does.
          navigate(`/p/${encodeURIComponent(project.id)}/`)
        },
      },
    )
  }, [ready, mutate, trimmed, checkoutId, github, chosenOwner, effectiveStart, template, onOpenChange, navigate])

  const goToProject = () => {
    if (!created) return
    onOpenChange(false)
    navigate(`/p/${encodeURIComponent(created.projectId)}/`)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent
        data-slot="create-project-dialog"
        className="flex min-w-0 flex-col overflow-y-clip overflow-x-clip sm:max-w-2xl"
      >
        <DialogHeader className="flex-none">
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            {productName('cezar')} creates a git repository with one empty commit in your checkout root and adds it as a project.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div
            data-slot="create-project-warning"
            role="status"
            className="flex min-h-0 flex-1 gap-3 overflow-y-auto overscroll-contain rounded-md border border-border bg-muted p-4 text-[13px]"
          >
            <CreatedWarning created={created} />
          </div>
        ) : (
          // Form and owner column side by side when there is room, stacked when there is not —
          // the wrap point is a share of the dialog, not a breakpoint.
          <div className="flex min-h-0 flex-1 flex-wrap gap-6 overflow-y-auto overscroll-contain">
            <div className="grid min-w-[50%] grow-[999] basis-0 content-start gap-5">
              <NameField
                fieldId={fieldId}
                name={name}
                setName={setName}
                trimmed={trimmed}
                nameValid={nameValid}
                projectsDir={projectsDir}
                isPending={isPending}
                create={create}
              />

              <GithubSwitchRow fieldId={fieldId} github={github} setGithubOn={setGithubOn} isPending={isPending} available={available} />

              <StartOptionsFieldset fieldId={fieldId} effectiveStart={effectiveStart} setStart={setStart} isPending={isPending} github={github} template={template} setTemplate={setTemplate} />
            </div>

            <OwnerColumn
              owners={available}
              unavailableReason={unavailableReason}
              enabled={github && !isPending}
              chosen={chosenOwner}
              onChoose={setOwner}
              groupName={`${fieldId}-owner`}
            />
          </div>
        )}

        <CreateProjectStatus isPending={isPending} progress={progress} failed={createProject.isError} error={createProject.error} />

        <CreateProjectFooter created={created} goToProject={goToProject} isPending={isPending} onCancel={() => onOpenChange(false)} ready={ready} onCreate={create} failed={createProject.isError} />
      </DialogContent>
    </Dialog>
  )
}

function StartOption({
  slot,
  name,
  checked,
  disabled,
  onChange,
  title,
  detail,
}: {
  slot: string
  name: string
  checked: boolean
  disabled: boolean
  onChange: () => void
  title: string
  detail: string
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 items-start gap-3 rounded-md border border-border p-3',
        'has-[:checked]:border-accent-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <input
        type="radio"
        data-slot={slot}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mbs-0.5 size-4 accent-[var(--color-accent-strong)]"
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  )
}

/**
 * Who owns the new repository: the signed-in account first, then its organisations. Native
 * radios, so arrow keys move the choice and Tab enters and leaves the group as one stop.
 */
function OwnerColumn({
  owners,
  unavailableReason,
  enabled,
  chosen,
  onChoose,
  groupName,
}: {
  owners: GithubOwner[] | null
  unavailableReason: string | null
  enabled: boolean
  chosen: string | null
  onChoose: (login: string) => void
  groupName: string
}) {
  return (
    <fieldset
      data-slot="create-project-owners"
      disabled={!enabled}
      className="grid min-w-0 grow basis-56 content-start gap-2"
    >
      <legend className="mbe-2 text-sm font-medium">Repository owner</legend>
      {unavailableReason !== null ? (
        <p
          data-slot="create-project-github-unavailable"
          className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground break-words"
        >
          {unavailableReason}. Local projects still work.
        </p>
      ) : owners === null ? (
        <>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </>
      ) : (
        owners.map((owner) => (
          <label
            key={owner.login}
            data-slot="create-project-owner"
            className={cn(
              'flex min-h-11 min-w-0 items-center gap-3 rounded-md border border-border p-2.5',
              'has-[:checked]:border-accent-strong has-[:checked]:bg-accent',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              enabled ? 'cursor-pointer pointer-hover:hover:bg-accent' : 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={groupName}
              value={owner.login}
              checked={chosen === owner.login}
              disabled={!enabled}
              onChange={() => onChoose(owner.login)}
              className="sr-only"
            />
            {owner.avatarUrl ? (
              <img src={owner.avatarUrl} alt="" className="size-8 shrink-0 rounded-full object-cover" />
            ) : (
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">
                {owner.login.slice(0, 1)}
              </span>
            )}
            <span className="grid min-w-0">
              <span className="truncate text-[13px] font-medium">{owner.login}</span>
              <span className="truncate text-xs text-muted-foreground">
                {owner.personal ? 'Personal account' : owner.description ?? 'Organization'}
              </span>
            </span>
          </label>
        ))
      )}
    </fieldset>
  )
}
