import assert from "node:assert/strict";

// workingOverlay.ts avoids TypeScript parameter properties (explicit fields
// in the constructor instead), so — unlike cancelOverlay.ts — it loads under
// Node's native type stripping without the --experimental-transform-types
// re-exec shim used by test/overlay-chrome-parity.test.mjs and friends.
const { requestWorkingOverlayClose, showWorkingOverlay, withWorkingOverlay } = await import("../src/ui/workingOverlay.ts");
const { BRAILLE_SPINNER_FRAMES } = await import("../src/ui/chrome.ts");

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const fakeTui = { requestRender() {} };

const ESC = "\u001b";
const ESC_RELEASES = ["\u001b[27;1:3u", "\u001b[27:3u"];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await sleep(intervalMs);
	}
}

/** ui.custom stub matching the real contract: resolves only once `done` is called. */
function makeCtx(onFactory) {
	return {
		mode: "tui",
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					const component = factory(fakeTui, theme, {}, (value) => resolve(value));
					onFactory(component);
				}),
		},
	};
}

// 1. Work resolving inside the grace window never mounts the overlay.
{
	let customCalls = 0;
	const ctx = { mode: "tui", ui: { custom: async () => { customCalls++; } } };
	const result = await withWorkingOverlay(ctx, { title: "Naming the plan", detail: "summarizing" }, async () => {
		await sleep(10);
		return "fast-value";
	});
	assert.equal(result, "fast-value", "fast work must resolve with its own value");
	assert.equal(customCalls, 0, "work settling inside the grace window must never mount the overlay");
}

// 2. Slow work mounts the overlay exactly once, renders title/spinner/detail/hint, and resolves with the value.
{
	let component;
	let mountCount = 0;
	const ctx = makeCtx((c) => {
		component = c;
		mountCount++;
	});
	const resultPromise = withWorkingOverlay(
		ctx,
		{ title: "Naming the plan", detail: "summarizing your prompt into a short plan name", hint: "esc skip naming" },
		async () => {
			await sleep(260);
			return "slow-value";
		},
	);
	await waitFor(() => component !== undefined);
	assert.equal(mountCount, 1, "the overlay factory must run exactly once");
	const lines = component.render(80).join("\n");
	assert.ok(lines.includes("Naming the plan"), "render must include the title");
	assert.ok(lines.includes("summarizing your prompt into a short plan name"), "render must include the detail");
	assert.ok(lines.includes("esc skip naming"), "render must include the hint");
	assert.ok([...BRAILLE_SPINNER_FRAMES].some((frame) => lines.includes(frame)), "render must include a braille spinner frame");

	const result = await resultPromise;
	assert.equal(result, "slow-value", "the helper must resolve with the task's value once the overlay closes");
}

// 3. Rejecting work closes the overlay and the helper's promise rejects with the same error.
{
	let component;
	const ctx = makeCtx((c) => { component = c; });
	const resultPromise = withWorkingOverlay(ctx, { title: "Naming the plan", detail: "summarizing" }, async () => {
		await sleep(260);
		throw new Error("boom");
	});
	await assert.rejects(resultPromise, /boom/, "a rejecting task must propagate its error through the helper");
	assert.ok(component, "the overlay must have mounted before the rejection");
}

// 4. Closing before the factory runs still resolves once the component mounts.
{
	const session = {};
	requestWorkingOverlayClose(session);
	assert.equal(session.closeRequested, true, "requestWorkingOverlayClose must flag the request even with nothing mounted yet");

	let component;
	const ctx = makeCtx((c) => { component = c; });
	await showWorkingOverlay(ctx, { title: "Naming the plan", detail: "summarizing" }, session);
	assert.ok(component, "the component must still be constructed");
}

// 5. Esc resolves the helper with skip()'s value while the task is still pending, and aborts the signal.
{
	let component;
	let capturedSignal;
	const ctx = makeCtx((c) => { component = c; });
	const resultPromise = withWorkingOverlay(
		ctx,
		{ title: "Naming the plan", detail: "summarizing", skip: () => "skipped-value" },
		(signal) => {
			capturedSignal = signal;
			return new Promise(() => {}); // never settles on its own
		},
	);
	await waitFor(() => component !== undefined);
	assert.equal(capturedSignal.aborted, false, "the signal must start unaborted");

	component.handleInput(ESC);
	const result = await resultPromise;
	assert.equal(result, "skipped-value", "esc must resolve the helper with the skip value");
	assert.equal(capturedSignal.aborted, true, "esc must abort the signal handed to the task");
}

// 6. Esc key-release sequences must not skip or abort — only a press may.
{
	let component;
	let capturedSignal;
	const ctx = makeCtx((c) => { component = c; });
	const resultPromise = withWorkingOverlay(
		ctx,
		{ title: "Naming the plan", detail: "summarizing", skip: () => "skipped-value" },
		(signal) => {
			capturedSignal = signal;
			return new Promise(() => {});
		},
	);
	await waitFor(() => component !== undefined);

	for (const release of ESC_RELEASES) {
		component.handleInput(release);
		assert.equal(capturedSignal.aborted, false, `${JSON.stringify(release)} must not abort the signal`);
	}

	// A genuine press still works afterwards, resolving the outstanding promise.
	component.handleInput(ESC);
	const result = await resultPromise;
	assert.equal(result, "skipped-value");
	assert.equal(capturedSignal.aborted, true);
}

// 7. Outside TUI mode, the overlay never mounts and the task's own value is returned.
{
	let customCalls = 0;
	const ctx = { mode: "rpc", ui: { custom: async () => { customCalls++; } } };
	const result = await withWorkingOverlay(ctx, { title: "Naming the plan", detail: "summarizing" }, async () => {
		await sleep(260);
		return "rpc-value";
	});
	assert.equal(result, "rpc-value");
	assert.equal(customCalls, 0, "rpc mode must never mount the overlay");
}

// 8. dispose() stops the spinner timer and is safe to call more than once.
{
	let renderCalls = 0;
	let component;
	const countingTui = { requestRender: () => { renderCalls++; } };
	const session = {};
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					component = factory(countingTui, theme, {}, () => resolve());
				}),
		},
	};
	void showWorkingOverlay(ctx, { title: "Naming the plan", detail: "summarizing" }, session);
	await waitFor(() => component !== undefined);

	const before = renderCalls;
	await sleep(150);
	assert.ok(renderCalls > before, "the spinner must request renders while mounted");

	component.dispose();
	const afterDispose = renderCalls;
	await sleep(150);
	assert.equal(renderCalls, afterDispose, "no further renders must be requested after dispose");

	assert.doesNotThrow(() => component.dispose(), "dispose() must be idempotent");
}

console.log("Working overlay tests passed.");
