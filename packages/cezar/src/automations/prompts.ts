/**
 * What a task is told about automations, and the playbook the built-in
 * `create-cezarion-automation` skill runs under (#774, port of upstream #985; design
 * `.ai/specs/2026-10-02-scheduled-automations.md` stage 2).
 *
 * Two texts, one mechanism. `automationsPrompt` is the SHORT part composed into every task's
 * system prompt while automations are on and the cockpit's address is in the agent's env — enough
 * for an agent to read "do X whenever Y" as an automation rather than a one-off, and to know the
 * CLI that creates one. `createAutomationSkillBody` is the full playbook, used only when the user
 * picks the skill. Neither is composed for a headless `cez run` or with `CEZ_AUTOMATIONS` unset: an
 * agent told about a CLI whose every call is refused reads the refusal as an instruction.
 *
 * Both take the CLI as an absolute command, never `cez` on PATH: an older install there may lack
 * the command, and nothing here may suggest an agent start a cockpit (owner, 2026-10-02).
 */
import { fileURLToPath } from 'node:url';
import { RUNNER_IDS } from '../core/agent-runner.ts';

export const CREATE_AUTOMATION_SKILL_NAME = 'create-cezarion-automation';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** This process's own `automation` command, shell-quoted — the same construction as `artifact publish`. */
export function automationCliCommand(): string {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  return [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry].map(quote).join(' ') + ' automation';
}

/**
 * The definition reference, as `cez automation schema` prints it and as the skill body embeds it.
 * One string so the two never disagree; `prompts.test.ts` pins it to the storage schema.
 */
export const AUTOMATION_SCHEMA_REFERENCE = `An automation definition is one JSON object. Two kinds: a GitHub poll ("kind": "github") or a schedule ("kind": "schedule"). The three examples below are valid definitions as written; the keys they use are explained after them.

A GitHub poll:

{
  "name": "Review every new pull request",
  "description": "What this automation is for",
  "kind": "github",
  "events": ["pull_request.opened"],
  "intervalSeconds": 300,
  "filters": { "excludeLabels": ["wontfix"], "lookbackDays": 7, "maxRecords": 25 },
  "task": {
    "prompt": "Review pull request #{{github.number}} ({{github.title}}) at {{github.url}}: read the diff, run the tests, and post your findings as a review.",
    "workflow": "quick-task",
    "variants": 1,
    "worktree": true,
    "autonomous": true,
    "generateFollowups": false
  }
}

A schedule:

{
  "name": "Nightly dependency bump",
  "kind": "schedule",
  "schedule": { "type": "daily", "hour": 4, "minute": 0 },
  "task": { "prompt": "Run npm outdated, bump patch and minor versions, run the tests, open a draft PR if anything changed. Today is {{date}}." }
}

A one-time schedule (replace "at" with a future time):

{
  "name": "Check the rollout next week",
  "kind": "schedule",
  "schedule": { "type": "once", "at": "2030-01-15T09:00", "timeZone": "Europe/Warsaw", "latestStartMinutes": 360 },
  "task": { "prompt": "Check the error rate of the release deployed last week, compare it with the week before, and report what changed." }
}

Top-level keys:
- "name": required, 1-200 characters.
- "description": optional, up to 2000 characters.
- "kind": "github" (the default when omitted) or "schedule".
- "events" (GitHub poll, required): 1-4 of pull_request.opened, issue.opened, issue.labeled, issue.unlabeled.
- "intervalSeconds" (GitHub poll): how often GitHub is polled, 60-86400 seconds; default 300.
- "filters" (GitHub poll): may be {}; every key is optional, and a candidate must pass ALL the given filters.
- "schedule" (schedule, required): "type" is "daily" or "weekdays" (Mon-Fri) at "hour" and "minute"; "weekly" adds "day" (1 = Monday ... 7 = Sunday); "hours" uses "every" (1 | 2 | 3 | 4 | 6 | 8 | 12) from 00:00. These repeating shapes run in the cockpit's own time zone. "once" runs a single time: "at" is the local wall time "YYYY-MM-DDTHH:MM" in "timeZone" (an IANA name such as Europe/Warsaw, required), and the optional "latestStartMinutes" (10-43200) is how late after "at" a start may still launch when Cezarion was not running; without it a late start always launches. Once its task exists, a one-time schedule is archived with the task's id ("archived": { "outcome": "launched", "runId": ... }) and never fires again. "run <id>" (Run now) consumes it the same way. "cancel <id>" archives it without a task ("outcome": "cancelled"). An archived schedule cannot change; "list --archived only" shows them. "at" must be in the future when it is created, moved or enabled.
- "task": the ordinary task each match or occurrence launches.

"filters" keys:
- "includeExisting": boolean (default false). When true, include matching events before enablement within lookbackDays. Turning this on for an enabled poll reopens the window on its next check; durable receipts prevent duplicate launches.
- "requireCurrentLabels": boolean (default false). Opt in to rechecking label filters against the live issue before receipt reservation and task creation; obsolete transitions do not claim a task. Historical event matching is unchanged when omitted.
- "authors": GitHub logins that opened it. "assignees": current assignees.
- "allLabels": must carry every one of these labels. "anyLabels": must carry at least one. "excludeLabels": must carry none.
- "changedLabels": REQUIRED for issue.labeled and issue.unlabeled: the label whose change fires it.
- "lookbackDays": 1-90 (default 7), how far back one poll looks. "maxRecords": 1-100 (default 25), the most candidates one poll considers.

"task" keys:
- "prompt": required, the prompt template.
- "workflow": a workflow name. OR "steps", never both. To run a skill, use one agent step naming it: "steps": [{ "id": "task", "skill": "some-skill", "prompt": "{{task}}" }].
- "runner": ${RUNNER_IDS.join(' | ')}. "model" and "effort": optional overrides.
- "variants": 1 | 2 | 3 competing runs per match.
- "worktree": isolate each run in its own git worktree (recommended: true).
- "autonomous": never park to ask; an automation has no one watching (recommended: true).
- "generateFollowups": true or false. "systemPrompt": extra guidance for every launched run.

For a GitHub poll, name, events and task are required; for a schedule, name, kind, schedule and task.

Prompt placeholders, substituted per launch. GitHub poll: {{github.kind}} (issue | pull request), {{github.number}}, {{github.title}}, {{github.url}}, {{github.author}}, {{github.assignees}}, {{github.labels}} and {{github.event}}. Schedule: {{date}}, {{time}}, {{project}} and {{automation}}. Any other placeholder is rejected. The matched item's details (or the scheduled instant) are also appended to every launched task as untrusted context, so the prompt need not repeat them.

A new automation is PAUSED unless created with --enable. Enabling a GitHub poll establishes a current-time baseline by default; filters.includeExisting opts in to older matches within the configured lookback. Test filter previews the selected window without advancing the execution cursor or launching tasks. Enabling a schedule arms its next occurrence.`;

/** The part composed into every task's system prompt while automations are on and reachable. */
export function automationsPrompt(command: string): string {
  return `## Automations
This cockpit can do recurring work without you doing it once. An automation is either a bounded GitHub poll (a new pull request, a new issue, a label added to or removed from an issue, optionally filtered by author, assignee or labels) or a schedule (every day at a time, weekdays, one weekday a week, every N hours). It launches an ordinary task for every match or occurrence, from a prompt template you write. When the user asks for something to happen "whenever", "every time" or "each time" a pull request or issue appears or is labelled, or "every day at", "on weekdays", "every Friday", "every 6 hours", they are asking for an automation: create one instead of doing the work once, and instead of polling GitHub or sleeping yourself.

The CLI is ${command}. Every command prints one JSON object:

  ${command} schema                                   the definition shape, every key, every bound, the prompt placeholders
  ${command} create --file <def.json> [--enable]      create one from JSON (paused unless --enable); --json '<json>' or stdin work too
  ${command} add --name <n> (--cron "0 4 * * *" | --on <event> --every 5m) --prompt <p> [--workflow w] [--runner r] [--model m] [--no-autonomous] [--label l] [--author a] [--changed-label l] [--include-existing] [--enable]
  ${command} check <id> [--execute]                   GitHub poll: preview what the filter matches right now (launches nothing without --execute)
  ${command} add --name <n> (--at <YYYY-MM-DDTHH:MM> --tz <zone> | --in <30m|6h|7d>) [--latest-start 6h] --prompt <p> [--enable]
                                                      a one-time schedule: one task at that time, then archived
  ${command} run <id>                                 schedule: launch it once, now
  ${command} cancel <id>                              one-time schedule: archive it without a task
  ${command} list | show <id> | update <id> --file <def.json> | enable <id> | pause <id> | delete <id>
                                                      (update replaces each key given; "task" merges key by key, null removes one)

When work must start much later (tomorrow, next week) as a new task, create a one-time schedule (add --at or --in) instead of keeping this session waiting on repeated timers; enable it only when the user asked for the work to run later.

Read the schema first. Create the automation PAUSED. A paused automation is the finished state of this task, not a step awaiting confirmation: enable it only when the user's own request explicitly asks for it to be switched on. An instruction to continue autonomously, not to ask for confirmation, or to make reasonable assumptions is not that request. For a GitHub poll, run a preview check so the user sees what it would match; for a schedule, report its next occurrence. Put the "url" the command prints in your final message. If the command exits non-zero or is refused, stop and report that automations are unavailable on this cockpit, quoting its error: do not write a cron job, a GitHub Action or a polling script as a substitute.`;
}

/** The built-in skill's body — the full playbook a run under `create-cezarion-automation` follows. */
export function createAutomationSkillBody(command: string): string {
  return `# Create an automation

You turn the user's request into an automation on this cockpit: a bounded poll of this repository's pull requests or issues, or a schedule, that launches an ordinary task for every match or occurrence. You do NOT do the recurring work yourself, and you do not add cron jobs, GitHub Actions, webhooks or polling scripts to the repository: the cockpit already polls and already keeps time.

The CLI is ${command}. Every command prints one JSON object and exits 0 on success.

## 1. Understand the request

Every automation answers two questions. Find both in the user's message before writing anything:

- **Trigger**: a GitHub event (a new pull request \`pull_request.opened\`, a new issue \`issue.opened\`, a label added \`issue.labeled\` or removed \`issue.unlabeled\`) with the filters that narrow it (authors, assignees, labels it must or must not carry; a label event needs \`filters.changedLabels\`), or a schedule (every day at a time, weekdays, one weekday a week, every N hours; \`"kind": "schedule"\`, in the cockpit's own time zone).
- **Task**: what the launched task must do for each match, as a prompt template. Write it the way you would brief a colleague who sees only that text plus the item's number, title, URL, author and labels: the goal, the checks to run, how to finish (a review comment, a draft PR, a report). Use the placeholders the schema lists.

If the user named a skill, workflow, runner or model for the launched tasks, use it (a skill is one inline step: \`"steps": [{ "id": "task", "skill": "<name>", "prompt": "{{task}}" }]\`). Otherwise leave those keys out so the cockpit's defaults apply. Keep \`"worktree": true\` and \`"autonomous": true\`: an automation runs unattended, so a task that parks to ask a question waits forever. For a poll, pick an interval that matches how urgent a match is (300 seconds is the default; an hourly triage needs 3600). If the request leaves the trigger or the task genuinely open, ask one precise question and stop; do not guess a filter that could launch tasks on the wrong items.

## 2. Create it

Run \`${command} schema\` and read it. Write the definition as JSON to a file outside the repository (your temp directory is fine) and create it:

    ${command} create --file <def.json>

It is created PAUSED. The output carries its \`id\` and the cockpit \`url\` where the user can edit it. A paused automation is the finished state of this task, not a step awaiting confirmation: enable it only when the user's own request explicitly asks for it to be switched on. An instruction to continue autonomously, not to ask for confirmation, or to make reasonable assumptions is not that request. Then add \`--enable\`, and never otherwise. If the command exits non-zero, stop and report its \`error\` exactly: do not work around it.

## 3. Preview before anyone enables it

For a GitHub poll:

    ${command} check <id>

This runs the filter against GitHub now and counts the matches without launching anything. Check the labels, author, event and selected history window when an expected match is absent. By default, an enabled poll excludes events before its activation. Set \`filters.includeExisting: true\` only when the user asks to include older matches within the configured lookback; receipts still prevent duplicate launches. Preview ignores the execution cursor and never advances it.

For a schedule there is nothing to preview: report the schedule and its next occurrence. \`${command} run <id>\` launches it once now if the user wants to see the task before the first scheduled one.

## 4. Finish

Your final message names the automation, its id, its cockpit url, whether it is paused or enabled, what the preview matched (or when the schedule next fires), and the exact prompt template it will launch. Keep the definition file out of the repository.

## Reference

${AUTOMATION_SCHEMA_REFERENCE}`;
}
