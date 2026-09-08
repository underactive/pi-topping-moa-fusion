import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// verificationFindingsOverlay.ts imports the extension UI API, so run this
// assertion script under Node's TS transform before importing it.
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
const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } = await import("@earendil-works/pi-tui");
const { showVerificationFindings } = await import("../src/ui/verificationFindingsOverlay.ts");

initTheme(undefined, false);

// Default keybindings, exercised through the injected manager rather than raw
// hardcoded keys (matching the installed extension UI convention).
const ESC = "\u001b";
const CTRL_C = "\u0003";
const HOME = `${ESC}[H`; // tui.altScreen.top
const END = `${ESC}[F`; // tui.altScreen.bottom
const PAGE_DOWN = `${ESC}[6~`; // tui.select.pageDown
const PAGE_UP = `${ESC}[5~`; // tui.select.pageUp
const ARROW_DOWN = `${ESC}[B`; // tui.select.down
const ARROW_UP = `${ESC}[A`; // tui.select.up

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const fakeTui = { requestRender() {} };
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

const LINE_COUNT = 60;
const FORBIDDEN_APPENDIX = ["Failing project checks", "Project checks", "APPENDIX"];
const longReport = [
	"# Verification findings",
	"",
	"```",
	...Array.from({ length: LINE_COUNT }, (_, i) => `LINE_${i}`),
	"END_OF_REPORT_SENTINEL",
	"```",
	"",
].join("\n");

const wrapParagraph = "This is a deliberately long verifier prose sentence that must re-wrap to a different number of lines depending on the available width of the popup body.";
const wrapReport = `# Verifier report\n\n${Array.from({ length: 15 }, (_, i) => `Paragraph ${i}: ${wrapParagraph}`).join("\n\n")}\n`;

async function mount(report = longReport) {
	let component;
	let closed = 0;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (factory) => {
				component = factory(fakeTui, theme, keybindings, () => { closed++; });
			},
		},
	};
	await showVerificationFindings(ctx, report);
	return { component, closed: () => closed };
}

/** Parse the "N lines" / "A-B/TOTAL" indicator from the rendered title row. */
function totalRenderedLines(component, width) {
	const title = component.render(width)[1];
	const withTotal = title.match(/\/(\d+)\b/);
	if (withTotal) return Number(withTotal[1]);
	const short = title.match(/(\d+) lines/);
	return short ? Number(short[1]) : 0;
}

const previousColumns = process.stdout.columns;
const previousRows = process.stdout.rows;
process.stdout.columns = 200;
process.stdout.rows = 40;

try {
	// Mode guard: no overlay surface outside TUI mode, so nothing is mounted.
	for (const mode of ["cli", "headless", undefined]) {
		let customCalls = 0;
		await showVerificationFindings(
			{ mode, ui: { custom: async () => { customCalls++; } } },
			longReport,
		);
		assert.equal(customCalls, 0, `mode ${JSON.stringify(mode)} must not mount the overlay`);
	}

	// Close actions honor the configured cancel binding (esc and ctrl+c).
	for (const key of [ESC, CTRL_C]) {
		const { component, closed } = await mount();
		component.handleInput(key);
		assert.equal(closed(), 1, `${JSON.stringify(key)} must close the findings popup`);
		component.dispose();
	}

	// PageDown/PageUp scroll a page via the injected keybindings.
	{
		const { component } = await mount();
		component.handleInput(PAGE_DOWN);
		const pageDownDelta = component.scrollOffset;
		assert.ok(pageDownDelta > 0, "PageDown must scroll down");

		component.scrollOffset = 0;
		component.handleInput(PAGE_UP);
		assert.equal(component.scrollOffset, -pageDownDelta, "PageUp mirrors PageDown");
		component.dispose();
	}

	// Line scrolling with the arrow keys.
	{
		const { component } = await mount();
		component.handleInput(ARROW_DOWN);
		assert.equal(component.scrollOffset, 1, "Down arrow scrolls one line down");
		component.handleInput(ARROW_UP);
		assert.equal(component.scrollOffset, 0, "Up arrow scrolls one line up");
		component.dispose();
	}

	// Home/End jump to the extremes (tui.altScreen.top / bottom).
	{
		const { component } = await mount();
		component.handleInput(ARROW_DOWN);
		component.handleInput(HOME);
		assert.equal(component.scrollOffset, 0, "Home jumps to the top");
		component.handleInput(END);
		assert.equal(component.scrollOffset, Number.MAX_SAFE_INTEGER, "End jumps to the bottom");
		component.dispose();
	}

	// The complete original report is accessible — every line, both ends — and
	// nothing beyond it is shown (no synthesized appendix).
	{
		const { component } = await mount();
		const seen = [];
		component.handleInput(HOME);
		for (let i = 0; i < 200; i++) {
			seen.push(...component.render(120));
			component.handleInput(ARROW_DOWN);
		}
		const joined = seen.join("\n");
		for (let i = 0; i < LINE_COUNT; i++) {
			assert.ok(joined.includes(`LINE_${i}`), `LINE_${i} must be reachable by scrolling`);
		}
		assert.ok(joined.includes("END_OF_REPORT_SENTINEL"), "the report's own last line is reachable");
		for (const marker of FORBIDDEN_APPENDIX) {
			assert.ok(!joined.includes(marker), `the popup must not add an appendix (${marker})`);
		}
		component.dispose();
	}

	// Every rendered row keeps a single, consistent frame width, and the whole
	// report renders inside a rounded frame.
	{
		const { component } = await mount();
		for (const width of [120, 80, 50]) {
			const lines = component.render(width);
			const widths = [...new Set(lines.map(visibleWidth))];
			assert.equal(widths.length, 1, `every row shares one width at ${width} columns`);
			assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"), "rounded top border");
			assert.ok(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"), "rounded bottom border");
		}
		component.dispose();
	}

	// Resizing clamps the offset without clipping: End still reaches the last
	// line after the width changes, and offsets stay within bounds.
	{
		const { component } = await mount();
		component.handleInput(END);
		component.render(120); // clamps to the wide layout's bottom
		const narrow = component.render(50); // more wrapped lines than the wide layout
		assert.ok(Number.isInteger(component.scrollOffset) && component.scrollOffset >= 0, "offset stays a valid index after resizing");
		assert.equal([...new Set(narrow.map(visibleWidth))].length, 1, "narrow rows stay a single width");

		component.handleInput(END);
		const narrowBottom = component.render(50);
		assert.ok(narrowBottom.some((line) => line.includes(`LINE_${LINE_COUNT - 1}`)), "the last line stays reachable after resizing");
		component.dispose();
	}

	// Rendering is width-dependent, and invalidate() forces a correct recompute
	// rather than reusing a stale cached layout.
	{
		const { component } = await mount(wrapReport);
		const wideTotal = totalRenderedLines(component, 120);
		const narrowTotal = totalRenderedLines(component, 60);
		assert.ok(narrowTotal > wideTotal, "prose re-wraps to more lines at a narrower width");

		component.invalidate();
		const wideTotalAfter = totalRenderedLines(component, 120);
		assert.equal(wideTotalAfter, wideTotal, "invalidate + re-render reproduces the correct wide layout");
		component.dispose();
	}
} finally {
	process.stdout.columns = previousColumns;
	process.stdout.rows = previousRows;
}

console.log("Verification findings overlay tests passed.");
