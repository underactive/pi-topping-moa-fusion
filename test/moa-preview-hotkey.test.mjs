import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Key } from "@earendil-works/pi-tui";

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

const { createPlanModeController } = await import("../src/planning/planMode.ts");
const { default: mfPlanExtension } = await import("../src/index.ts");
const { MoaProgressWidget } = await import("../src/ui/moaProgressWidget.ts");

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-preview-hotkey-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");

const MODEL = { provider: "test", id: "preview-model" };

function makePi() {
	const lifecycle = new Map();
	const blockedEvents = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	let activeTools = ["read", "write"];
	const fakePi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "write" }],
		getActiveTools: () => activeTools,
		setActiveTools: (tools) => { activeTools = [...tools]; },
		appendEntry: () => {},
		getFlag: () => false,
		registerFlag: () => {},
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: (key, options) => shortcuts.set(key, options),
		registerTool: () => {},
		registerAgentTool: () => {},
		on: (name, handler) => lifecycle.set(name, handler),
		events: {
			on: (name, handler) => {
				blockedEvents.set(name, handler);
				return () => blockedEvents.delete(name);
			},
		},
	};
	return { fakePi, lifecycle, blockedEvents, commands, shortcuts };
}

function makeContext() {
	const notifications = [];
	let inputHandler;
	let unsubscribeCount = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: tempRoot,
		sessionManager: { getEntries: () => [] },
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
			theme: { fg: (_color, text) => text },
			onTerminalInput: (handler) => {
				inputHandler = handler;
				return () => {
					if (inputHandler === handler) inputHandler = undefined;
					unsubscribeCount++;
				};
			},
			setWidget: () => {},
		},
	};
	return {
		ctx,
		notifications,
		getInput: () => inputHandler,
		get unsubscribeCount() { return unsubscribeCount; },
	};
}

async function makeHarness({ withWidget = true } = {}) {
	const pi = makePi();
	const context = makeContext();
	const controller = createPlanModeController(pi.fakePi);
	await controller.onSessionStart({}, context.ctx);
	let widget;
	if (withWidget) {
		widget = new MoaProgressWidget(context.ctx);
		widget.startFanout([MODEL]);
		controller.moaRunHost.adoptProgressWidget(widget);
	}
	return {
		...pi,
		...context,
		controller,
		widget,
		get unsubscribeCount() { return context.unsubscribeCount; },
	};
}

function shutdown(harness) {
	harness.controller.onSessionShutdown({ reason: "test" });
}

try {
	// Raw input handles both the legacy SS3 sequence and Kitty's F2 letter form.
	for (const data of ["\x1bOQ", "\x1b[1Q"]) {
		const harness = await makeHarness();
		try {
			assert.equal(harness.widget.previewVisible, true);
			assert.deepEqual(harness.getInput()(data), { consume: true });
			assert.equal(harness.widget.previewVisible, false);
			assert.deepEqual(harness.notifications.at(-1), { message: "Live preview hidden.", level: undefined });
		} finally {
			shutdown(harness);
		}
	}

	// Kitty release and repeat events are ignored, so one physical key cannot
	// toggle twice when pi-tui forwards the release to extension listeners.
	{
		const harness = await makeHarness();
		try {
			const input = harness.getInput();
			const noticesBefore = harness.notifications.length;
			assert.equal(input("\x1b[1;1:3Q"), undefined);
			assert.equal(input("\x1b[1;1:2Q"), undefined);
			assert.equal(harness.widget.previewVisible, true);
			assert.equal(harness.notifications.length, noticesBefore);
		} finally {
			shutdown(harness);
		}
	}

	// With no active table, the listener passes F2 through while explaining the no-op.
	{
		const harness = await makeHarness({ withWidget: false });
		try {
			assert.equal(harness.getInput()("\x1bOQ"), undefined);
			assert.equal(harness.notifications.length, 1);
			assert.deepEqual(harness.notifications.at(-1), { message: "No MoA live preview is showing.", level: "warning" });
		} finally {
			shutdown(harness);
		}
	}

	// A live questionnaire prevents the toggle and lets F2 pass through.
	{
		const harness = await makeHarness();
		try {
			harness.blockedEvents.get("rpiv:ask-user:blocked")({ active: true });
			assert.equal(harness.getInput()("\x1bOQ"), undefined);
			assert.equal(harness.widget.previewVisible, true);
			assert.equal(harness.notifications.length, 1);
			assert.deepEqual(harness.notifications.at(-1), {
				message: "Answer or dismiss the ask_user_question questionnaire first.",
				level: "warning",
			});
		} finally {
			shutdown(harness);
		}
	}

	// Cancel and observe overlays own the keyboard, so F2 passes through untouched.
	{
		const harness = await makeHarness();
		try {
			harness.controller.setActiveCancelSession({ title: "cancel", run: undefined, overlayOpen: true });
			assert.equal(harness.getInput()("\x1bOQ"), undefined);
			assert.equal(harness.widget.previewVisible, true);
			harness.controller.setActiveCancelSession(undefined);
			harness.controller.moaRunHost.setActiveObserveSession({
				title: "observe",
				phase: "fanout",
				agents: [],
				overlayOpen: true,
			});
			assert.equal(harness.getInput()("\x1b[1Q"), undefined);
			assert.equal(harness.widget.previewVisible, true);
			assert.equal(harness.notifications.length, 0);
		} finally {
			shutdown(harness);
		}
	}

	// Session shutdown removes the raw listener and does not leave a stale subscription.
	{
		const harness = await makeHarness();
		shutdown(harness);
		assert.equal(harness.unsubscribeCount, 1);
		assert.equal(harness.getInput(), undefined);
		assert.equal(harness.widget.previewVisible, true);
	}

	// Registration keeps F2 discoverable and provides a terminal-independent command fallback.
	{
		const { fakePi, commands, shortcuts } = makePi();
		mfPlanExtension(fakePi);
		assert.equal(typeof commands.get("mf-preview")?.handler, "function");
		assert.equal(shortcuts.has(Key.f2), true);

		const context = makeContext();
		await commands.get("mf-preview").handler("", context.ctx);
		assert.equal(context.notifications.length, 1);
		assert.deepEqual(context.notifications.at(-1), { message: "No MoA live preview is showing.", level: "warning" });
	}

	console.log("MoA preview hotkey tests passed.");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}
