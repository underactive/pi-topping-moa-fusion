import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { showPromptEditor, resolveFdPath } = await import("../src/ui/promptEditor.ts");
initTheme();
const fixture = mkdtempSync(path.join(tmpdir(), "moa-prompt-editor-"));

function waitFor(predicate, message) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 1_000;
		const check = () => {
			if (predicate()) return resolve();
			if (Date.now() >= deadline) return reject(new Error(message));
			setTimeout(check, 5);
		};
		check();
	});
}

function mount(prefill = "") {
	let component;
	let doneCalled = false;
	let doneValue;
	let resolveResult;
	const result = showPromptEditor({
		mode: "tui",
		cwd: fixture,
		ui: {
			custom: (factory) => new Promise((resolve) => {
				resolveResult = resolve;
				component = factory(
					{ requestRender: () => {} },
					{ fg: (_color, text) => text },
					{ matches: () => false },
					(value) => {
						doneCalled = true;
						doneValue = value;
						resolve(value);
					},
				);
			}),
			editor: () => { throw new Error("TUI prompt editor must use ui.custom"); },
		},
	}, "Prompt", prefill);
	return {
		component,
		done: () => ({ called: doneCalled, value: doneValue }),
		result,
		resolveResult,
	};
}

try {
	mkdirSync(path.join(fixture, "src"));
	writeFileSync(path.join(fixture, "README.md"), "readme");
	writeFileSync(path.join(fixture, "alpha.ts"), "alpha");
	writeFileSync(path.join(fixture, "apple.ts"), "apple");
	writeFileSync(path.join(fixture, "src", "alpha.ts"), "nested alpha");

	{
		const mounted = mount();
		mounted.component.handleInput("REA");
		mounted.component.handleInput("\t");
		await waitFor(() => mounted.component.editor.getText() === "README.md", "Tab must complete a unique path");
		mounted.component.handleInput("\u001b");
		await mounted.result;
	}

	{
		const mounted = mount();
		mounted.component.handleInput("src/a");
		mounted.component.handleInput("\t");
		await waitFor(() => mounted.component.editor.getText() === "src/alpha.ts", "Tab must resolve nested paths from ctx.cwd");
		mounted.component.handleInput("\u001b");
		await mounted.result;
	}

	{
		const mounted = mount();
		mounted.component.handleInput("a");
		mounted.component.handleInput("\t");
		await waitFor(() => mounted.component.editor.isShowingAutocomplete(), "Multiple paths must open autocomplete");
		mounted.component.handleInput("\u001b");
		assert.equal(mounted.component.editor.isShowingAutocomplete(), false, "Esc must close autocomplete first");
		assert.equal(mounted.done().called, false, "Esc must not cancel the prompt while autocomplete is open");
		mounted.component.handleInput("\u001b");
		assert.equal(await mounted.result, undefined, "A second Esc must cancel the prompt");
	}

	{
		const mounted = mount("prefilled text");
		assert.equal(mounted.component.editor.getText(), "prefilled text", "Prefill must appear in the editor");
		mounted.component.handleInput("\u001b");
		await mounted.result;
	}

	{
		const mounted = mount();
		mounted.component.handleInput("submit this");
		mounted.component.handleInput("\r");
		assert.equal(await mounted.result, "submit this", "Enter must submit editor text");
	}

	{
		let customCalled = false;
		const value = await showPromptEditor({
			mode: "rpc",
			cwd: fixture,
			ui: {
				custom: () => { customCalled = true; },
				editor: async () => "fallback value",
			},
		}, "Prompt");
		assert.equal(value, "fallback value", "Non-TUI mode must retain ui.editor behavior");
		assert.equal(customCalled, false, "Non-TUI mode must not construct a custom editor");
	}

	const fdPath = resolveFdPath();
	assert.ok(typeof fdPath === "string" || fdPath === null, "fd lookup must never throw");
} finally {
	rmSync(fixture, { recursive: true, force: true });
}

console.log("Prompt editor autocomplete tests passed.");
