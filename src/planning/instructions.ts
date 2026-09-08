/**
 * The 5-phase plan-mode instructions injected every turn.
 * Faithful port of Claude Code's getPlanModeV2Instructions from messages.ts.
 */

import { getPlanFilePath, getPlan } from "./planFile.ts";

// Agent counts — bumpable constants (Claude Code uses tier-based; we hardcode)
export const EXPLORE_AGENT_COUNT = 3;
export const PLAN_AGENT_COUNT = 1;

/**
 * Build the plan-mode system reminder injected every turn.
 *
 * `askUserQuestionAvailable` is re-probed on each entry so the model is never
 * told to call a tool that is not registered: when no extension provides
 * `ask_user_question` (the tool is only active when e.g. rpiv-ask-user-question
 * registers it), the instructions ask for clarification in plain text instead.
 */
export function buildPlanModeInstructions(askUserQuestionAvailable: boolean): string {
	const planFilePath = getPlanFilePath();
	const planExists = getPlan() !== null;

	const planFileInfo = planExists
		? `A plan file already exists at ${planFilePath}. You can read it with the read tool, then rewrite it with additions using the write_plan tool (which replaces the entire file, so include all content).`
		: `No plan file exists yet. You should create your plan at ${planFilePath} using the write_plan tool.`;

	const phase3Clarify = askUserQuestionAvailable
		? "3. Use ask_user_question to clarify any remaining questions with the user"
		: "3. Ask the user directly in your reply to clarify any remaining questions";

	const phase5Stop = askUserQuestionAvailable
		? "This is critical - your turn should only end with either using the ask_user_question tool OR calling exit_plan_mode. Do not stop unless it's for these 2 reasons."
		: "This is critical - your turn should only end with either a plain-text clarifying question OR calling exit_plan_mode. Do not stop unless it's for these 2 reasons.";

	const importantBlock = askUserQuestionAvailable
		? `**Important:** Use ask_user_question ONLY to clarify requirements or choose between approaches. Use exit_plan_mode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no ask_user_question. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use exit_plan_mode.

Call ask_user_question by itself — never in the same message as exit_plan_mode, mf_plan_subagent, write_plan, or any other tool. End your turn after calling it and wait for the answers.`
		: `**Important:** Use exit_plan_mode to request plan approval. Do NOT ask about plan approval in any other way - no text questions. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use exit_plan_mode.`;

	const closingNote = askUserQuestionAvailable
		? "NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ask_user_question tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins."
		: "NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications directly in your reply. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.";

	return `[PLAN MODE ACTIVE]
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.

2. **Launch up to ${EXPLORE_AGENT_COUNT} explore agents IN PARALLEL** using the mf_plan_subagent tool (parallel mode, single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - ${EXPLORE_AGENT_COUNT} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore.

Example parallel launch (single message, multiple tool calls):
\`\`\`
mf_plan_subagent({ tasks: [
  { agent: "moa-explore", task: "Find all authentication-related modules and their patterns" },
  { agent: "moa-explore", task: "Search for existing middleware and hook patterns in the codebase" },
  { agent: "moa-explore", task: "Find test files and testing patterns used in this project" }
] })
\`\`\`

### Phase 2: Design
Goal: Design an implementation approach.

Launch \`mf-plan\` agent(s) using the mf_plan_subagent tool to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to ${PLAN_AGENT_COUNT} agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
${phase3Clarify}

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Begin with a **Context** section: explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call exit_plan_mode
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call exit_plan_mode to indicate to the user that you are done planning.
${phase5Stop}

${importantBlock}

${closingNote}`;
}

/** Build the re-entry reminder when a plan file already exists. */
export function buildPlanModeReentryInstructions(): string {
	const planFilePath = getPlanFilePath();

	return `[PLAN MODE RE-ENTRY]
## Re-entering Plan Mode

You are returning to plan mode after having previously exited it. A plan file exists at ${planFilePath} from your previous planning session.

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling exit_plan_mode

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`;
}

/** Build the exit reminder injected once after plan mode is turned off. */
export function buildPlanModeExitInstructions(): string {
	const planFilePath = getPlanFilePath();
	const planExists = getPlan() !== null;
	const planReference = planExists
		? ` The plan file is located at ${planFilePath} if you need to reference it.`
		: "";

	return `## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`;
}
