# Skills

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/skills.ts`, `packages/cezar/src/skills-remote.ts`, `packages/cezar/src/workflows/run.ts`, `packages/cezar/src/workflows/run/run-skills.ts`, `packages/cezar/src/ui-state.ts`

Team caches use the [resolved cache root](../migration.md#home-directories).

## Two project directories before P5

Read project skills from `.ai/cezar/skills/` then `.ai/squawk/skills/`.
Legacy wins duplicate names. Preserve precedence against `.ai/skills/`, agent
mirrors, built-ins and team repositories. Team-source configuration uses whole-file
legacy-first selection. Imports and config edits still write `.ai/cezar/`.
Neither reads nor ignore maintenance create `.ai/squawk/`.

## Rules

A skill is a `.md` file with optional YAML frontmatter (`name`, `description`); its body becomes the agent's extra system prompt. Discovery precedence is local-first: `.ai/cezar/skills` → `.ai/squawk/skills` → `.ai/skills` → `.agents/skills` + agent mirrors → global → team repo. Missing dirs are fine; team-skill loading never blocks on the network (background cache in `<cache>/`). Team sources are the `skillsRepos` entries in the project's `config.json` (`.ai/squawk/`, or `.ai/cezar/` before the project moves). The Skills page edits them through `/skills/sources` (`server/skill-sources.ts`), which writes only that key through `updateConfigFile` and refuses a file `readRawConfig` cannot read. A source with `enabled: false` stays listed and loads nothing; `filterDisabledTeamSources` applies that switch to lists loaded before it, in `discoverSkills`, `enabledSkills` and `provisionRunSkills`. Each source's load state (`getTeamSourceStatuses` in `skills-remote.ts`) names why it has no fresh list. Only the default ref, `main`, falls back to the clone's `HEAD`; any other ref the repo lacks is `ref-not-found`. A skill list has two kinds of reader. Fresh discovery goes through `discoverSkills` (`skills.ts`), which applies the project's team-skill off-list (`disabledTeamSkills` in `ui-state.json`) itself. Its callers are the `GET /skills` and `POST /skills/refresh` routes, the planner (`planner.ts`), a worker's `--skill` lookup (`delegation/service.ts`) and auto-naming (`autoNameRun` in `workflows/run/turn-bookkeeping.ts`). `GET /skills/importable` returns the unfiltered team list on purpose, so the Skills catalog can switch a skill back on. The run's saved list, `state.skills.catalog` in `workflows/run/run-skills.ts`, is discovered when the run starts or continues, so it can predate a change made during the run. `loadRunSkills` is the only writer, and `execute` and `runContinuation` both call it. `enabledSkills` is the only reader, and it applies the off-list as it is at that moment; the ast-grep rules `skills-write-outside-load-run-skills` and `skills-read-outside-enabled-skills` pin both. It feeds live `/name` expansion in `deliverMessage`, a later step's skill lookup and prompt in `runAgentStep`, and the Continue skill lookup and opening prompt in `runContinuation`. `provisionRunSkills` installs the step skill, a leading `/name` and their companions, and reads the registry through it, passing the off-list it read for the team catalog so both see one list. A change to which skills a run may use needs a [reader sweep](../../CODE_REVIEW.md#changing-working-behavior) over every reader listed here, or the spec says why a reader leaves it out (hearsay-tools/cezarion#1494: PR hearsay-tools/cezarion#1541 applied the off-list to provisioning first, and review then found the `state.skills.catalog` readers still sending a switched-off skill). A state file that a synchronous reader reads is written atomically: a temporary file, then a rename, as `writeProjectUiState` (`ui-state.ts`) does. `enabledSkills` reads `ui-state.json` synchronously (`readProjectUiStateSync`), and a write in place lets it see a partial file, which parses as `{}`: an empty off-list.
