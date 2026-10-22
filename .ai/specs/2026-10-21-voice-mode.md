# Voice mode: drive the cockpit with sentences, decided by Jev

> Status: design · Date: 2026-10-21 · Research: `.ai/analysis/2026-10-21-voice-mode-jev-research.md`
> Revises: the "never a hands-free voice mode" note in `packages/web/src/components/composer/dictation.ts`
> (v1 stays push-to-talk through the user's own dictation tool; see § Non-goals)
> Revised by hearsay-tools/cezarion#1463: tiered routing, per-word reply extraction and screen context
> (§ Answer the question card, § Tell it, § How it decides, § Testing)

## Why

The owner works at a MacBook in an office and is training themself to dictate instead of type.
They want to drive the cockpit by speaking: jump between task threads, find things, delegate new
work and answer the questions agents ask. Most of their time today goes to tasks that need them,
and most of that goes to answering question cards.

Their setup sets the shape of v1:

- They dictate with **Superwhisper**. It pastes the whole sentence at the cursor when they release
  the push-to-talk key, not word by word. Holding Shift at the end also presses Return
  ([Superwhisper advanced settings](https://superwhisper.com/docs/get-started/settings-advanced)).
- They browse with **Helium**. The cockpit's built-in dictation (Web Speech API) fails there,
  because Helium blocks Google's speech service (`packages/web/src/components/composer/dictation.ts`).

The model is **Jev**, TypeSafe AI's "System One" decision model. It answers typed questions about a
state (pick one, yes/no, score) in about 100–350 ms for about $0.0002 a call. It never writes
text: it can only pick among options that code supplies. The reference the owner pointed to is
John Lindquist's to-do demo ([video](https://www.youtube.com/watch?v=3MwcIgBRras), summarized in
the research § H): dictated text goes into an ordinary input; on each finished sentence the app
sends the sentence and its action list to Jev; code acts on the typed answer.

## What it is

The **⌘K palette understands sentences**. Text arrives by typing or from any dictation tool that
pastes into the palette input. A server-side **decision engine** (Jev in v1) maps the sentence to
one action from a **code-owned action catalog**, with each parameter picked from a list code
supplies. Return commits a sentence: navigation then runs with no further step. Anything that wakes an agent shows a **highlighted proposal**
and waits for confirmation: the user says "yes, confirmed" or presses Return.

## Goals (v1)

1. **Open a task by status and position.** "Open next finished", "open first working", "open next
   needs you", "open the third failed".
2. **Answer the open task's question card**, one or several questions in one sentence: "answer
   *Right, go on* to question first and *the second one* to question second".
3. **Tell it:** "tell it: …" puts the dictated text in the open task's message box.
4. **Confirm, cancel or change** a pending proposal: "yes, confirmed", "no", "change question two
   to …".
5. **Decision log**, so stable routes can later move from Jev into plain code.

## Non-goals (v1)

Agreed with the owner during design:

- A cockpit microphone, and text that appears while the user speaks. Later: an in-browser speech
  model that works in Helium (research § C, option 2).
- Spoken replies, a wake word, always-on listening.
- Several commands in one sentence. The video showed that splitting is fragile.
- Settings changes by voice.
- Finish, Continue, Create PR, merge, delete, stop by voice. These come in later slices through the
  catalog (§ Later slices).
- Tasks in other projects. v1 works in the current project.

## Anti-goals

The feature fails, even if it works technically, if:

- **Voice ever wakes an agent or sends anything without a confirmation.**
- **An answer gets lost.** Answering must always go through: a sentence that matches no choice
  becomes that question's Other answer, never "didn't understand" (owner's rule).
- **Jev sees everything.** The video's main lesson: when Jev got every to-do item as an option, it
  guessed wrong. Code narrows first; Jev picks among a short list.
- **Voice gets its own way to change state.** It calls the same client functions and routes as the
  buttons (`useAskAnswer`, the message and continue seams, the router).
- **The cockpit changes when the feature is off.**

## Constraints

From AGENTS.md (research § F):

- Jev costs money and uses the network, so it is **opt-in behind a `CEZ_*` flag, off by default**.
  The API key stays in the server's environment; the browser never sees it.
- The route is **contract-first**: zod schemas in `packages/contract`, chained into a family
  builder, validated by middleware, under `/api/v1` and its project alias. The route-parity,
  contract-parity, typed-bodies and BC route-inventory tests apply.
- A new `CEZ_*` variable updates `.env.example` (and the README env table) in the same commit.
- `CEZ_DRY_RUN=1` must keep working with no key and no network.
- No new browser WebSocket: plain HTTP requests are enough here.

## User experience

### Input

1. ⌘K opens the palette with the cursor in its input (unchanged).
2. The user types, or dictates with their tool, which pastes the sentence.
3. The palette's normal results stay instant. When the text reads like a sentence, the palette asks
   the engine and, if the answer is a command, shows a **Will do** row at the top: one line saying
   what will happen ("Open *Fix flaky e2e shard* — next finished"). This is a preview only:
   **nothing runs because text arrived.**
4. **Return commits the sentence** and runs the Will do row: navigation runs, and every other
   action becomes a proposal (§ Confirmation). The user presses Return, or Superwhisper presses it
   when the user holds Shift at the end. If Return comes before the decision, the palette waits
   for it, bounded, then acts. If the engine says "not a command", Return does what it does today.
5. **The Return that commits a sentence never confirms a proposal**, even when it arrives before
   the decision. So one dictation gesture can create a proposal but never send it.

### Open by status and position

`open` + **position** + **status**. The verb does not matter: "open", "go to", "show me", "switch to"
and "bring up" all mean open (hearsay-tools/cezarion#1463).

- **Position:** first, next, previous, last, or a number ("the third"). "Next" and "previous" are
  relative to the open task inside that status's list; when the open task is not in the list,
  "next" is the first. Code computes the target; Jev only picks the position word.
- **Status:** one entry from a **code-owned status map**. Each entry has a name, a one-line
  description for Jev, and **its own predicate** over `RunSummary`. Predicates may overlap; they
  are not "equals the dot label", because the dot shows exactly one label per run:
  - the sidebar sections: Needs you, Working, Finished (`bucketOf` in
    `packages/web/src/lib/task-groups.ts`), plus Archived (see List below);
  - finer states (`deriveAttention` in `packages/contract/src/attention.ts`): needs review, needs
    permission, failed, running, waiting for CI, monitoring, waiting for capacity, queued,
    scheduled, waiting on workers (every worker-wait label: "waiting on N workers", "waiting on
    worker replies", "waiting on parent reply"), done, cancelled;
  - **unread**, from the sidebar's read state (`isUnread` in `packages/web/src/lib/read-state.ts`).
    The dot's `unseen` bucket is reserved and never emitted, so it is not used.
  - Combined filters ("open next unread failed") are not in v1.
- **List:** the tasks of the **sidebar tab the user is on** (Active or Automations, `sidebarRuns`),
  in the sidebar's order (`groupRuns(…, 'active')`), **including rows the sidebar's row cap hides**
  (`capBuckets`). Owned workers are left out, as in the sidebar. A variant group counts as one row
  and opens what its tile opens. The "open task" that "next" counts from is the sidebar's highlighted
  row (`sidebarActiveRunId`, which maps a worker to its parent). **Archived** is not a sidebar
  section: it walks the Tasks table's archived order over the rows already loaded
  (`ARCHIVED_WINDOW`, 200); older archived tasks are out of reach in v1.
- Opening is navigation: it runs on Return, with no confirmation. An empty list gives one line in
  the palette ("No failed tasks") and no navigation.

### Answer the question card

Applies to the open task's pending question card (`AskCard`, up to four questions, each with a
header, optional choices, multi-select or not, and an Other box). While a card is shown, a reply
to the open task answers it, however it is worded: "answer that …", "tell it that …", "reply …",
"say …", or only the answer words. A request for the agent that answers none of the card's
questions ("tell the agent to ask me one more question", "tell it skip the question") is a message
instead (§ Tell it): the card offers a reply below it. When a sentence holds both answer words and
message words, it answers the card. The engine labels each word of the sentence with the question it
answers, as message, or as routing (§ How it decides). A question can be named by number ("to question
first", "question two") or by header ("for Library"); the naming words never become part of an
answer. On a one-question card no naming is needed. For every question that gets words:

1. If the words mean one of the card's choices, by meaning or by position ("the one built on
   Vite", "the first answer"), that choice is taken.
2. Otherwise the words go into the question's Other box, copied exactly as dictated, without the
   command words around them and without a trailing comma or full stop.

Questions the sentence does not address stay as they are. A multi-select question can take several
choices. A sentence whose answer words for one question are split around another question's words,
with no question named, is **ambiguous**: the palette says "Which question? Name it, for example
“to question two”." A reply on a card of several questions that gives no answer words is also
ambiguous; on a one-question card it is unclear.

The palette then shows the proposal and the card shows it too: chosen chips highlighted, Other text
filled, and a prompt "Send these answers? Say *yes, confirmed* or press Return". Confirming sends
through the card's existing path: one combined message in the `header: answer` format, through
`useAskAnswer` (live message or Continue). "Change question two to …" refills one question. "No" or
Esc drops the voice-filled answers and leaves the card as it was.

**The proposal collects answers across sentences**, so "answer X to question first" and then "Y to
question second" fill one card. The card's Send needs every question answered (`allAnswered` in
`packages/web/src/routes/task-thread/ask-card.tsx`), and voice keeps that rule: while a question has
no answer, a confirmation is refused with one line naming it ("Question 2 (*Engine*) still needs an
answer") and the proposal stays open. Partial answers are never sent.

If the open task has no pending question card, or the card is routed to a parent task, the palette
says so in one line and does nothing.

### Tell it

"Tell it: …" puts the dictated text after the trigger into the open task's message box as a
proposal. Confirming sends it through the composer's existing path. This also covers needs-you
tasks with no question card (a parked turn). With a question card shown, the same sentence answers
the card when its words answer a card question, and stays a message otherwise (§ Answer the
question card). The message is the words the engine labels as
message, copied as dictated.

Every proposal row names its target task: `Answer “<task>”: <header>: <value>; …` and
`Tell “<task>”: <text>`. When the palette does not know the task's title, it falls back to
`Answer <header>: …` and `Tell it: <text>`.

**Screen context.** The palette sends the page it is on (`view`) and the question the open thread
shows (`askRequestId`: its request id, or `null` for none; omitted while the thread history is still
loading). When `askRequestId` is sent and differs from the question the server has for that run, the
decision is `none` with reason `stale-context`, and the palette says "The screen changed. Try
again." A change of page, open task, shown question or shown proposal makes an earlier preview
stale, so Return asks again; it never acts on a decision made for an older screen.

### Confirmation

A pending proposal stays until the user confirms, cancels, replaces it or leaves. Confirmation is
a **separate input made while the proposal is on screen**: a committed sentence the engine judges
to be a confirmation ("yes, confirmed"), or Return in the emptied input after the proposal is
shown. **The confirm field must have focus while the highlighted card is visible**, so a dictation
tool can paste "yes, confirmed" into it. How the palette and the card share the screen during this
step is a builder decision (see § Left to the builder).

### When the engine is not sure

Below a confidence floor, the palette shows the top two or three candidates with numbers; saying or
typing "two" picks one with no new engine call. For answers, low confidence never blocks: it falls
to the Other box (rule 3).

## How it decides

One engine request per sentence, using speculative fan-out (all questions in one request; code reads
only the ones that apply). Code routes the answers in tiers (hearsay-tools/cezarion#1463): first the
scope, then the action within it, then, for a reply, which words go where.

| Question | Kind | Options | Asked |
| --- | --- | --- | --- |
| Is this a command for the cockpit? | yes/no | — | always |
| Which scope? | pick one | global, project, session (the open task), none | always |
| Which project action? | pick one | open, none | always |
| Which status? | pick one | the status map, plus none | always |
| Which position? | pick one | first, next, previous, last, 1…N, none | always |
| Which session action? | pick one | respond; confirm and cancel only while a proposal is shown; none | with an open task |
| For each word `W01`, `W02`, …: which part of the reply? | pick one | routing, then `q1`…`qN` for the card's questions, then `message` | with an open task |
| For each card question with choices: which choice does its answer mean? | pick one (one yes/no per choice for multi-select) | that question's choices, plus other | with an open task and a card |

The routing:

1. Scope `session` with confirm or cancel acts on the shown proposal.
2. Scope `none`, or any scope below the action floor, is not a command (or unclear).
3. Scope `global` is `none` with reason `unsupported` ("Voice cannot do that yet."): no global
   action exists yet.
4. Scope `project` with `open` opens a task by status and position.
5. Scope `session` with `respond` is a reply to the open task: no open task gives `no-open-task`, a
   stale `askRequestId` gives `stale-context`, and otherwise the word labels give the reply.

**Per-word labels.** The engine sees the sentence and the numbered words, and labels each word where
it stands, so in "tell it that that file is fine" the first "that" is a routing word and the second
is content. The label is `routing`, words said to the cockpit rather than the agent, and not
`command`: live Jev read an instruction for the agent ("ask me one more question") as a command and
dropped it. Code forces the words of a question reference ("to question two", "for Library") to
routing, takes each word's top label, and copies each target's words out of the sentence exactly as
said (`copyRange` in `packages/cezar/src/voice/sentence.ts`). A target is kept only when the mean
confidence of its words is at least `EXTRACT_MIN` (`packages/cezar/src/voice/thresholds.ts`). The
mean, not the minimum, because live Jev gives correct edge words low confidence; the value sits just
below the lowest mean of a correct target in the live replay.

Code owns everything else: reading numbers, the catalog's risk classes, which actions the open task
allows (`runActionFlags` in `packages/web/src/routes/task-thread/run-actions.ts`), the target task,
the text copied into Other or the message box, and execution.

**State sent to the engine:** the sentence and its numbered words, the page, the project and the
open task's title and status, the open card's
questions and choices (built on the server from the run's durable history through `pendingHumanAsk`
in `packages/contract/src/ask.ts`), the status map with descriptions, and the last three voice
actions with their outcomes (Jev has no memory between calls).

## Architecture

- **Routes** (each with its boot alias):
  - `POST /api/v1/p/:projectId/voice/decide`. Request: the sentence plus a small context (current
    view, open run id, a pending proposal if any). Response: a discriminated union on `action`
    (`open` with status and position; `answer` with one entry per addressed question, each either a
    choice label or Other text; `tell` with text; `confirm`; `cancel`; `none`), plus confidence
    and a `decisionId`. A numbered pick never reaches the route: the browser reads a bare number
    ("two", "2") itself while numbered candidates are shown.
  - `POST /api/v1/p/:projectId/voice/outcome` `{ decisionId, outcome }`, where `outcome` is
    `executed` (navigation ran), `confirmed`, `cancelled`, `replaced` (a new sentence replaced the
    proposal) or `abandoned` (the palette closed, or the user navigated away, with a proposal or a
    preview not acted on). The browser sends it when the outcome happens; it is best-effort and
    never blocks the action.
  - The server keeps the last three decisions and outcomes per project (from the decision log) for
    the engine's state; the browser does not send that history.
- **Decision engine seam (server):** one interface, `decide(state, questions) → typed answers`, with
  Jev as the first implementation. The model version is pinned (as `jev-1.13.0` is in
  `.github/scripts/jev-issue-intake.cjs`), because thresholds are tuned against one version. Other
  engines can be added behind the seam later.
- **Action catalog (shared):** a code-owned list of actions, each with an id, a description for the
  engine, a risk class (navigate, wakes an agent, reaches GitHub, destructive) and its parameter
  questions. v1 holds the actions above. Later slices add entries; the risk class decides
  confirmation.
- **Execution (browser):** navigation through the project router; answers fill the `AskCard` state
  and send through `useAskAnswer`; tell-it fills the composer and sends through its existing path.
- **Decision log:** each decision appends one line to a local NDJSON file under `.ai/cezar/`
  (sentence, state summary, engine answers, chosen action, latency), and each outcome appends one
  line keyed by `decisionId`. It is written only while the feature is on, kept out of git through
  `ensureDataGitignore`, and safe to delete. It is the evidence for moving stable routes into plain
  code, and for a replay set like `.github/scripts/jev-intake-replay.cjs`.
- **Flag and capability:** a `CEZ_VOICE=1`-style flag plus `TYPESAFE_API_KEY`. `health`
  capabilities gain a `voice` boolean (like `automations` and `preview`):
  `voice = flag on AND (key set OR CEZ_DRY_RUN=1)`. When it is false, both routes answer 409 and
  the palette is unchanged.
- **Dry run:** under `CEZ_DRY_RUN=1` the engine is always a deterministic fake, even when a key is
  set, so dry runs never reach the network. The fake understands a fixed phrase set: "open
  <position> <status>", "answer <choice text | the Nth answer | other words> to question <N>",
  "tell it: <text>", "yes, confirmed", and "no" / "cancel". That covers the browser E2E cases.
- **Remote mode:** works unchanged; it is plain HTTP and needs no microphone.

## Transitions out

Voice adds no run state. It adds one cockpit-side state, the pending proposal, which holds no server
resource and no `maxParallel` slot.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| preview | the text changes | the user types or pastes | the open request is aborted; a new one starts; nothing runs |
| preview | Return | the user, or the dictation tool's Shift finish | the sentence is committed: the next state is deciding, or the result runs at once when the decision is already there |
| preview | Esc or the palette closes | the user | preview ends; `abandoned` is reported |
| deciding | the committed sentence's answer arrives | the `voice/decide` response | navigation runs (`executed`); other actions become a proposal; "none" falls back to today's Return |
| deciding | engine error or timeout | a bounded client timeout | one error line; the palette works as today |
| proposal | "yes, confirmed" or Return in the emptied input, with every question answered | the user, after the proposal is shown | sent through the existing path; proposal ends (`confirmed`) |
| proposal | a confirmation while a question has no answer | the user | refused with one line naming the question; proposal stays |
| proposal | "no", "cancel" or Esc | the user | voice-filled values are removed; proposal ends (`cancelled`) |
| proposal | a new answer or change sentence | the user | proposal is updated or replaced (`replaced` when replaced) |
| proposal | the user navigates away or closes the palette | the user | proposal ends; the card returns to its prior state (`abandoned`) |
| proposal | the question is answered elsewhere or the run moves on | the live run stream (SSE) | proposal ends with one line saying why (`abandoned`) |

Feature off (the default): no state is reachable. The proposal state's only exits are user actions
and live run updates, by design: it waits for the user and holds nothing.

## Testing

- Contract and route: schema tests, route parity, contract parity, typed bodies, BC inventory.
- Unit, with the fake engine: the status map and position resolver against sidebar order; the
  answer filler (choice text, position, Other fallback, multi-select, unaddressed questions); the
  proposal transitions in the table above, including the SSE exit.
- Browser E2E under `CEZ_DRY_RUN=1`: open by status, answer a two-question card and confirm, cancel,
  tell-it. Grep `packages/web/e2e/*.e2e.ts` for the palette's and ask card's `data-slot` values and
  visible copy before changing them.
- Replay: `packages/cezar/src/voice/replay-set.testkit.ts` holds sentences with their screen and
  the expected decision: both reported phrasings, an option by meaning, free text, "that" as
  content, named, unnamed and header-named replies, multi-select, a plain message, command words
  only, a global command, no open task, and stale or missing card context. `replay-set.test.ts`
  runs them in the unit suite against scripted engine answers. `packages/cezar/scripts/voice-replay.ts`
  runs them against live Jev on demand (`TYPESAFE_API_KEY` in the environment, not in CI) and prints
  each target's min and mean word confidence, to set and re-check thresholds and criteria wording.

## Later slices

- The catalog grows toward the research inventory (§ E.2): Finish, Continue, Create PR, resolve
  conflicts on a PR number, new task with dictated text, automations, each with its risk class.
- "The task about X" and "the dark-mode issue": palette search narrows, Jev picks.
- Tasks in other projects.
- Routes the decision log shows as stable move into plain code, ahead of the engine.
- A cockpit microphone with an in-browser model, live text and early decisions.
- Other engines behind the seam.

## Decided by the owner

- Voice mode is the ⌘K palette understanding sentences; v1 takes text, tested by typing first.
- Superwhisper's paste-at-the-end is the speech path; a cockpit microphone comes later.
- First slice: open by status and position; answer the question card; tell it.
- Answers: matching choice text, then position, then Other — always goes through.
- Nothing that wakes an agent goes without confirmation: highlight, then "yes, confirmed" (or
  Return).
- A pluggable decision engine; Jev decides everything at first; stable routes move to code later.
- Not in v1: spoken replies, wake word, several commands per sentence, settings by voice.

## My calls (owner to check)

- The decision log, its location and its contents (dictated text is stored locally).
- Flag name `CEZ_VOICE` and a `voice` capability; both routes answer 409 when off.
- Return before the decision waits for it (bounded); "not a command" falls back to today's Return.
- The Return that commits a sentence never confirms; confirming is always a second input.
- Answers collect across sentences; a confirmation with an unanswered question is refused, as the
  card's Send is today. Partial answers are never sent.
- "Next" walks the sidebar tab the user is on, past the row cap; Archived walks only the loaded
  200; "unread" replaces the dot's unused "unseen"; no combined filters.
- A second route reports outcomes; the server keeps the recent-actions history.
- Dry run always uses the fake engine and turns the capability on without a key.
- "No" and Esc drop voice-filled answers instead of keeping them unsent.
- Numbered candidates below a confidence floor (for open; never for answers).
- English only in v1 (Jev's primary language).
- Current project only.

## Left to the builder

- How the palette and the highlighted card share the screen during confirmation, within the rule
  that the confirm field has focus while the card is visible.
- When the palette counts text as a sentence, and the debounce before asking the engine.
- How the sentence is cut into per-question parts and where the tell-it text starts, as long as it
  survives dictation slips (a stray leading "and" broke the video demo).
- Plain `fetch` or `@typesafe-ai/sdk` for the Jev client.
- Thresholds, set from the replay set.
- Exact copy for the Will do row, prompts and error lines.
