import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-gate-test-"));
const agentDir = path.join(tempRoot, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

try {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentDir, { recursive: true });

	const { default: mfPlanExtension } = await import("../src/index.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	const { moaSettingsPath } = await import("../src/config/settings.ts");
	const { PromptEditorComponent } = await import("../src/ui/promptEditor.ts");
	initTheme();

	const commands = new Map();
	let activeTools = ["read", "write"];
	const initialTools = [...activeTools];
	const fakePi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "write" }],
		getActiveTools: () => activeTools,
		setActiveTools: (tools) => { activeTools = tools; },
		appendEntry: () => {},
		registerFlag: () => {},
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: () => {},
		registerTool: () => {},
		on: () => {},
		getFlag: () => false,
		sendUserMessage: () => {},
	};
	mfPlanExtension(fakePi);
	const mfPlan = commands.get("mf-plan");

	let setupShown = 0;
	let editorShown = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: tempRoot,
		model: { provider: "anthropic", id: "claude-opus-4-6" },
		modelRegistry: {
			getAll: () => [{ provider: "anthropic", id: "claude-opus-4-6", reasoning: true }],
			getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-6", reasoning: true }],
			find: () => undefined,
			getRegisteredProviderIds: () => [],
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_color, text) => text },
			onTerminalInput: () => () => {},
			// Cancelling the overlay is the case under test.
			custom: async (factory) => {
				const component = factory(
					{ requestRender: () => {}, stop: () => {}, start: () => {} },
					{ fg: (_color, text) => text },
					undefined,
					() => {},
				);
				if (component instanceof PromptEditorComponent) editorShown++;
				else setupShown++;
				return undefined;
			},
			editor: () => { throw new Error("TUI prompt editor must use ui.custom"); },
		},
	};

	// ── unconfigured: setup replaces the plan prompt, and cancelling aborts ──
	await mfPlan.handler("", ctx);
	assert.equal(setupShown, 1, "first /mf-plan must open the setup overlay");
	assert.equal(editorShown, 0, "the plan prompt must not open before setup is saved");
	assert.deepEqual(activeTools, initialTools, "a cancelled setup must not leave plan-mode tools active");

	// ── configured: straight to the plan prompt, no setup overlay ───────────
	mkdirSync(path.dirname(moaSettingsPath()), { recursive: true });
	writeFileSync(moaSettingsPath(), JSON.stringify({ mode: "moa", agentDefaultsConfigured: true }), "utf8");

	await mfPlan.handler("", ctx);
	assert.equal(setupShown, 1, "a configured session must not reopen setup");
	assert.equal(editorShown, 1, "a configured session goes straight to the plan prompt");
	assert.deepEqual(activeTools, initialTools, "escaping the plan prompt must exit plan mode and restore tools");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("First-run setup gate tests passed.");
