import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Key } from "@earendil-works/pi-tui";

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

const { default: mfPlanExtension } = await import("../src/index.ts");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousAutoApprove = process.env.MOA_PLAN_AUTO_APPROVE;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-ask-user-question-test-"));

// A fresh, isolated pair of (fake pi + captured handlers) per scenario so state
// never leaks between cases. `events.on` captures the rpiv blocked-channel
// handler so a test can fire it directly; `registerShortcut` records the F-key
// handlers so a test can invoke them.
function makeHarness(allTools) {
	const captured = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const tools = new Map();
	let activeTools = ["read", "write", "enter_plan_mode"];
	const fakePi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => allTools,
		getActiveTools: () => activeTools,
		setActiveTools: (names) => { activeTools = names; },
		appendEntry: () => {},
		registerFlag: () => {},
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: (key, options) => shortcuts.set(key, options),
		registerTool: (tool) => tools.set(tool.name, tool),
		on: () => {},
		getFlag: () => false,
		events: {
			on: (channel, handler) => { captured.set(channel, handler); return () => {}; },
			emit: () => {},
		},
	};
	return { fakePi, captured, commands, shortcuts, tools };
}

const baseCtx = {
	hasUI: false,
	cwd: tempRoot,
	ui: {
		notify: () => {},
		setStatus: () => {},
		theme: { fg: (_color, text) => text },
	},
};

// A TUI ctx whose ui.custom throws — if any overlay is opened, the test fails
// loudly and the throw surfaces (the questionnaire guard must short-circuit
// before any overlay renders).
function tuiCtx(record) {
	return {
		hasUI: true,
		mode: "tui",
		cwd: tempRoot,
		ui: {
			notify: (msg, level) => record.push({ msg, level }),
			setStatus: () => {},
			theme: { fg: (_color, text) => text },
			custom: () => { throw new Error("overlay opened over the questionnaire"); },
		},
	};
}

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	delete process.env.MOA_PLAN_AUTO_APPROVE;

	// ── Case 1: with ask_user_question registered, it is activated and the
	// injected instructions carry the "call it by itself" rule. ──
	{
		const { fakePi, tools } = makeHarness([
			{ name: "read" },
			{ name: "write" },
			{ name: "enter_plan_mode" },
			{ name: "ask_user_question" },
		]);
		mfPlanExtension(fakePi);
		const result = await tools.get("enter_plan_mode").execute("call-1", {}, undefined, undefined, baseCtx);
		assert.notEqual(result.isError, true);
		assert.ok(fakePi.getActiveTools().includes("ask_user_question"));
		assert.match(result.content[0].text, /Call ask_user_question by itself/);
	}

	// ── Case 2: without ask_user_question, it is absent from the active set and
	// the instructions never name the tool — the model asks in plain text. ──
	{
		const { fakePi, tools } = makeHarness([
			{ name: "read" },
			{ name: "write" },
			{ name: "enter_plan_mode" },
		]);
		mfPlanExtension(fakePi);
		const result = await tools.get("enter_plan_mode").execute("call-1", {}, undefined, undefined, baseCtx);
		assert.notEqual(result.isError, true);
		assert.ok(!fakePi.getActiveTools().includes("ask_user_question"));
		assert.match(result.content[0].text, /Ask the user directly in your reply/);
		assert.doesNotMatch(result.content[0].text, /ask_user_question/);
	}

	// ── Case 3: a live questionnaire forces exit_plan_mode to refuse before any
	// plan-review UI is drawn. ──
	{
		const { fakePi, captured, tools } = makeHarness([
			{ name: "read" },
			{ name: "write" },
			{ name: "enter_plan_mode" },
			{ name: "ask_user_question" },
		]);
		mfPlanExtension(fakePi);
		await tools.get("enter_plan_mode").execute("enter", {}, undefined, undefined, baseCtx);
		await tools.get("write_plan").execute("write", { content: "## Plan\n1. Apply the change." }, undefined, undefined, baseCtx);
		captured.get("rpiv:ask-user:blocked")({ active: true });
		const records = [];
		const result = await tools.get("exit_plan_mode").execute("exit", {}, undefined, undefined, tuiCtx(records));
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /is still waiting for the user/);
		assert.equal(records.length, 0);
	}

	// ── Case 4: a resolved questionnaire (active:false) leaves the guard off —
	// headless exit_plan_mode falls through to the usual auto-approve error. ──
	{
		const { fakePi, captured, tools } = makeHarness([
			{ name: "read" },
			{ name: "write" },
			{ name: "enter_plan_mode" },
			{ name: "ask_user_question" },
		]);
		mfPlanExtension(fakePi);
		await tools.get("enter_plan_mode").execute("enter", {}, undefined, undefined, baseCtx);
		await tools.get("write_plan").execute("write", { content: "## Plan\n1. Apply the change." }, undefined, undefined, baseCtx);
		captured.get("rpiv:ask-user:blocked")({ active: false });
		const result = await tools.get("exit_plan_mode").execute("exit", {}, undefined, undefined, baseCtx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Auto-approve is disabled in headless mode/);
	}

	// ── Case 5: malformed payloads never move the flag; the guard stays off. ──
	{
		const { fakePi, captured, shortcuts, tools } = makeHarness([
			{ name: "read" },
			{ name: "write" },
			{ name: "enter_plan_mode" },
			{ name: "ask_user_question" },
		]);
		mfPlanExtension(fakePi);
		await tools.get("enter_plan_mode").execute("enter", {}, undefined, undefined, baseCtx);
		const handler = captured.get("rpiv:ask-user:blocked");
		handler({});
		handler(null);
		handler({ active: "yes" });
		const records = [];
		// Not active → F3 proceeds (no warning-notify), proving the flag stayed false.
		await shortcuts.get(Key.f3).handler(tuiCtx(records));
		assert.equal(records.length, 0);
	}

	// ── Case 6: a live questionnaire makes the F3/F4 shortcut handlers warn and
	// short-circuit before any overlay opens (ui.custom would throw). ──
	{
		const { fakePi, captured, shortcuts, tools } = makeHarness([
			{ name: "read" },
			{ name: "write" },
			{ name: "enter_plan_mode" },
			{ name: "ask_user_question" },
		]);
		mfPlanExtension(fakePi);
		await tools.get("enter_plan_mode").execute("enter", {}, undefined, undefined, baseCtx);
		const records = [];
		captured.get("rpiv:ask-user:blocked")({ active: true });
		await shortcuts.get(Key.f3).handler(tuiCtx(records));
		await shortcuts.get(Key.f4).handler(tuiCtx(records));
		assert.equal(records.filter((r) => /questionnaire first/.test(r.msg)).length, 2);
	}
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousAutoApprove === undefined) delete process.env.MOA_PLAN_AUTO_APPROVE;
	else process.env.MOA_PLAN_AUTO_APPROVE = previousAutoApprove;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("ask_user_question integration tests passed.");
