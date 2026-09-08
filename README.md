# pi-topping-moa-fusion

A Pi extension built around **Mixture of Agents (MoA)** planning: several models independently explore your repo, each writes a complete implementation plan, and a synthesizer reconciles them into one stronger plan — surfacing every disagreement as a decision you get to make.

<img src="docs/images/mf-plan-workflow-animated.svg" alt="/mf-plan workflow" width="100%">

## Contents

- [Quick Start](#quick-start)
- [Mixture of Agents (MoA)](#mixture-of-agents-moa)
  - [Why prose, not code](#why-prose-not-code)
  - [How a run works](#how-a-run-works)
  - [How the synthesizer works](#how-the-synthesizer-works)
  - [The fan-out overlay](#the-fan-out-overlay)
  - [Opinions (`/mf-opinion`)](#opinions-mf-opinion)
- [Commands](#commands)
  - [Cancelling running subagents](#cancelling-running-subagents)
- [Plan Mode](#plan-mode)
- [Custom Tools](#custom-tools-available-in-plan-mode)
- [Subagents](#subagents)
  - [Choosing their models](#choosing-their-models)
  - [Parallel execution](#parallel-execution)
- [Plan File Location](#plan-file-location)
- [Non-Interactive Behavior](#non-interactive-behavior)
- [How It Works (Architecture)](#how-it-works-architecture)
- [Porting Notes](#porting-notes)

## Quick Start

```bash
pi install npm:@underactive/pi-topping-moa-fusion
```

Press `F2` (or run `/mf-plan`), describe what you want planned, and pick **Mixture of Agents** when the model picker opens. Assign your models in the **MoA Fusion Pre-flight** overview, then choose **Start fan-out**. In the prompt editor, Tab completes file paths and `@name` fuzzy-searches the repo when `fd` is available (pi's bundled copy, or `fd`/`fdfind` on your PATH); completions insert references, not file contents.

## Mixture of Agents (MoA)

MoA is the reason this extension exists, and the mode it defaults to — the picker lists it first, and saving `/mf-plan-settings` sets it as your default. Up to 5 models each independently explore the repo and write their own complete implementation plan, then a synthesizer reconciles them into one.

It stays optional. Single-model planning is one keystroke away and runs the full 5-phase workflow on your active model. But MoA is worth preferring for anything non-trivial:

- **Independent proposals surface options one model won't.** Each proposer explores the repo on its own with no shared context, so they genuinely diverge on approach rather than converging on one model's first instinct.
- **Claims get checked.** The synthesizer has read-only repo access and verifies proposer claims about file paths, functions, and line numbers instead of trusting them — catching the confident-but-wrong details a single planner would carry straight into the plan.
- **Disagreements become your decision.** Where proposers took different approaches, you get an explicit conflict-review tab with the tradeoffs spelled out, instead of a silent choice buried in someone's plan.

The cost is real: an MoA run spends roughly N× the tokens of a single-model plan, takes as long as its slowest proposer, and wants several providers configured to be worth doing. For a one-line fix, use single model.

### Why prose, not code

Fanning out a coding task and merging the resulting token streams does not work — different models produce wildly different code for the same problem, and any aggregator splicing them together introduces its own bias. MoA here never fuses code. Proposers write plans in prose, which is far easier to reconcile than syntax: a disagreement like "model A wants a migration, model B wants an in-place patch" is legible enough to evaluate on the merits. Code is written afterward, from the single merged plan, by one agent.

### How a run works

1. After you submit your plan prompt, a picker opens on a mode screen (**Mixture of Agents** or **Single model**). Single model — or Esc — runs the 5-phase workflow on the current model.
2. MoA opens the **MoA Fusion Pre-flight** overview with all eight slots — five proposer slots plus a synthesizer, an implementer, and a verifier — starting empty at `(none)`, plus a **Load Roster** row above **Start fan-out** that applies a saved agent roster to every slot at once (see [Agent rosters](#agent-rosters)). Selecting any slot row opens a two-pane model/thinking picker for that one slot and returns to the overview; cancelling leaves the slot unchanged. **Start fan-out** stays disabled until you assign at least two proposer slots and all three required roles (the minimum roster; the same model may fill several slots, and the extra proposer slots are optional). Thinking levels come from the model's pi registry metadata, which is authoritative for every model the registry lists; the generic `off`/`low`/`medium`/`high` list applies only to models it doesn't. Your saved choices and active model only pre-highlight a slot's picker — they never count as assignments until you confirm them — and confirmed selections are remembered in `~/.pi/agent/mf-plan/settings.json`.
3. Proposers run in parallel as isolated `moa-proposer` subprocesses. Each ends with an "Open Questions / Assumptions" section rather than pausing — proposers never block waiting on input.
4. `moa-synthesizer` reads every successful proposal (at least 1 must succeed) plus the original request, and writes one merged plan.
5. If the proposers substantively disagreed, a conflict-review overlay opens first: one tab per conflict, plain-language options, the synthesized pick tagged **(Recommended)**, and a **Chat about this** box for free-text feedback. Your resolutions are fed back for re-synthesis. Esc cancels the whole run.
6. The plan opens in the same review overlay `exit_plan_mode` uses, where you can inspect any proposer's original plan, edit the synthesized one, or send the synthesizer feedback for a revised version (up to five rounds).
7. On approval, the synthesizer makes one read-only pass to create a frozen observable checklist at `.pi/mf-plan/<slug>__criteria.md`, then plan mode exits and implementation begins in the current session using the implementer you already picked — there is **no** second picker (the single-model flow picks its implementing model up front when you choose **Single model**, and neither flow shows a model picker after approval — one appears only via `/mf-plan-implement`, or when an MoA run is resumed without a saved roster). If implementation fails (for example, auth expiration or provider error), an automatic recovery dialog prompts to retry, switch to a different model, or continue manually. You can also run `/mf-plan-implement` anytime to resume the approved plan.
8. Once the implementation turn settles, the **verification phase** runs when a verifier is configured: the project's own `check` / `lint` / `test` scripts run first, then a read-only `moa-verifier` subprocess judges the working tree against the frozen approved plan and scores every frozen criterion pass/fail/cannot-verify. The overall verdict is derived from those scores. If criteria are unavailable, it falls back to judging plan steps directly. If it finds gaps (or a check fails), the repair prompt shows a short Simplified Technical English summary, then the verifier summary, unmet criteria or gaps, and failing project checks, followed in the TUI by three choices in order: *View full findings*, *Send verifier findings to the implementer* (a bounded **repair round**, up to two), and *Accept implementation as-is*. *View full findings* opens the complete verifier report in a read-only, scrollable popup and, when closed, returns to the same three choices, so viewing never consumes a repair round. A repair round sends the findings back to the implementer and re-verifies. The raw verdict is saved next to the plan as `<slug>__verification.md`. A user-cancelled implementation is never verified.

Before building the full verification task, MoA Fusion runs a cheap verifier preflight that asks for a one-word response. Auth, quota, model, and liveness problems therefore surface quickly with an actionable child error instead of after the full audit attempt.

**Verification troubleshooting.** If criteria generation fails, implementation continues and verification falls back to plan-step mode. If verification cannot complete, the dialog shows the underlying child error (including provider or spawn details), and failed output is saved at `.pi/mf-plan/<slug>__verification.md`.

### How the synthesizer works

The synthesizer's contract (`agents/moa-synthesizer.md`) is to produce a new plan — selecting one proposal, or lightly editing a favorite, is defined as failure.

Several safeguards target known LLM judging biases:

- **Identity blinding** — proposals arrive headed `### Proposal from Proposer N`; real model names never appear in its input. This counters *self-preference bias*, where a model favors output it recognizes as its own. Enforcement runs both ways: proposers must not hint at their own model name, family, or provider, and the synthesizer must not infer or emit one — including in its own output, which keeps re-synthesis rounds blind too.
- **Separate evaluation dimensions** — proposals are judged on correctness, completeness, feasibility, risk, and simplicity as distinct dimensions rather than one overall impression. The prompt states outright that confidence, detail, and length are not evidence of quality, guarding against *verbosity bias*.
- **Agreement is signal, not proof** — where proposers agree, the synthesizer still sanity-checks the shared assumption against the repo, since independent models can share the same error.
- **Auditable reasoning** — the plan opens with a Context section recording dimension reasoning, proposer alignment, and synthesis decisions, so recombination choices are inspectable. Reconciliation commentary is confined there; the rest reads as one coherent plan. The orchestrator verifies all three subsections are present and rejects a first plan that omits them (one corrective retry, then a warning), the same way it enforces `## Proposer Verdicts`.
- **Disagreements go to the user** — every substantive disagreement must be emitted as a `## Conflicts` block, even when the synthesizer is confident, so its judgment is a default you can override rather than a decision made for you. Genuine ambiguity about *your intent* instead produces a single `## Open Question`, and the synthesizer is re-run with your answer.

**Protocol-internal, always current at runtime.** The proposer, synthesizer, and verifier prompts are tightly coupled to this extension's parsers and UI (e.g. the `## Conflicts` markup, and the verifier's `**Verdict:**`/`### Gaps` markup). A hand-edited copy under `~/.pi/agent/agents/` is still written for inspection, but MoA runs always use the bundled definition from the installed extension, so a protocol update can never desync from what the subprocess runs. `moa-explore` and `mf-plan` remain fully user-customizable.

### Implementation failures

If the picked implementing model fails immediately upon kickoff (such as an expired session, auth failure, or provider outage), an automatic recovery prompt appears offering:
- **Retry with <model>** — retry kickoff with the same model.
- **Choose a different model** — pick a replacement model from the registry.
- **Continue manually** — keeps the plan safely saved on disk.

The approved plan is persisted across session restarts. You can run `/mf-plan-implement` at any time to re-send the approved plan and optionally pick a new implementing model.

### The MoA Fusion table

When an MoA run starts, a `MoA Fusion` table pins itself above the editor and stays there for the whole run — proposer fan-out, synthesis, the in-session implementation turn, and verification. The plan's summarized name sits at the right of the title bar.

Under the title, a phase band traces the pipeline — `Plan › Synthesize › Implement › Verify` — with each phase's model beneath its name. The active phase shimmers. (The band's chevrons are Powerline glyphs; without a Nerd Font they render as boxes.)

Rows are grouped under `── Plan`, `── Synthesize`, `── Implement`, and `── Verify` headings, one row per model. Roles that have not started yet show as dim queued rows, so the table's shape is visible from the first second. Each row carries:

- **MODEL** — the provider/model reference.
- **CTX** — how much of that model's context window its latest turn is using.
- **MONITOR** — an activity meter of *generated output* rate, independent of CTX: an agent can be deep into its context window and idle, or near empty and generating hard. Uses provider-reported token counts when available, otherwise word counts of the streamed deltas. Each row's meter is tinted with the thinking level that row is running under, using that level's native theme colour (`off` through `max`), so you can read a row's effort at a glance; the hue is tracked per row, so the same model can show different colours in different slots and it follows retries, model swaps, verifier fallback, and resumed runs. A row whose level is unknown falls back to the neutral accent colour, and idle cells and settled traces keep their usual dimming under whichever hue applies.
- **ACTIVITY** — what the agent is doing, with its current tool call beneath, its tool name and argument highlighted with pi's own bold `toolTitle`/`accent` theme colours.
- **TURNS** / **TOOLS** / **COST** / **TIME** — assistant turns completed, tool calls started, registry-rate model cost, and elapsed time. All freeze when the agent settles.

While an agent is working, its row also shows a dim, guttered preview of the latest four wrapped lines from the same transcript used by Observe. The preview follows the newest output automatically; short terminals reduce or drop preview lines after preserving tool activity, and narrow terminals omit previews entirely.

Proposer and synthesizer rows are fed by the subagent processes. The Implement row is the model running in your own session: its turns, tool calls, output meter, and cost are collected live from pi's lifecycle events while the approved plan is being implemented. The Verify row is fed by the verifier subprocess; when you send verifier findings back to the implementer, the Implement row reactivates in the same table. The table closes when verification finishes, when an implementation is cancelled or paused with "Continue manually", or when the session shuts down.

Press `F3` during a run to open a read-only observer of any agent's streamed output.

### Opinions (`/mf-opinion`)

`/mf-opinion` asks up to five models the same repository question without entering plan mode or starting an implementation workflow:

1. Enter a question directly (`/mf-opinion is this retry safe?`) or use the prompt editor. Tab completes file paths and `@name` fuzzy-searches the repo when `fd` is available (pi's bundled copy, or `fd`/`fdfind` on your PATH); completions insert references, not file contents.
2. Assign 1–5 slots in **Select Opinion Models**. Duplicate model choices are allowed.
3. Independent `moa-opinion` subprocesses inspect the repository in parallel with strict read-only tooling.
4. After the last agent settles, every answer is appended verbatim to the transcript in slot order. Nothing synthesizes, judges, merges, or rewrites the opinions.

During the run, `F3` opens the live observer and `Esc` or `F4` opens cancellation controls. The prompt and combined result are saved under `.pi/mf-opinion/` as `<slug>__opinion-prompt.md` and `<slug>__opinions.md`.

### Debates (`/mf-debate`)

`/mf-debate` runs a multi-round debate between up to five models — no judge, no synthesis, no implementation:

1. Enter a topic directly (`/mf-debate is this retry safe?`) or use the prompt editor. Tab completes file paths and `@name` fuzzy-searches the repo when `fd` is available (pi's bundled copy, or `fd`/`fdfind` on your PATH); completions insert references, not file contents.
2. Assign 2–5 slots in **Select Debating Models** and set the round ceiling (2–5, default 3) with `←`/`→` on the Rounds row. Duplicate model choices are allowed.
3. Round 1: independent `moa-debater` subprocesses each form their own repo-grounded position with strict read-only tooling.
4. Every later round, each surviving debater receives every other debater's prior position under anonymous `Debater N` labels and may rebut, concede, or change stance.
5. The debate stops early when nobody moved in a round (from round 2 on) or fewer than two debaters remain. The full transcript — every round plus final positions — is appended verbatim to the session. Nothing judges or merges.

During the run, `F3` opens the live observer and `Esc` or `F4` opens cancellation controls. The prompt and combined transcript are saved under `.pi/mf-debate/` as `<slug>__debate-prompt.md` and `<slug>__debate.md`.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `/mf-plan` | `F2` | Toggle plan mode on/off |
| `/mf-opinion` | `F6` | Ask 1–5 models for independent read-only opinions about the repository |
| `/mf-debate` | `F7` | Run a read-only multi-round debate between up to 5 models |
| `/mf-plan-settings` | — | Configure the explore and cheap/fast agents, named agent rosters for the MoA roles, and plan options |
| `/mf-plan-implement` | — | Retry implementation of the last approved MoA plan, optionally with a different model |
| `/mf-plan-clear` | `F5` | Clear completed plan state so the next `/mf-plan` starts a fresh round; approved plans stay in `.pi/mf-plan/` and remain re-implementable |
| `--mf-plan` | — | Start pi with plan mode enabled |
| — | `F3` (during MoA runs) | Open a read-only observer of streamed proposer/synthesizer output |
| — | `Esc` (during MoA runs) / `F4` | Open the cancel overlay: kill one stuck subagent or cancel all |

On Mac laptops the top row sends brightness/media keys by default, so press `Fn+F2`
or enable *Keyboard → "Use F1, F2, etc. as standard function keys"* in System Settings.
Rebind any of these via `keybindings.json` if they clash with your terminal.

### Cancelling running subagents

During an MoA fan-out or synthesis, **Esc** opens a cancel overlay. Enter kills the selected agent — its siblings keep going and synthesis proceeds with the surviving proposals; **Cancel ALL** aborts the run and reopens the prompt editor prefilled with your original prompt. Each agent's live tool call is highlighted the same way as the Fusion table's ACTIVITY column.

During the single-model workflow's `mf_plan_subagent` runs, plain Esc keeps pi's default abort-the-turn behavior; use **F4** to kill an individual agent instead. A cancelled agent reports "cancelled by user" back to the model, which continues with the other agents' results.

> While an MoA run is active this extension consumes Esc via a terminal-input listener, which may shadow another extension's Esc handling for the duration of the run.

## Plan Mode

Both modes share the same plan-mode container. While it is active:

1. **Read-only enforcement** — plan mode uses an explicit allowlist rather than disabling known mutators. Only read-only inspection tools and the custom plan-mode tools remain; generic subagent launchers and shell access are excluded.
2. **5-phase workflow injected every turn:**
   - **Phase 1: Initial Understanding** — launch parallel `moa-explore` subagents to search the codebase
   - **Phase 2: Design** — launch `mf-plan` subagent(s) to design the implementation
   - **Phase 3: Review** — read critical files, clarify requirements with the user
   - **Phase 4: Final Plan** — write the finalized plan to disk
   - **Phase 5: Exit** — call `exit_plan_mode` for user approval

   This is the **single-model workflow**: the model you pick drives all five phases. [MoA](#mixture-of-agents-moa) replaces phases 1–2 with the proposer fan-out.
3. **Per-session plan file** — one slug per session, persisted across `/resume`.
4. **User approval** — `exit_plan_mode` prompts to approve or keep planning. Approving restores full tool access and hands the plan back to the model.

### ask_user_question coordination

When an extension such as `rpiv-ask-user-question` registers the `ask_user_question` tool, MoA Fusion defers all in-plan clarification to it rather than drawing its own dialog. The plan-mode tools (`enter_plan_mode`, `exit_plan_mode`, `mf_plan_subagent`) run sequentially, so a same-message `ask_user_question` + `exit_plan_mode` resolves the questionnaire first — MoA Fusion's review overlay never opens on top of it. `exit_plan_mode` refuses with a pending-question error while a questionnaire is still waiting for answers. F2–F7 and the slash commands warn instead of opening; **Esc** and **F4** during a `mf_plan_subagent` run pass through to the questionnaire. MoA orchestration prompts (synthesizer open questions, conflict review, review-loop plan review/chat editor, verification) are deliberately unaffected because they run while the session model is idle. Without the tool registered, the model asks for clarification in plain text and the injected instructions never name `ask_user_question`.

## Custom Tools (Available in Plan Mode)

| Tool | Description |
|------|-------------|
| `write_plan` | Write/update the plan file (the only writable file) |
| `mf_plan_subagent` | Launch moa-explore/mf-plan subagents (single or parallel mode) |
| `exit_plan_mode` | Present plan for user approval and exit plan mode |
| `ask_user_question` | Ask structured questions — active only when an extension (e.g. `rpiv-ask-user-question`) registers it; MoA Fusion's plan-mode tools run sequentially so its own overlays never cover the questionnaire, and without it the model asks in plain text |

Outside plan mode, one additional tool is exposed:

| Tool | Description |
|------|-------------|
| `enter_plan_mode` | Lets the agent enter plan mode itself when asked for a design or plan. Takes the single-model path on the current session model — no pickers, no MoA. Exit and approval work exactly as if the user had pressed F2. |

## Subagents

Seven agent definitions are auto-installed to `~/.pi/agent/agents/` on first run (won't overwrite existing files). Two belong to the single-model workflow, three to MoA planning, one to the independent opinion flow, and one to the debate flow:

| Agent | Workflow | Role | Model & thinking come from |
|-------|----------|------|----------------------------|
| `moa-proposer` | MoA fan-out | Explores the repo *and* writes a complete plan, one independent instance per slot | The per-slot picker at the start of each MoA run |
| `moa-synthesizer` | MoA synthesis | Reconciles every proposal into one plan | The synthesizer slot of the same picker |
| `moa-verifier` | MoA verification | Read-only; scores the frozen verification criteria against the implemented working tree, using the diff and `check`/`lint`/`test` results as evidence | The verifier slot of the same picker |
| `moa-opinion` | Opinion fan-out | Produces one independent, repo-grounded answer; no synthesis or adjudication follows | The selected `/mf-opinion` slot |
| `moa-debater` | Debate | Argues one side of a multi-round debate, seeing peers' labeled prior positions each round; may keep or change stance; no judge follows | The selected `/mf-debate` slot |
| `moa-explore` | Single-model (Phase 1) | Fast codebase recon | Its own frontmatter, via `/mf-plan-settings` (haiku by default) |
| `mf-plan` | Single-model (Phase 2) | Turns exploration context into a detailed plan | **The session's active model** — whatever you picked in the "Single model" picker. No settings slot |

MoA never invokes `moa-explore` or `mf-plan` — each `moa-proposer` is a self-contained fusion of both roles, doing its own exploration so the proposals stay independent. (The `mf_plan_subagent` tool does stay available after synthesis, so refining an MoA plan by hand can still spawn them.)

Every planning subprocess is forced through a runtime `read,grep,find,ls` allowlist, even when an installed agent definition is stale, customized, or omits its `tools` field.

### Choosing their models

`moa-explore` is the only agent whose frontmatter model is authoritative. `mf-plan` also carries a `model:` in its frontmatter, but it is only a fallback — the session's active model (set via `pi.setModel`) overrides it. The MoA agents carry no `model:` field at all.

```yaml
---
name: moa-explore
description: Fast codebase recon...
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
thinking: off
---
```

`/mf-plan-settings` writes these two fields for you, but editing the file by hand works equally well — the overlay reads its current values back. An unrecognized `thinking:` value is ignored rather than passed to the subprocess.

#### Agent rosters

The MoA roles (proposers, synthesizer, implementer, verifier) are no longer assigned one-by-one in `/mf-plan-settings`. Instead the overlay's **agent rosters** row manages named rosters — reusable sets that assign a model + thinking level to every MoA role at once (2–5 proposers plus the three required roles; a roster must be complete to save). Each run, the picker's **Load Roster** row applies a roster to every slot wholesale — a 2-proposer roster also clears stale picks from slots 3–5 — and slots whose model is no longer callable are skipped with a warning while the rest load normally.

Rosters persist in `~/.pi/agent/mf-plan/settings.json`:

```json
{
  "rosters": [
    {
      "name": "team1",
      "proposers": [
        { "ref": { "provider": "anthropic", "id": "claude-opus-4-6" }, "thinking": "high" },
        { "ref": { "provider": "google", "id": "gemini-3-pro" }, "thinking": "medium" }
      ],
      "synthesizer": { "ref": { "provider": "anthropic", "id": "claude-opus-4-6" }, "thinking": "high" },
      "implementer": { "ref": { "provider": "anthropic", "id": "claude-opus-4-6" }, "thinking": "medium" },
      "verifier": { "ref": { "provider": "anthropic", "id": "claude-haiku-4-5" }, "thinking": "off" }
    }
  ]
}
```

Names are 1–24 alphanumeric characters, unique case-insensitively, up to 20 rosters. The roster manager stages every edit in memory — nothing is written until the settings overlay's **Save and Close**.

**First run.** Until the setup overlay has been saved once, `/mf-plan` opens it — set up agents and rosters before planning — instead of the plan prompt. Only interactive TUI sessions are gated; headless plan mode is unaffected.

**Agentic provider bridges.** Some pi providers are not plain chat-completion APIs but bridges to full coding agents with their *own* local edit/shell tools (e.g. [pi-cursor-bridge](../cursor-bridge), whose models run Cursor agents in the repo cwd). Pi's tool allowlist cannot restrain those agent-side tools, so plan mode adds two more layers:

- **Read-only env handshake** — every planning subprocess is spawned with `PI_CURSOR_FORCE_MODE=plan`, and the parent session sets it while plan mode is active. cursor-bridge maps this to Cursor's native read-only *plan* mode (SDK `mode: "plan"`; CLI `--mode plan` without `--force`).
- **Mutation tripwire** — `git status --porcelain` is snapshotted before subagents launch and re-checked after every phase. If the working tree changed while planning agents ran, a warning lists the touched files so rogue edits are never silently absorbed.

### Parallel execution

In the single-model flow, Phase 1 launches up to **3 moa-explore agents in parallel** and Phase 2 up to **1 mf-plan agent**. Concurrency is capped at 5 simultaneous processes, with a per-task output cap of 50KB.

```
mf_plan_subagent({
  tasks: [
    { agent: "moa-explore", task: "Find authentication modules and patterns" },
    { agent: "moa-explore", task: "Explore middleware and hook patterns" }
  ]
})
```

## Plan File Location

```
~/.pi/agent/mf-plan/plans/<word-slug>.md
```

The slug is a generated adjective-adjective-noun triple (e.g. `happy-mellifluous-iguana`). One slug per session, persisted via `appendEntry` so `/resume` reuses the same file.

`/mf-plan-clear` (`F5`) rotates the session to a fresh empty slug so the next planning round starts without prefilling or re-entry instructions; old plan files under `~/.pi/agent/mf-plan/plans/` are kept, and the approved-plan handoff is preserved so `/mf-plan-implement` still works.

## Non-Interactive Behavior

In non-interactive modes (`pi -p`, `--mode json`), `exit_plan_mode` is rejected unless `MOA_PLAN_AUTO_APPROVE=1` is set. With that explicit opt-in, it exits plan mode and hands the plan back without prompting. The plan file is still written to disk.

## How It Works (Architecture)

```
index.ts                     # Package entry point (re-exports src/index.ts)
src/
├── index.ts                 # Thin composition entry
├── activityMeter.ts         # Dependency-free output-rate meter
├── shared/
│   └── modelRefs.ts         # Model refs, thinking levels, display labels
├── config/
│   ├── settings.ts          # Persistent MoA settings
│   ├── rosters.ts           # Agent-roster types, limits, and validation
│   ├── modelCatalogue.ts    # Registry-backed selectable model cache
│   └── planName.ts          # LLM-summarized plan names
├── agents/
│   ├── discovery.ts         # User/project agent discovery and parsing
│   ├── authoritative.ts     # Bundled-agent resolution and installation
│   └── defaults.ts          # Installed agent frontmatter defaults
├── runtime/
│   ├── runner.ts            # Isolated pi subprocess entry points
│   ├── processPool.ts       # Process tracking, concurrency, kill escalation
│   ├── wire.ts              # JSONL and usage-beacon parsing
│   ├── activityTracking.ts  # Streaming output/activity assembly
│   ├── results.ts           # Runner result classification/output helpers
│   ├── cancelRun.ts         # Per-agent cancellation bookkeeping
│   └── mutationTripwire.ts  # Working-tree mutation detection
├── opinion/
│   ├── runOpinion.ts        # Interactive opinion command orchestration
│   ├── opinionFanout.ts     # Parallel read-only opinion agents and retry
│   ├── opinionContract.ts   # Task/retry contract and output detection
│   ├── opinionResults.ts    # Outcome collection and transcript markdown
│   └── opinionFile.ts       # Repo-local opinion artifacts
├── debate/
│   ├── runDebate.ts         # Interactive debate command orchestration
│   ├── debateFanout.ts      # Round loop over parallel read-only debater agents
│   ├── debateContract.ts    # Opening/round task builders, stance parsing, retry
│   ├── debateRounds.ts      # Survivor/early-stop/next-round bookkeeping
│   ├── debateResults.ts     # Outcome collection and debate transcript markdown
│   └── debateFile.ts        # Repo-local debate artifacts
├── planning/
│   ├── planMode.ts          # Plan-mode state transitions and lifecycle handlers
│   ├── modeState.ts         # Persisted state shape, byte cap, append deduplication
│   ├── planFile.ts          # Slugs, plan files, proposal staging
│   ├── instructions.ts      # Injected 5-phase plan-mode instructions
│   ├── askUserQuestion.ts   # rpiv questionnaire detection and blocked-state tracking
│   └── tools/
│       ├── shared.ts
│       ├── enterPlanMode.ts # Interactive entry flow, ESC listener, agent tool
│       ├── writePlan.ts
│       ├── exitPlanMode.ts
│       └── mfPlanSubagent.ts
├── moa/
│   ├── orchestration.ts     # Outer phase sequencer and run cleanup
│   ├── fanout.ts            # Proposer fan-out and planless retry
│   ├── synthesis.ts         # Synthesis rounds, recovery, verdicts/conflicts
│   ├── reviewLoop.ts        # Review/edit/chat/approve flow
│   ├── verification.ts      # Post-implementation verify + bounded repair phase
│   ├── verificationCriteria.ts # Frozen criteria contract and generation
│   ├── verifyGate.ts        # check/lint/test script gate + git-diff capture
│   ├── implementationRetry.ts # Implementation handoff, kickoff, retry flow
│   ├── runContext.ts        # Explicit run-scoped mutable context and host API
│   ├── modelRuntime.ts      # Provider/model resolution
│   ├── conflicts.ts         # Conflict protocol parser
│   ├── conflictContract.ts  # Conflict-surfacing task-text contract
│   ├── contextContract.ts   # Context-subsection (auditable reasoning) contract
│   ├── planInfo.ts          # Persisted MoA metadata validation
│   ├── verdicts.ts
│   └── planlessRetry.ts
└── ui/
    ├── chrome.ts            # Shared overlay frame/render primitives
    ├── menu.ts
    ├── agentStatus.ts
    ├── twoPaneModelThinking.ts
    ├── moaModelPicker.ts
    ├── rosterEditor.ts       # Staged agent-roster manager for /mf-plan-settings
    ├── opinionModelPicker.ts
    ├── debateModelPicker.ts
    ├── moaSetupOverlay.ts
    ├── moaProgressWidget.ts
    ├── agentTranscript.ts      # Shared Observe/inline-preview transcript formatting
    ├── planReviewOverlay.ts
    ├── conflictOverlay.ts
    ├── observeOverlay.ts
    └── cancelOverlay.ts

agents/                      # Shipped agent definitions
├── moa-explore.md
├── mf-plan.md
├── moa-opinion.md
├── moa-debater.md
├── moa-proposer.md
├── moa-synthesizer.md
└── moa-verifier.md
```

**Key design decisions:**
- **Custom `write_plan` tool** instead of path-guarded `edit`/`write` — guarantees the single-writable-file invariant.
- **Subprocess subagents** (not in-process) — each agent runs in an isolated `pi --mode json -p --no-session` subprocess with an enforced read-only tool allowlist.
- **State via `appendEntry`** — plan mode state (enabled, slug, tools snapshot) persists in the session for `/resume` and `/reload`.
- **Context injection via `before_agent_start`** — the 5-phase instructions are injected as a user message every turn while plan mode is active; the `context` hook strips stale plan-mode messages once it is off.
- **MoA proposers never pause mid-run** — subprocess subagents are one-shot, so a proposer that hits an ambiguity records it as an assumption and keeps going. Only the synthesizer, which sees every proposal, asks the user anything — keeping fan-out fully parallel.

## Porting Notes

Ported from Claude Code's plan mode, adapted to pi's extension primitives:

| Claude Code | MoA Fusion | Notes |
|-------------|------------|-------|
| `getPlanModeV2Instructions` (messages.ts) | `src/planning/instructions.ts` | Adapted tool names, hardcoded agent counts |
| `ExitPlanModeV2Tool` | `exit_plan_mode` tool | Simplified: no teammate/mailbox approval routing |
| `plans.ts` (slug, file management) | `src/planning/planFile.ts` | Simplified: no CCR snapshot recovery |
| In-process Explore/Plan agents | Subprocess subagents | pi's subprocess pattern (isolated context) |
| `FileEditTool`/`FileWriteTool` guarded | Custom `write_plan` tool | Safer single-writable-file invariant |
| Subscription-tier agent counts | Hardcoded constants (3/1) | Bumpable via code change |
| Plan-length A/B experiment | Standard Phase 4 | Experiment noise skipped |
| Interview phase variant | Standard 5-phase workflow | Variant skipped |

## License

MIT
