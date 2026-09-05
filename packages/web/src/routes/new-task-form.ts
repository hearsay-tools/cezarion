import { runnerDiscoversModels } from '@open-mercato/cezar-api-client'
import type {
  BackendCheck,
  CreateRunInput,
  CreateRunResponse,
  AttachmentInput,
  ModelDiscoveryRunner,
  Runner,
  RunnerModelCatalogResponse,
  Skill,
  UiState,
  WorkflowDef,
} from '@open-mercato/cezar-api-client'

/**
 * The new-task form's picker rules and its POST body, as pure functions — the exact semantics
 * of the legacy form (web/app.js: `RUNNERS`, `MODELS_BY_RUNNER`, `renderChrome`,
 * `defaultTaskSource`, the submit handler), kept apart from the component so every rule is
 * table-testable and so drift from legacy is a diff in ONE file, not a scavenger hunt.
 */

/** What the composer runs: a named workflow or a single skill. The same shape the server's
 *  `ui-state.json` stores as `lastTask`, so persistence needs no mapping. */
export type TaskSource = NonNullable<UiState['lastTask']>

/** The zero-config built-in: one agent step that runs the prompt. It is what a task with NO
 *  source picked runs as, which is why the composer's picker does not also offer it as a
 *  workflow row — "No skill" and "quick-task" would be two names for one run. */
export const QUICK_TASK = 'quick-task'

/** Prepend `source` to the recency list (newest first), dropping any earlier occurrence of the
 *  same source+ref, and cap the length. Pure so the picker's recency sort is table-testable. */
export function pushRecentSource(
  recent: readonly TaskSource[] | undefined,
  source: TaskSource,
  cap = 24,
): TaskSource[] {
  const rest = (recent ?? []).filter((s) => !(s.source === source.source && s.ref === source.ref))
  return [source, ...rest].slice(0, cap)
}

export interface RunnerOption {
  id: Runner
  label: string
  desc: string
}

/** The agent-backend catalog (legacy `RUNNERS`). Installation-only compatibility surfaces use
 *  `availableRunners`; the new-task composer filters this catalog by connected provider status. */
export const RUNNERS: readonly RunnerOption[] = [
  { id: 'claude', label: 'claude', desc: 'Claude Code CLI' },
  { id: 'codex', label: 'codex', desc: 'OpenAI Codex (app-server)' },
  { id: 'opencode', label: 'opencode', desc: 'OpenCode (serve)' },
  { id: 'pi', label: 'pi', desc: 'pi CLI (provider/model)' },
]

export interface ModelPreset {
  id: string
  label: string
  desc: string
}

/** Fallback suggestions when host discovery is unavailable. Auto omits the model flag;
 * Claude tier aliases are resolved by the CLI. Explicit pins are appended separately. */
export const MODELS_BY_RUNNER: Record<Runner, readonly ModelPreset[]> = {
  claude: [
    { id: '', label: 'auto', desc: 'Pick the best model per step' },
    { id: 'opus', label: 'opus', desc: 'Deep reasoning for hard tasks' },
    { id: 'sonnet', label: 'sonnet', desc: 'Fast and cheap' },
    { id: 'haiku', label: 'haiku', desc: 'Fastest — simple, scoped tasks' },
  ],
  codex: [
    { id: '', label: 'auto', desc: 'Use your Codex default model' },
  ],
  opencode: [
    { id: '', label: 'auto', desc: 'Use your OpenCode default model' },
  ],
  // pi selects a model with the same `provider/model` convention as opencode, and its
  // entries come from discovery (`pi --list-models`) for the same reason OpenCode's do.
  pi: [
    { id: '', label: 'auto', desc: 'Use your pi default model' },
  ],
}

/** Shared effort catalog (#45). `value: ''` is auto — omitted on the wire, harness default.
 * Model discovery may select an ordered subset; missing metadata keeps this complete fallback. */
export const EFFORT_OPTIONS = [
  { value: '', label: 'auto', desc: 'Harness default' },
  { value: 'low', label: 'low', desc: 'Less reasoning, faster replies' },
  { value: 'medium', label: 'medium', desc: 'Balanced reasoning' },
  { value: 'high', label: 'high', desc: 'More reasoning for hard tasks' },
  { value: 'xhigh', label: 'xhigh', desc: 'Extra-high reasoning' },
  { value: 'max', label: 'max', desc: 'Maximum reasoning' },
] as const

export type EffortOption = (typeof EFFORT_OPTIONS)[number]

/** `auto` plus this model's discovered levels, or the complete backward-compatible fallback. */
export function effortOptionsForModel(
  runner: Runner,
  model: string,
  catalog?: RunnerModelCatalogResponse,
): readonly EffortOption[] {
  const levels = runnerDiscoversModels(runner)
    ? catalog?.models.find((entry) => entry.id === model)?.effortLevels
    : undefined
  if (!levels?.length) return EFFORT_OPTIONS

  const options: EffortOption[] = [EFFORT_OPTIONS[0]]
  const seen = new Set<string>()
  for (const level of levels) {
    if (seen.has(level)) continue
    const option = EFFORT_OPTIONS.find((candidate) => candidate.value === level)
    if (!option) continue
    seen.add(level)
    options.push(option)
  }
  return options.length > 1 ? options : EFFORT_OPTIONS
}

/** Resolve stale or inherited effort through the same options the picker displays. */
export function resolveEffort(
  effort: string | null | undefined,
  options: readonly EffortOption[],
): string {
  const value = effort ?? ''
  return options.some((option) => option.value === value) ? value : ''
}

/** Runners that pick with the canonical `provider/model` convention and span every provider the
 *  host has configured, so an id they list is never EXCLUSIVE to them: both pi and OpenCode
 *  can serve `openai/gpt-5.1` from the same provider. Their discovered ids are therefore
 *  skipped when judging another runner's id.
 *
 *  This is the cockpit's half of the rule the server states structurally — a runner with no
 *  default provider cannot be contradicted, which is why `KNOWN_PRESETS_BY_RUNNER.pi` is empty
 *  in `packages/cezar/src/core/model-presets.ts`. Without it, treating a discovered pi id as
 *  "another runner's preset" would silently strip a pinned OpenCode model from the OpenCode picker. */
const PROVIDER_SPANNING_RUNNERS: readonly Runner[] = ['opencode', 'pi']

/** Keep recognized presets from another backend out of a runner's custom-model escape hatch
 * (#480).
 * Unknown ids remain valid custom models; only a known cross-runner mismatch is discarded. */
export function modelConflictsWithRunner(model: string, runner: Runner): boolean {
  if (!model || MODELS_BY_RUNNER[runner].some((preset) => preset.id === model)) return false
  // Preserve the retired dated suggestions' mismatch guard. Provider-qualified IDs stay free-form.
  const legacyClaudeIds = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']
  if (runner !== 'claude' && legacyClaudeIds.includes(model)) return true
  return Object.entries(MODELS_BY_RUNNER).some(
    ([other, presets]) =>
      other !== runner &&
      !PROVIDER_SPANNING_RUNNERS.includes(other as Runner) &&
      presets.some((preset) => preset.id !== '' && preset.id === model),
  )
}

export function modelsForRunner(
  runner: Runner,
  catalog?: RunnerModelCatalogResponse,
  customIds: readonly (string | null | undefined)[] = [],
): readonly ModelPreset[] {
  const discovered = catalog?.runner === runner ? catalog.models : []
  const presets = MODELS_BY_RUNNER[runner] ?? MODELS_BY_RUNNER.claude
  const base = [...(discovered.length ? presets.slice(0, 1) : presets)]
  const seen = new Set(base.map((model) => model.id))
  if (runnerDiscoversModels(runner)) {
    for (const model of discovered) {
      if (!model.id || seen.has(model.id)) continue
      seen.add(model.id)
      base.push({ id: model.id, label: model.label || model.id, desc: model.description })
    }
  }
  // Native settings may contain a provider-specific/custom id that is not in
  // cezar's static catalog. Keep it representable so the initial selection
  // matches the agent's own configured default on every backend.
  for (const id of customIds) {
    if (!id || seen.has(id) || modelConflictsWithRunner(id, runner)) continue
    seen.add(id)
    base.push({ id, label: id, desc: 'Custom or legacy model' })
  }
  return base
}

/** How each discovery runner is named in the picker's status line. */
const DISCOVERY_RUNNER_LABEL: Record<ModelDiscoveryRunner, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
}

export function modelCatalogStatus(
  runner: Runner,
  catalog: RunnerModelCatalogResponse | undefined,
  failed = false,
  fetching = false,
): string | undefined {
  if (!runnerDiscoversModels(runner)) return undefined
  const name = DISCOVERY_RUNNER_LABEL[runner]
  if (catalog?.stale) return `Using cached ${name} model list`
  if (failed || catalog?.source === 'unavailable') return `Latest ${name} models unavailable`
  if (fetching && !catalog) return `Loading ${name} models…`
  return undefined
}

/** Which runners the pill offers, from the health checks (legacy `renderChrome`). The `claude`
 *  fallback when nothing is detected is deliberate legacy behavior: the form must always have
 *  a runner, and claude is the default engine. */
export function availableRunners(checks: readonly BackendCheck[]): Runner[] {
  const available = RUNNERS.map((r) => r.id).filter((id) =>
    checks.some((c) => c.name === id && c.available),
  )
  return available.length > 0 ? available : ['claude']
}

/** The effective runner: the user's pick when still installed, else the configured default
 *  when installed, else the first available (legacy preselection order). */
export function resolveRunner(
  picked: Runner | null,
  available: readonly Runner[],
  preferred: Runner,
): Runner {
  if (picked !== null && available.includes(picked)) return picked
  if (available.includes(preferred)) return preferred
  return available[0] ?? 'claude'
}

/** The runner field shared by every NEW-run surface. Explicit/sticky intent always rides the
 * request; only an untouched pick matching the active project's known default may be omitted. */
export function runnerOverride(
  runner: Runner,
  defaultRunner: Runner | undefined,
  explicit = false,
): Runner | undefined {
  return !explicit && runner === defaultRunner ? undefined : runner
}

/** The effective model: the user's pick when it exists in the selected runner's presets, else
 *  the configured per-runner default (Settings → Agents `defaultModels`, R6 1.5) when IT is a
 *  known preset, else auto (`''`). An explicit pick — including picking auto — always beats
 *  the configured default (`picked: ''` is a pick; only `null` means "never touched").
 *  Deliberately STRICTER than legacy, which kept a stale `taskModel` in state while displaying
 *  auto — here what is displayed is what is sent. */
export function resolveModel(
  picked: string | null,
  runner: Runner,
  defaults?: Partial<Record<Runner, string>>,
  catalog?: RunnerModelCatalogResponse,
): string {
  const models = modelsForRunner(runner, catalog, [picked, defaults?.[runner]])
  if (picked !== null && models.some((m) => m.id === picked)) return picked
  const preset = defaults?.[runner]
  if (preset !== undefined && models.some((m) => m.id === preset)) return preset
  return ''
}

export function sourceExists(
  source: TaskSource,
  skills: readonly Skill[],
  workflows: readonly WorkflowDef[],
): boolean {
  return source.source === 'skill'
    ? skills.some((s) => s.name === source.ref)
    : workflows.some((w) => w.name === source.ref)
}

/**
 * The effective source: the draft's own pick when the catalog still has it, else NOTHING.
 *
 * `null` is the composer's empty state — no skill and no workflow — and it is what `/new` now
 * opens on. Two mechanisms were removed here, both deliberately:
 *
 *  - the persisted `lastTask` no longer preselects. It was load-bearing for one thing: the
 *    picker remembering a way of working across visits. It also meant a skill picked once sat
 *    in the pill for every task afterwards, with no way out that reads as one (the composer
 *    offered no deselect at all — the only exit was picking the `quick-task` WORKFLOW, which
 *    is what this change is a fix for). `lastTask` is still WRITTEN, so an older cockpit reading
 *    the same `ui-state.json` behaves exactly as it always did.
 *  - the cold quick-task/first-skill fallback chain is gone with it: `null` says "nothing is
 *    selected" honestly, and `buildCreateRunBody` is the one place that turns that into the
 *    plain built-in run the server performs.
 *
 * The existence check stays: a skill deleted since it was drafted must not stay in the pill.
 */
export function resolveSource(
  candidate: TaskSource | null | undefined,
  skills: readonly Skill[],
  workflows: readonly WorkflowDef[],
): TaskSource | null {
  return candidate && sourceExists(candidate, skills, workflows) ? candidate : null
}

/**
 * The exact `POST /api/runs` body the legacy form sends:
 *  - a skill runs as a one-step inline chain (spec 008's API — the same shape the inbox and
 *    the bookmarklet auto-start use): `steps: [{ id: 'task', name, skill, prompt: '{{task}}' }]`;
 *  - a workflow goes by name;
 *  - NO source (`null` — the composer's empty state) goes by the built-in `quick-task` name,
 *    because `POST /runs` requires exactly one of `workflow`/`steps`. That name is also what
 *    the server resolves an inbox/bookmarklet run to, so "nothing selected" and "quick-task
 *    selected" are the same run, which is exactly why the picker offers only one of them;
 *  - an explicit/sticky `runner` always rides the request; an untouched runner is omitted only
 *    when it equals the active project's known default (unknown defaults and connected fallbacks
 *    stay explicit);
 *  - `model`/`variants`/`images` only when they say something (`''`/1/empty mean "default").
 */
export function buildCreateRunBody(opts: {
  task: string
  /** `null` — nothing picked — runs the built-in `quick-task`. */
  source: TaskSource | null
  model: string
  /** Native coding-agent settings stay visible, but a locked model is never a request override. */
  modelsLocked?: boolean
  /** Reasoning-effort pin (#45). `''` = auto, omitted on the wire. Locked with `modelsLocked`. */
  effort?: string
  runner: Runner
  /** True when the draft contains a sticky/user runner choice rather than an untouched default. */
  runnerExplicit?: boolean
  defaultRunner?: Runner
  /** Per-task agent account (spec 2026-07-29-agent-profiles) — the composer's override of the
   *  project's own selection, applying to `runner`. Absent/empty follows the project. */
  agentProfile?: string | null
  variants: number
  images: readonly AttachmentInput[]
  /** false → run in the repo working tree, no worktree (single runs only). Sent only when
   *  explicitly off; the default (isolated worktree) stays implicit. */
  worktree?: boolean
  /** true → autonomous run (never pauses for the user). Sent only when on. */
  autonomous?: boolean
  /** false → do not ask the agent for follow-up todos. Sent only when off. */
  generateFollowups?: boolean
  /** The inbox entry this composer was prefilled from (`/new?…&todo=`, #374) — sent back so
   *  the server records the started run on it. Empty/absent for every other launch.
   *  Independent of `generateFollowups`: starting a task FROM a follow-up still marks that
   *  entry started, even when the new task itself won't generate follow-ups of its own. */
  todoId?: string
}): CreateRunInput {
  const {
    task,
    source,
    model,
    modelsLocked,
    effort,
    runner,
    runnerExplicit,
    defaultRunner,
    agentProfile,
    variants,
    images,
    worktree,
    autonomous,
    generateFollowups,
    todoId,
  } = opts
  return {
    task,
    ...(source?.source === 'skill'
      ? { steps: [{ id: 'task', name: source.ref, skill: source.ref, prompt: '{{task}}' }] }
      : { workflow: source?.ref ?? QUICK_TASK }),
    model: modelsLocked ? undefined : model || undefined,
    effort: modelsLocked ? undefined : effort || undefined,
    runner: runnerOverride(runner, defaultRunner, runnerExplicit),
    // Sent only when the user picked one — an absent key is "follow the project", which is what
    // every launch that never touched the control means.
    agentProfile: agentProfile || undefined,
    variants: variants > 1 ? variants : undefined,
    images: images.length > 0 ? [...images] : undefined,
    // Off only matters for a single run — variants always isolate.
    worktree: worktree === false && variants <= 1 ? false : undefined,
    autonomous: autonomous === true ? true : undefined,
    generateFollowups: generateFollowups === false ? false : undefined,
    todoId: todoId || undefined,
  }
}

/** The automation editor persists the exact New task serialization, with only the transport-
 * specific `task` key renamed to `prompt`. Images and inbox provenance are deliberately absent:
 * an automation is a reusable template, not one browser submission. */
export function buildAutomationTask(
  opts: Parameters<typeof buildCreateRunBody>[0],
): Omit<CreateRunInput, 'task' | 'images' | 'todoId'> & { prompt: string } {
  const { task, images: _images, todoId: _todoId, ...body } = buildCreateRunBody(opts)
  return { prompt: task, ...body }
}

/** Where a successful POST navigates: the run's thread — for ×2/×3 the FIRST variant's thread,
 *  exactly what legacy `handleStarted` selects. */
export function startedRunPath(response: CreateRunResponse): string {
  const first = 'runs' in response ? response.runs[0] : response
  return first ? `/tasks/${first.id}` : '/'
}
