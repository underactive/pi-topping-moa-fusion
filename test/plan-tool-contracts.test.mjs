import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/index.ts transitively loads overlay modules that use TypeScript parameter
// properties, so execute this assertion script under Node's TS transform.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], {
			stdio: "inherit",
		});
	} catch (err) {
		process.exit(err.status ?? 1);
	}
	process.exit(0);
}

const { Value } = await import("typebox/value");
const { default: mfPlanExtension } = await import("../src/index.ts");
const { buildImplementationKickoffMessage } = await import("../src/moa/implementationRetry.ts");
const { getPlanFilePath } = await import("../src/planning/planFile.ts");
const { FOLLOW_UP } = await import("../src/shared/modelRefs.ts");
const {
	ENTER_PLAN_MODE_OUTPUT_SCHEMA,
	EXIT_PLAN_MODE_OUTPUT_SCHEMA,
	MF_PLAN_SUBAGENT_OUTPUT_SCHEMA,
	WRITE_PLAN_OUTPUT_SCHEMA,
} = await import("../src/planning/tools/structuredResults.ts");

const EXPECTED_ANNOTATIONS = {
	write_plan: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
	enter_plan_mode: { readOnlyHint: false },
	exit_plan_mode: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
	mf_plan_subagent: { readOnlyHint: false, idempotentHint: false },
};
const EXPECTED_SCHEMAS = {
	write_plan: WRITE_PLAN_OUTPUT_SCHEMA,
	enter_plan_mode: ENTER_PLAN_MODE_OUTPUT_SCHEMA,
	exit_plan_mode: EXIT_PLAN_MODE_OUTPUT_SCHEMA,
	mf_plan_subagent: MF_PLAN_SUBAGENT_OUTPUT_SCHEMA,
};
const NORMAL_TOOLS = ["read", "grep", "write", "edit"];
const REPO_PLAN_SLUG = "contract-review-plan";
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousAutoApprove = process.env.MOA_PLAN_AUTO_APPROVE;
const tempRoot = mkdtempSync(path.join(tmpdir(), "mf-plan-tool-contracts-test-"));

let activeTools = [...NORMAL_TOOLS];
let sessionEntries = [];
const sentMessages = [];
const tools = new Map();
const handlers = new Map();
const fakePi = {
	getThinkingLevel: () => "medium",
	getAllTools: () => [...NORMAL_TOOLS.map((name) => ({ name })), ...[...tools.keys()].map((name) => ({ name }))],
	getActiveTools: () => [...activeTools],
	setActiveTools: (names) => { activeTools = [...names]; },
	appendEntry: () => {},
	registerFlag: () => {},
	registerCommand: () => {},
	registerShortcut: () => {},
	registerTool: (tool) => {
		tools.set(tool.name, tool);
		if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
	},
	on: (event, handler) => { handlers.set(event, handler); },
	getFlag: () => false,
	sendUserMessage: (text, options) => { sentMessages.push({ text, options }); },
	events: { on: () => () => {}, emit: () => {} },
};
const headlessCtx = {
	hasUI: false,
	mode: "rpc",
	cwd: tempRoot,
	model: { provider: "test", id: "model" },
	ui: {
		notify: () => {},
		setStatus: () => {},
		theme: { fg: (_color, text) => text },
	},
	sessionManager: { getEntries: () => sessionEntries },
};

function assertValid(schema, value) {
	assert.ok(Value.Check(schema, value), `structured value must match its output schema: ${JSON.stringify(value)}`);
}

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	delete process.env.MOA_PLAN_AUTO_APPROVE;
	mfPlanExtension(fakePi);

	// Static contracts: annotations, output schemas, and no prepareLoadout. Plan-only
	// tools are kept out of normal mode with setActiveTools (see planMode.ts).
	for (const [name, annotations] of Object.entries(EXPECTED_ANNOTATIONS)) {
		const tool = tools.get(name);
		assert.ok(tool, `${name} must be registered`);
		assert.deepEqual(tool.annotations, annotations, `${name} annotations`);
		assert.equal(tool.outputSchema, EXPECTED_SCHEMAS[name], `${name} declares its output schema`);
		assert.equal(tool.prepareLoadout, undefined, `${name} must not use prepareLoadout`);
	}
	// A tool_result handler that replaced content would drop structuredContent.
	assert.ok(!handlers.has("tool_result"), "no tool_result handler is registered");
	assert.ok(!handlers.has("tool_call"), "no tool_call handler is registered");

	// pi 1.0.0 codemode reduces outputSchema to top-level field names but keeps
	// the description verbatim, so mf_plan_subagent restates its nested shape there.
	{
		const fieldList = (schema) => Object.keys(schema.properties)
			.map((name) => (schema.required?.includes(name) ? name : `${name}?`))
			.join(", ");
		const { description } = tools.get("mf_plan_subagent");
		assert.ok(
			description.includes(`Returns { ${fieldList(MF_PLAN_SUBAGENT_OUTPUT_SCHEMA)} }`),
			`mf_plan_subagent description names its top-level result fields: ${description}`,
		);
		assert.ok(
			description.includes(`results is an array of { ${fieldList(MF_PLAN_SUBAGENT_OUTPUT_SCHEMA.properties.results.items)} }`),
			`mf_plan_subagent description names its results[] entry fields: ${description}`,
		);
	}

	await handlers.get("session_start")({}, headlessCtx);

	// write_plan outside plan mode: plain error.
	{
		const outcome = await tools.get("write_plan").execute("call-1", { content: "# Plan" }, undefined, undefined, headlessCtx);
		assert.equal(outcome.isError, true);
		assert.equal(outcome.structuredContent, undefined);
	}

	// enter_plan_mode without plan_prompt (no naming model call).
	let planFilePath;
	{
		const outcome = await tools.get("enter_plan_mode").execute("call-2", {}, undefined, undefined, headlessCtx);
		assert.notEqual(outcome.isError, true);
		planFilePath = getPlanFilePath();
		assert.deepEqual(outcome.structuredContent, { status: "entered", mode: "single", reentry: false, planFilePath });
		assertValid(ENTER_PLAN_MODE_OUTPUT_SCHEMA, outcome.structuredContent);
	}

	// write_plan in plan mode: structured value mirrors details; text unchanged.
	const plan = "# Contract plan\n\n1. Do the thing.\n";
	{
		const outcome = await tools.get("write_plan").execute("call-3", { content: plan }, undefined, undefined, headlessCtx);
		assert.notEqual(outcome.isError, true);
		assert.match(outcome.content[0].text, /^Plan written to .+ \(\d+ chars\)$/);
		assert.deepEqual(outcome.details, { filePath: planFilePath, length: plan.length });
		assert.deepEqual(outcome.structuredContent, { status: "written", ...outcome.details });
		assertValid(WRITE_PLAN_OUTPUT_SCHEMA, outcome.structuredContent);
	}

	// Headless exit without the opt-in: plain error.
	{
		const outcome = await tools.get("exit_plan_mode").execute("call-4", {}, undefined, undefined, headlessCtx);
		assert.equal(outcome.isError, true);
		assert.equal(outcome.structuredContent, undefined);
	}

	// Headless auto-approve: the result text is the kickoff.
	{
		process.env.MOA_PLAN_AUTO_APPROVE = "1";
		const outcome = await tools.get("exit_plan_mode").execute("call-5", {}, undefined, undefined, headlessCtx);
		assert.notEqual(outcome.isError, true);
		assert.equal(outcome.content[0].text, buildImplementationKickoffMessage(plan, planFilePath));
		assert.deepEqual(outcome.structuredContent, { status: "approved", planFilePath, headless: true, kickoff: "inline" });
		assertValid(EXIT_PLAN_MODE_OUTPUT_SCHEMA, outcome.structuredContent);
		delete process.env.MOA_PLAN_AUTO_APPROVE;
	}

	// Interactive (RPC select) keep and approve. Restoring a named plan skips the
	// plan-naming model call.
	sessionEntries = [{
		type: "custom",
		customType: "mf-plan",
		data: {
			enabled: true,
			slug: path.basename(planFilePath, ".md"),
			repoPlanSlug: REPO_PLAN_SLUG,
			toolsBeforePlanMode: NORMAL_TOOLS,
		},
	}];
	await handlers.get("session_start")({}, headlessCtx);
	assert.equal(getPlanFilePath(), planFilePath);
	let nextChoice;
	const interactiveCtx = {
		...headlessCtx,
		hasUI: true,
		ui: { ...headlessCtx.ui, select: async () => nextChoice },
	};
	{
		nextChoice = "Keep planning";
		const outcome = await tools.get("exit_plan_mode").execute("call-6", {}, undefined, undefined, interactiveCtx);
		assert.notEqual(outcome.isError, true);
		assert.equal(outcome.content[0].text, "User wants to keep refining the plan. Continue working on the plan file and call exit_plan_mode when ready.");
		assert.deepEqual(outcome.structuredContent, {
			status: "keep_planning",
			planFilePath,
			headless: false,
			kickoff: "none",
			repoPlanSlug: REPO_PLAN_SLUG,
		});
		assertValid(EXIT_PLAN_MODE_OUTPUT_SCHEMA, outcome.structuredContent);
		assert.equal(sentMessages.length, 0);
	}
	{
		nextChoice = "Approve — start implementing";
		const outcome = await tools.get("exit_plan_mode").execute("call-7", {}, undefined, undefined, interactiveCtx);
		assert.notEqual(outcome.isError, true);
		assert.match(outcome.content[0].text, /^Plan approved and saved\. Plan mode has exited\. Stop here/);
		assert.deepEqual(outcome.structuredContent, {
			status: "approved",
			planFilePath,
			headless: false,
			kickoff: "follow_up",
			repoPlanSlug: REPO_PLAN_SLUG,
		});
		assertValid(EXIT_PLAN_MODE_OUTPUT_SCHEMA, outcome.structuredContent);
		assert.equal(sentMessages.length, 1);
		assert.deepEqual(sentMessages[0].options, FOLLOW_UP);
		assert.equal(sentMessages[0].text, buildImplementationKickoffMessage(plan, planFilePath));
	}

	await handlers.get("session_shutdown")({ reason: "test" }, headlessCtx);
} finally {
	if (previousAutoApprove === undefined) delete process.env.MOA_PLAN_AUTO_APPROVE;
	else process.env.MOA_PLAN_AUTO_APPROVE = previousAutoApprove;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Plan tool contract tests passed.");
