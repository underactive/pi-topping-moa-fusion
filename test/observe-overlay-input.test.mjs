import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// observeOverlay.ts uses TypeScript parameter properties, so execute this
// assertion script under Node's TS transform before dynamically importing it.
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

const { showObserveOverlay } = await import("../src/ui/observeOverlay.ts");
const root = path.resolve(import.meta.dirname, "..");
const indexSource = readFileSync(path.join(root, "src", "planning", "tools", "enterPlanMode.ts"), "utf8");
assert.match(
	indexSource,
	/if \(host\.getActiveObserveSession\(\)\?\.overlayOpen\) return undefined;\s*if \(session\.overlayOpen\) return undefined;/,
);

async function mountObserver() {
	let component;
	let closed = 0;
	const session = {
		title: "MoA fan-out",
		phase: "fanout",
		agents: [{
			label: "Proposer 1",
			model: "test/model",
			task: "test task",
			messages: [],
			state: "working",
		}],
		overlayOpen: true,
	};
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (factory) => {
				component = factory({ requestRender: () => {} }, {}, undefined, () => { closed++; });
			},
		},
	};

	await showObserveOverlay(ctx, session);
	return { component, closed: () => closed, session };
}

for (const key of ["\u001b", "q", "Q"]) {
	const { component, closed, session } = await mountObserver();
	component.handleInput(key);
	assert.equal(closed(), 1, `${JSON.stringify(key)} must close the observer`);
	assert.equal(session.agents[0].state, "working", `${JSON.stringify(key)} must not cancel the agent`);
	component.dispose();
}

// `d` is swallowed while pinned to bottom (matches the existing j/PageDown/Ctrl+F guard).
{
	const { component } = await mountObserver();
	const before = component.scrollOffset;
	component.handleInput("d");
	assert.equal(component.scrollOffset, before, "'d' must be swallowed while pinned to bottom");
	assert.equal(component.pinnedToBottom, true, "'d' must not unpin while pinned to bottom");
	component.dispose();
}

// `d` pages down by the same amount as the canonical PageDown escape sequence, once unpinned.
{
	const { component } = await mountObserver();
	component.handleInput("k"); // unpin from the bottom
	const afterUnpin = component.scrollOffset;
	component.handleInput("\u001b[6~"); // PageDown
	const pageDownDelta = component.scrollOffset - afterUnpin;

	component.scrollOffset = afterUnpin;
	component.handleInput("d");
	const dDelta = component.scrollOffset - afterUnpin;
	assert.equal(dDelta, pageDownDelta, "'d' must page down by the same amount as PageDown");
	component.dispose();
}

// `u` pages up by the same amount as the canonical PageUp escape sequence, and unpins from the bottom.
{
	const { component: pageUpComponent } = await mountObserver();
	pageUpComponent.handleInput("\u001b[5~"); // PageUp
	const pageUpDelta = pageUpComponent.scrollOffset;
	pageUpComponent.dispose();

	const { component } = await mountObserver();
	component.handleInput("u");
	assert.equal(component.scrollOffset, pageUpDelta, "'u' must page up by the same amount as PageUp");
	assert.equal(component.pinnedToBottom, false, "'u' must unpin from the bottom");
	component.dispose();
}

console.log("Observe overlay input tests passed.");
