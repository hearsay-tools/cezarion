import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import type { ContentBlock } from '../../core/agent-runner.ts';
import { enqueueAgentInput } from '../../delegation/input.ts';
import type { Skill } from '../../skills.ts';
import { materializeSkillToCache, TEAM_SKILL_AGENT_DIRS } from '../../skills-remote.ts';
import { MAX_SKILL_CLOSURE, namesSkillCommand, provisionSkills } from '../../skills-provision.ts';
import { atStepOpen, atTaskHead, atContinue, atLiveInput } from './launch-read-resolver.ts';
import type { ActiveRun } from '../active-run.ts';
import { leadingSlashSkillName } from './prompts.ts';
import type { RunModuleContext } from './types.ts';

/** A live team record view. Shared catalog records remain owned by discovery. */
export class SkillTeamView {
  #skill: Skill;
  constructor(skill: Skill) { this.#skill = skill; Object.freeze(this); }
  get repo(): string { return this.#skill.team!.repo; }
  get ref(): string { return this.#skill.team!.ref; }
  get path(): string { return this.#skill.team!.path; }
  get dir(): boolean { return this.#skill.team!.dir; }
  get commit(): string | undefined { return this.#skill.team!.commit; }
}

/** Each getter reads the shared entry, without granting writes to that entry. */
export class SkillView {
  #skill: Skill;
  #team: SkillTeamView;
  constructor(skill: Skill) {
    this.#skill = skill; this.#team = new SkillTeamView(skill);
    Object.freeze(this);
  }
  get name(): string { return this.#skill.name; }
  get description(): string | undefined { return this.#skill.description; }
  get interactive(): true | undefined { return this.#skill.interactive; }
  get body(): string { return this.#skill.body; }
  get path(): string { return this.#skill.path; }
  get source(): Skill['source'] { return this.#skill.source; }
  get team(): SkillTeamView | undefined { return this.#skill.team ? this.#team : undefined; }
}

let skillsWrites: {
  catalog(group: SkillsGroup, catalog: Skill[]): void;
  provisioning(group: SkillsGroup, pending: Promise<void>): void;
};
export class SkillsGroup {
  #catalog: readonly SkillView[] | undefined;
  #liveSkillProvisioning: Promise<void> | undefined;
  constructor() { Object.freeze(this); }
  /** Registry snapshot used to expand `/skill` follow-ups before a backend can
   *  mistake them for its own slash commands (hearsay-tools/cezarion#676). Only `RunSkills.loadRunSkills` writes it,
   *  and only `RunSkills.enabledSkills` reads it. */
  get catalog(): readonly SkillView[] | undefined { return this.#catalog; }
  /** The install a live `/name` started after its message went out (hearsay-tools/cezarion#1408); tests await it. */
  get liveSkillProvisioning(): Promise<void> | undefined { return this.#liveSkillProvisioning; }
  static {
    skillsWrites = {
      catalog(group, catalog) { group.#catalog = Object.freeze(catalog.map((skill) => new SkillView(skill))); },
      provisioning(group, pending) { group.#liveSkillProvisioning = pending; },
    };
  }
}
for (const type of [SkillTeamView, SkillView, SkillsGroup]) {
  Object.freeze(type.prototype);
  Object.freeze(type);
}
export function createSkillsGroup(): SkillsGroup { return new SkillsGroup(); }

export type SkillReadPhase = 'step-open' | 'continue' | 'live-input';
const skillReads = (phase: SkillReadPhase) => phase === 'continue' ? atContinue : phase === 'live-input' ? atLiveInput : atStepOpen;

interface RunSkillsHost {
  builtinSkills(): Skill[];
  workerExecutionStopped(runId: string): boolean;
  isCurrentState(runId: string, state: ActiveRun): boolean;
  flushAgentInputs(runId: string): void;
}

export class RunSkills {
  constructor(private readonly context: RunModuleContext, private readonly host: RunSkillsHost) {}

  /** Every skill lookup in this manager goes through here, so the built-ins reach all of them. */
  discoverSkills(phase: 'task-head' | 'continue' = 'task-head'): Promise<Skill[]> {
    return (phase === 'continue' ? atContinue : atTaskHead).registry(this.context.repoRoot, this.host.builtinSkills(), this.context.home);
  }

  /**
   * Load the run's skill registry: the ONLY writer of `state.skills.catalog` (hearsay-tools/cezarion#1806).
   * `execute` and `runContinuation` both call it, once the run is registered and after the awaits
   * that precede its first prompt. `'throw'` lets a failed discovery fail the run, as a fresh run
   * always did; `'ignore'` keeps the registry the run already has, or none, because discovery must
   * never break a Continue (open-mercato/cezar#811). An empty registry expands no `/skill` (it is not an error).
   */
  async loadRunSkills(state: ActiveRun, onFailure: 'throw' | 'ignore'): Promise<void> {
    // Only a rejected discovery is a failure to ignore; a synchronous throw escaped the old
    // `.catch` too, and still fails the caller.
    const discovery = this.discoverSkills(onFailure === 'ignore' ? 'continue' : 'task-head');
    try {
      skillsWrites.catalog(state.skills, await discovery);
    } catch (error) {
      if (onFailure === 'throw') throw error;
    }
  }
  /**
   * The run's skill registry minus the project's off-list as it is now (hearsay-tools/cezarion#1494): the ONLY reader of
   * `state.skills.catalog`. The registry is discovered when the run starts or continues, so a team skill
   * switched off since then is still in `state.skills.catalog`; every prompt a step, a Continue or a live
   * `/name` builds reads this instead. A caller that already read the off-list passes it as
   * `disabled`, so that both see one list. A team source disabled since then
   * (hearsay-tools/cezarion#279) drops its skills here too.
   */
  enabledSkills(
    state: ActiveRun,
    disabled?: ReturnType<typeof atStepOpen.disabledSkills>,
    phase: SkillReadPhase = 'step-open',
  ): Skill[] {
    const reads = skillReads(phase);
    const off = disabled === undefined ? reads.disabledSkills(reads.projectUiStateSync(this.context.repoRoot)) : disabled;
    return reads.enabledSkills(state, this.context.repoRoot, off);
  }
  /**
   * A live `/name` message already carries the skill's body, and `sendMessage` answers
   * synchronously, so its files and companions install after the message went out (hearsay-tools/cezarion#1408).
   * When anything new landed, or a team skill's files went to a cache copy the message could not
   * name, one durable agent input says what and where. Whether a runner's native lookup sees a skill
   * added mid-session is not relied on: that input is the delivery for every runner. Nothing
   * new: no input. A run that stopped, or moved to another session, gets none.
   */
  provisionLiveSlashSkill(runId: string, state: ActiveRun, blocks: ContentBlock[]): void {
    const first = blocks.find((block) => block.type === 'text');
    const name = first?.type === 'text' ? leadingSlashSkillName(first.text) : undefined;
    if (!name) return;
    const session = state.liveSession.session;
    skillsWrites.provisioning(state.skills, (async () => {
      const { filesDir, installed } = await this.provisionRunSkills(runId, state, { slash: name }, 'live-input');
      const dir = filesDir.get(name);
      if (installed.length === 0 && !dir) return;
      if (state.liveSession.cancelled || !this.host.isCurrentState(runId, state) || state.liveSession.session !== session) return;
      const text = [
        ...(installed.length ? [`Skills installed for /${name}: ${installed.join(', ')}.`] : []),
        ...(dir ? [`Skill files for /${name} are at ${dir}.`] : []),
      ].join(' ');
      // The durable queue delivers it at the runner's next opportunity: several runners refuse
      // agent input while the human message is in flight, and a restart replays it.
      const input: AgentInput = { id: randomUUID(), parentRunId: runId, source: 'lifecycle', text, createdAt: new Date().toISOString() };
      this.context.store.commitAgentInputs(runId, enqueueAgentInput(this.context.store.getRun(runId)!, input));
      this.context.store.appendEvent(runId, { type: 'agent-input', input });
      this.host.flushAgentInputs(runId);
    })().catch(() => undefined));
  }

  /**
   * Provision the step skill and leading registry slash skill for start, Continue, recovery and
   * live input, and at a step's start every registry skill its prompt names as a typed `/name`
   * (hearsay-tools/cezarion#1672). Native slashes that are not registry skills install nothing.
   *
   * The run's OWN task worktree gets every root and the companions their bodies name
   * (`provisionSkills`): links to local and global skills, generated `SKILL.md` files, and marked
   * team copies, in `.claude/skills`, `.agents/skills` and `.cursor/skills`, recorded in the
   * worktree's git dir and kept out of git by a worktree-local `.gitignore`. The project's
   * off-list (`disabledTeamSkills`) is read fresh on every pass and applied to the saved
   * registry, the roots and the team list alike: a team skill switched off for the project is
   * never installed, not even for a skill that runs it, and a switch-off made after the run
   * started holds for the next step, a live `/name` and Continue. Copies a pass installed before
   * the switch stay in the worktree until the task ends: Squawk removes nothing mid-task.
   *
   * Any other cwd — worktree off, a non-git project, a Continue whose worktree is gone — is the
   * main checkout or unknown, where those directories are LOCAL skills to `discoverSkills` that
   * would shadow the team source for every later run. A selected or leading-slash directory team
   * root gets a per-commit cache copy there instead, and nothing else is installed: a skill only
   * the prompt names gets nothing there, like a companion. So does a worktree where no copy of
   * it landed, such as one whose three agent dirs all link out of it; one that took only some
   * copies names the first that landed, since the runner's own dir may be the one skipped.
   * Returns the step-start notes and, per team root, the directory its prompt must name.
   */
  async provisionRunSkills(
    runId: string,
    state: ActiveRun,
    wanted: { stepSkill?: string | undefined; slash?: string | undefined; prompt?: string },
    phase: SkillReadPhase = 'step-open',
  ): Promise<{ notes: string[]; filesDir: Map<string, string>; installed: string[] }> {
    const notes: string[] = [];
    const filesDir = new Map<string, string>();
    const wantedNames = [...new Set([wanted.stepSkill, wanted.slash].filter((name): name is string => Boolean(name)))];
    // Stop can land during an earlier await (Continue's team-cache wait): a stopped run writes
    // nothing, here or between the pass's own steps.
    const stopped = () => Boolean(state.liveSession.cancelled) || this.host.workerExecutionStopped(runId);
    // The off-list as it is now, applied to every input: the saved registry predates a switch
    // made during the run, so it is filtered as well as the fresh team list.
    const reads = skillReads(phase);
    const disabled = reads.disabledSkills(await reads.projectUiState(this.context.repoRoot));
    const registry = this.enabledSkills(state, disabled, phase);
    // A skill the prompt names as `/name` is a root after the selected ones, so a capped closure
    // never leaves it out (hearsay-tools/cezarion#1672). It installs only in the task worktree, like a companion.
    const named = registry.filter((skill) => namesSkillCommand(wanted.prompt ?? '', skill.name)).map((skill) => skill.name);
    const roots = [...new Set([...wantedNames, ...named])]
      .flatMap((name) => registry.filter((skill) => skill.name === name).slice(0, 1));
    if (roots.length === 0 || stopped()) return { notes, filesDir, installed: [] };
    const teamRoots = roots.filter((skill) => wantedNames.includes(skill.name) && skill.source === 'team' && skill.team?.dir);
    const cacheCopy = async (skill: Skill): Promise<void> => {
      const dir = await materializeSkillToCache(skill, this.context.home).catch(() => null);
      if (!dir) return;
      notes.push(`team skill "${skill.name}" materialized to ${dir}`);
      filesDir.set(skill.name, dir);
    };
    if (!this.isOwnTaskWorktree(runId, state.liveSession.cwd)) {
      for (const skill of teamRoots) await cacheCopy(skill);
      return { notes, filesDir, installed: [] };
    }
    const team = reads.teamSkills(this.context.repoRoot, this.context.home);
    const catalog = [...registry, ...reads.filterSkills(team, disabled)];
    const result = await provisionSkills(state.liveSession.cwd, roots, catalog, { cancelled: stopped, home: this.context.home });
    if (stopped()) return { notes, filesDir, installed: [] };
    for (const skill of teamRoots) {
      const written = result.teamCopies[skill.name] ?? [];
      if (written.length === TEAM_SKILL_AGENT_DIRS.length) {
        notes.push(`team skill "${skill.name}" materialized to .claude/skills/${skill.name}/ ` +
          `.agents/skills/${skill.name}/, and .cursor/skills/${skill.name}/`);
      } else if (written.length > 0) {
        notes.push(`team skill "${skill.name}" materialized to ${written.map((dir) => `${relative(state.liveSession.cwd, dir)}/`).join(' and ')}`);
        filesDir.set(skill.name, written[0]!);
      } else {
        await cacheCopy(skill);
      }
    }
    const others = result.installed.filter((name) => !teamRoots.some((skill) => skill.name === name));
    if (others.length > 0 || result.truncated) {
      notes.push(`skills installed in the task's workspace: ${others.join(', ') || 'none new'}` +
        (result.truncated ? `; closure capped at ${MAX_SKILL_CLOSURE}, skipped ${result.truncated} and later` : ''));
    }
    return { notes, filesDir, installed: result.installed };
  }
  /** `cwd` is the run's recorded task worktree, and not the project root. Unresolvable means no. */
  private isOwnTaskWorktree(runId: string, cwd: string): boolean {
    const worktreePath = this.context.store.getRun(runId)?.worktreePath;
    if (!worktreePath) return false;
    const real = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
    const dir = real(cwd);
    return dir !== undefined && dir === real(worktreePath) && dir !== real(this.context.repoRoot);
  }

}
