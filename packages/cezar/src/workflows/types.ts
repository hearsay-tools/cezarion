import { z } from 'zod';
import { RUNNER_IDS, type AgentBackend, type RunnerId } from '../core/agent-runner.ts';

/**
 * A workflow is an ordered list of steps. Two step kinds:
 *  - `agent` — one claude CLI run (prompt + optional skill + model + tools);
 *  - `check` — a shell command; exit 0 passes, non-zero can loop back to an
 *    earlier step via `onFail` (bounded by `max`).
 *
 * `{{task}}` in a prompt is replaced with the user's task text. When a check
 * loops back, the failing output is appended to the retried agent's prompt.
 */
export const workflowStepSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // agent step
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().max(32).optional(),
    /** Authored agent-step wall-clock limit in ms. Omitted or 0 means no limit.
     *  Bound to Node's timer range so a larger value cannot become a 1ms kill. */
    timeoutMs: z.number().int().min(0).max(2_147_483_647).optional(),
    /** Per-step agent backend override (falls back to the task / config default).
     *
     *  Deliberately NOT widened to the legacy `claude-cli` the way the run store's
     *  `runner`/`backend` were (#547). This enum validates two things a user AUTHORS —
     *  workflow YAML, and the inline chain on `POST /runs` — so the selectable set is the
     *  right one, and rejecting `claude-cli` here is a loud load-time error rather than
     *  data loss. It also gates the persisted `workflowDef` (`runs/store.ts`), but nothing
     *  has ever been able to write the legacy id THERE either, because this same enum was
     *  the only way in: there is no legacy shape to keep parseable. */
    runner: z.enum(RUNNER_IDS).optional(),
    /** Agent account id for this step (spec 2026-07-29-agent-profiles). An owned worker resolves
     *  and pins it per step at spawn (#452); an id the registry does not know is refused there. */
    agentProfile: z.string().min(1).max(64).optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    // check step
    command: z.string().optional(),
    onFail: z
      .object({
        retry: z.string().min(1),
        max: z.number().int().positive().default(2),
      })
      .optional(),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.prompt ?? s.skill), {
    message: 'a step is either an agent step (prompt/skill) or a check step (command), not both',
  })
  .refine((s) => !s.command || s.timeoutMs === undefined, {
    message: 'timeoutMs applies only to agent steps',
    path: ['timeoutMs'],
  });

/**
 * A workflow file names either full `steps` or the portable `skills` shorthand
 * (spec 012 — what the builder exports): an ordered list of skill names, each
 * becoming one agent step that applies that skill to `{{task}}`.
 */
export const workflowFileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    steps: z.array(workflowStepSchema).min(1).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .refine((d) => Boolean(d.steps) !== Boolean(d.skills), {
    message: 'a workflow lists either "steps" or "skills", not both',
  });

export type WorkflowStepDef = z.infer<typeof workflowStepSchema>;
export type WorkflowDoc = z.infer<typeof workflowFileSchema>;

/**
 * A resolved workflow: a catalog entry, or the ad-hoc "(planned)" chain a task
 * was started with. A SCHEMA and not an interface because `RunStore` persists
 * one of these on the run record (`workflowDef`) and has to parse it back —
 * `src/server/contract-parity.workflows.test.ts` is what keeps this shape and
 * the contract's `workflowDefSchema` from drifting.
 */
export const workflowDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepSchema),
  source: z.enum(['built-in', 'file']),
  path: z.string().optional(),
});

export type WorkflowDef = z.infer<typeof workflowDefSchema>;

/** `skills: [a, b]` → agent steps, one per skill, each running `{{task}}`. */
export function skillsToSteps(skills: string[]): WorkflowStepDef[] {
  const used = new Set<string>();
  return skills.map((skill) => {
    let id = skill;
    for (let n = 2; used.has(id); n++) id = `${skill}-${n}`;
    used.add(id);
    return { id, name: skill, skill, prompt: '{{task}}' };
  });
}

/** Resolve the steps/skills XOR into plain steps. */
export function normalizeWorkflowDoc(doc: WorkflowDoc): {
  name: string;
  description?: string;
  steps: WorkflowStepDef[];
} {
  return {
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    steps: doc.steps ?? skillsToSteps(doc.skills ?? []),
  };
}

/**
 * The inverse of `skillsToSteps`: when every step is a plain "apply this
 * skill to the task" agent step, return the skill list — the workflow can be
 * written in the portable compact form. Anything richer (checks, custom
 * prompts, per-step models/accounts/tools, loops) returns null — the compact
 * form carries skill names only, so any other field would be dropped on save.
 */
export function skillStackOf(steps: WorkflowStepDef[]): string[] | null {
  const skills: string[] = [];
  for (const s of steps) {
    if (stepKind(s) !== 'agent' || !s.skill) return null;
    if (s.prompt !== undefined && s.prompt !== '{{task}}') return null;
    if (s.name !== undefined && s.name !== s.skill) return null;
    if (s.timeoutMs !== undefined || s.model || s.effort !== undefined || s.runner || s.agentProfile || s.allowedTools || s.bashAllowlist || s.onFail) return null;
    skills.push(s.skill);
  }
  return skills.length ? skills : null;
}

export function stepKind(step: WorkflowStepDef): 'agent' | 'check' {
  return step.command ? 'check' : 'agent';
}

/**
 * Tell each chained agent step to complete its own goal before CEZ:DONE. An earlier step’s done
 * report does not complete a later step’s work. Steps share the task and handoff journal.
 */
export function chainStepNote(steps: WorkflowStepDef[], index: number): string | undefined {
  const step = steps[index];
  if (!step || stepKind(step) !== 'agent') return undefined;
  const total = steps.filter((s) => stepKind(s) === 'agent').length;
  if (total <= 1) return undefined;
  const position = steps.slice(0, index).filter((s) => stepKind(s) === 'agent').length + 1;
  // `name` first: it is what the author called the step and what the GUI rail
  // shows. A `skill` is only ever a support for the step's goal, so naming it
  // as the goal would displace the task text the note sits above.
  const label = step.name ? `"${step.name}"` : step.skill ? `the "${step.skill}" skill` : 'this step';
  const sentences = [
    `This run is a chain of ${total} agent steps; you are running step ${position} of ${total}.`,
    `Your job in THIS step is ${label} — do its work in full.`,
  ];
  // Only steps that HAVE a predecessor; on step 1 the premise would be false.
  if (position > 1) {
    sentences.push(
      `An earlier step in this same run may already have reported its own work done (in its ` +
        `report, or in this run's handoff file); that does not mean step ${position}'s work is done.`,
    );
  }
  sentences.push(
    `Signal done (call cezar_done, or end your message with a CEZ:DONE line when you have no cezar tools) only once step ${position}'s own goal is achieved, not just the run's overall task.`,
  );
  // hearsay-tools/cezarion#1620: the step completes only on that signal.
  if (position < total) sentences.push(`Cezar starts step ${position + 1} only after that signal; a turn that ends without it keeps step ${position} open.`);
  return sentences.join(' ');
}

/**
 * Structural checks beyond the per-step schema: ids must be unique and every
 * `onFail.retry` must reference an *earlier* step (loops only go backwards).
 * Returns a human-readable problem, or null when the list is sound. Shared by
 * the file loader and the inline-steps / save-workflow API routes (spec 008).
 */
export function stepsIssue(steps: WorkflowStepDef[]): string | null {
  const ids = steps.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return `duplicate step id "${dup}"`;
  for (const [i, s] of steps.entries()) {
    if (!s.onFail) continue;
    const target = ids.indexOf(s.onFail.retry);
    if (target < 0 || target >= i) {
      return `step "${s.id}": onFail.retry must reference an earlier step (got "${s.onFail.retry}")`;
    }
  }
  return null;
}

/** Tools an agent step gets when the workflow doesn't say otherwise. */
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

/** Extra tools unioned onto the default when a step does not set allowedTools. */
export const HARNESS_EXTRA_TOOLS: { readonly [K in RunnerId]: readonly string[] } = {
  claude: [],
  codex: [],
  opencode: [],
  // The trio still marks the default list (hearsay-tools/cezarion#75). pi itself gets no --tools
  // allowlist for it (hearsay-tools/cezarion#1305): the default-tools extension activates these
  // names with the built-ins, so MCP and other extension tools stay callable.
  pi: ['Subagent', 'SubagentSupervisor', 'SubagentWait'],
  cursor: [],
  // R1 (rulings): find and ast_grep are gated behind settings that default off, and a --tools
  // list naming an unavailable built-in exits 2, so they cannot be in the zero-config default.
  omp: ['todo', 'lsp', 'ast_edit', 'task', 'wait'],
};

export function allowedToolsForStep(
  step: { allowedTools?: string[] | undefined } | undefined,
  backend: AgentBackend | undefined,
): string[] {
  if (step?.allowedTools) return [...step.allowedTools];
  const extras = extrasFor(backend);
  return extras.length === 0 ? [...DEFAULT_ALLOWED_TOOLS] : [...DEFAULT_ALLOWED_TOOLS, ...extras];
}

function extrasFor(backend: AgentBackend | undefined): readonly string[] {
  if (backend === undefined || backend === 'claude-cli') return HARNESS_EXTRA_TOOLS.claude;
  return HARNESS_EXTRA_TOOLS[backend];
}

/** One task step applying the selected skill to the user's task. */
export function skillTaskSteps(name: string): WorkflowStepDef[] {
  return [{ id: 'task', name, skill: name, prompt: '{{task}}' }];
}

/** Wrap an inline chain as an ad-hoc workflow. */
export function plannedWorkflow(steps: WorkflowStepDef[]): WorkflowDef {
  return { name: '(planned)', source: 'built-in', steps };
}

/** Validate the mutually exclusive skill/workflow flags before discovery. */
export function skillFlagIssue(flags: { skill?: string | undefined; workflow?: string | undefined }): string | undefined {
  if (flags.skill !== undefined && flags.workflow !== undefined) {
    return '--skill and --workflow cannot be used together';
  }
  if (flags.skill !== undefined && !flags.skill.trim()) return '--skill must name a skill';
  return undefined;
}

/**
 * `--runner` and its permanent alias `--backend` (hearsay-tools/cezarion#632). Both may be given
 * with one value; two different values are a usage error. The caller maps the result onto its
 * own wire field (`runner` on the run API, `backend` on a worker spawn).
 */
export function runnerFlag(flags: { runner?: string | undefined; backend?: string | undefined }): { runner?: string; issue?: string } {
  const { runner, backend } = flags;
  if (runner !== undefined && backend !== undefined && runner !== backend) {
    return { issue: `--runner ${runner} and --backend ${backend} name different runners; pass one --runner` };
  }
  const selected = runner ?? backend;
  return selected === undefined ? {} : { runner: selected };
}

/** The zero-config workflow: one agent step that just does the task. */
export const QUICK_TASK_WORKFLOW: WorkflowDef = {
  name: 'quick-task',
  description: 'One agent run on your task — no ceremony.',
  source: 'built-in',
  steps: [
    {
      id: 'task',
      name: 'Do the task',
      prompt: '{{task}}',
    },
  ],
};
