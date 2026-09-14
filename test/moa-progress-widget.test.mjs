import assert from "node:assert/strict";

const { MoaProgressWidget, MoaProgressTableComponent, tableColumns } = await import("../src/ui/moaProgressWidget.ts");
const { formatAgentPreview } = await import("../src/ui/agentTranscript.ts");
const { formatCost, formatElapsed, formatTokens, usageBar, contextPercent } = await import("../src/ui/agentStatus.ts");
const { resolveModelCost } = await import("../src/moa/modelRuntime.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const PROPOSERS = [
	{ provider: "anthropic", id: "claude-opus-4" },
	{ provider: "openai", id: "gpt-5" },
];
const SYNTHESIZER = { provider: "google", id: "gemini-3-pro" };
const IMPLEMENTER = { provider: "anthropic", id: "claude-opus-4" };
const VERIFIER = { provider: "openai", id: "gpt-5" };
const CONTEXT_WINDOW = 200_000;
const PLAN_NAME = "voice-transcribe-plan";
const CHEVRONS = new Set(["\u{E0B9}", "\u{E0BB}"]);
/** Width of one band column at render width 100 (body 96, three chevron columns, four phases). */
const BAND_COL = Math.floor((100 - 4 - 3) / 4);
/**
 * A theme stub whose colors are visible in output but cost no columns: SGR 1
 * for text, SGR 2 for dim, SGR 4 for muted, SGR 5 for toolTitle, SGR 6 for
 * accent, SGR 3 for everything else, and a distinct SGR 9/29 bold wrapper.
 * Literal tags would count toward the row width and force truncation.
 */
const TAG_CODES = { text: 1, dim: 2, muted: 4, toolTitle: 5, accent: 6 };
const TAGGED_THEME = {
	fg: (color, text) => `\x1b[${TAG_CODES[color] ?? 3}m${text}\x1b[0m`,
	bold: (text) => `\x1b[9m${text}\x1b[29m`,
};
const TEXT_CELL = (label) => new RegExp(`\\x1b\\[1m *${label} *\\x1b\\[0m`);
const DIM_CELL = (label) => new RegExp(`\\x1b\\[2m *${label} *\\x1b\\[0m`);
const MUTED_PREVIEW = (label) => new RegExp(`\\x1b\\[4m│ ${label}`);
const TOOL_TITLE_CELL = (label) => new RegExp(`\\x1b\\[5m\\x1b\\[9m${label}\\x1b\\[29m\\x1b\\[0m`);
const ACCENT_CELL = (label) => new RegExp(`\\x1b\\[6m${label}\\x1b\\[0m`);

/** Fake ExtensionContext mirroring pi's setExtensionWidget replace/dispose semantics. */
function fakeCtx(mode = "tui", theme = TAGGED_THEME) {
	const state = { widget: undefined, mounts: 0, disposed: 0, order: [] };
	const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } };
	const ctx = {
		mode,
		ui: {
			// pi disposes the widget already registered under a key before
			// installing its replacement, so one key is at most one component.
			setWidget: (_key, factory) => {
				if (state.widget) {
					state.widget.dispose?.();
					state.widget = undefined;
					state.disposed++;
					state.order.push("widgetDisposed");
				}
				if (!factory) return;
				state.widget = factory(tui, theme);
				state.mounts++;
			},
			custom: () => assert.fail("progress surfaces must never open a focus-stealing overlay"),
		},
	};
	return { ctx, state, current: () => state.widget };
}

const assistantMessage = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

/**
 * A theme whose fg escape encodes each ThemeColor as a distinct SGR code, so a
 * rendered MONITOR meter cell can be traced back to the hue it was painted
 * with. Thinking levels map to 90–96; accent — the unknown-level fallback — is
 * 31, and dim (idle cells / the settled-trace wrapper) is 2.
 */
const HUE_CODES = {
	accent: 31, dim: 2, text: 1, success: 32, error: 33,
	thinkingOff: 90, thinkingMinimal: 91, thinkingLow: 92, thinkingMedium: 93,
	thinkingHigh: 94, thinkingXhigh: 95, thinkingMax: 96,
};
const HUE_THEME = { fg: (color, text) => `\x1b[${HUE_CODES[color] ?? 39}m${text}\x1b[0m`, bold: (text) => text };
const THINKING_HUE = { off: 90, minimal: 91, low: 92, medium: 93, high: 94, xhigh: 95, max: 96 };
const BRAILLE_ANY = "⢀⣀⣠⣤⣴⣶⣾⣿";
/** SGR codes painted directly onto each MONITOR braille glyph in a rendered line. */
function meterHueCodes(line) {
	const codes = [];
	const re = /\x1b\[(\d+)m([⠀-⣿])/g;
	let match;
	while ((match = re.exec(line)) !== null) {
		if (BRAILLE_ANY.includes(match[2])) codes.push(Number(match[1]));
	}
	return codes;
}
/** Drive the first `count` rows' meters off idle with a steady high output rate. */
function driveMeters(widget, component, count) {
	let now = 1_000;
	for (let sample = 0; sample < 8; sample++) {
		for (let i = 0; i < count; i++) widget.updateOutput(i, sample * 40, 0);
		component.sampleMeters((now += 100));
	}
}

function makeWidget(mode = "tui", planName = PLAN_NAME) {
	const seen = { closeStacked: 0 };
	const { ctx, state, current } = fakeCtx(mode);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {
		closeStacked: () => {
			seen.closeStacked++;
			state.order.push("closeStacked");
		},
	}, planName);
	return { widget, state, current, seen };
}

// ── cost formatting distinguishes unknown from a zero-cost model ──────────
{
	assert.equal(formatCost(undefined), "—");
	assert.equal(formatCost(0), "$0.000");
	assert.equal(formatCost(0.1234), "$0.123");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(10_300), "10.3k");
	assert.equal(formatTokens(1_250_000), "1.3m");
}

// ── cost uses registry rates and accumulated token usage ──────────────────
{
	const model = { provider: "test", id: "model", cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 } };
	const ctx = { modelRegistry: { find: () => model } };
	const usage = { input: 1_000, output: 2_000, cacheRead: 3_000, cacheWrite: 4_000, cacheWrite1h: 0 };
	assert.equal(resolveModelCost(ctx, { provider: "test", id: "model" }, usage), 0.025);
	assert.equal(resolveModelCost({ modelRegistry: { find: () => undefined } }, { provider: "test", id: "missing" }, usage), undefined);
}

// ── context states distinguish unknown from a reported zero ───────────────
{
	assert.equal(contextPercent(undefined, CONTEXT_WINDOW).trim(), "—");
	assert.equal(usageBar(undefined, CONTEXT_WINDOW), "      [??????????]");
	assert.match(contextPercent(0, CONTEXT_WINDOW), /0\.0%\/200\.0K/);
	assert.equal(usageBar(0, CONTEXT_WINDOW), "  0.0% [░░░░░░░░░░]");
	assert.match(contextPercent(42_000, CONTEXT_WINDOW), /21\.0%\/200\.0K/);
}

// ── progress is a widget, so it works headless and never blocks ───────────
{
	const { widget, state } = makeWidget("print");
	widget.startFanout(PROPOSERS);
	widget.switchToSynthesizing(SYNTHESIZER, "synthesizing plan");
	assert.equal(state.mounts, 1, "every mode takes the same widget path");
	widget.stopWidget();
	assert.equal(state.widget, undefined);
}

// ── fan-out mounts the agent table once and holds it through synthesis ───
{
	const { widget, state, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	assert.equal(state.mounts, 1, "fan-out mounts the widget");
	assert.ok(current() instanceof MoaProgressTableComponent, "fan-out renders the agent table");

	widget.switchToSynthesizing(SYNTHESIZER, "synthesizing plan");
	assert.equal(state.mounts, 1, "synthesis reuses the mounted table rather than remounting");

	widget.stopWidget();
	assert.equal(state.disposed, 1, "stopping disposes the table component, clearing its ticker");
}

// ── table structure ───────────────────────────────────────────────────────
{
	const { widget, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	widget.updateUsage(0, 42_000, 7, 3, 0.123);
	widget.updateActivity(0, 'grep  "handleRequest"');
	widget.updateOutput(0, 1200, 0);
	widget.update(1, "error", "spawn failed");

	const lines = current().render(100).map(strip);
	assert.match(lines[0], /^══ MoA Fusion ═+ voice-transcribe-plan ══$/);
	assert.match(lines[1], /MODEL.*CTX.*MONITOR.*ACTIVITY.*TURNS.*TOOLS.*COST.*TIME/);
	assert.match(lines[2], /── Plan /, "the first phase group carries a heading");
	assert.match(lines.at(-2), /esc cancel · f2 toggle preview · f3 observe/);
	assert.match(lines.at(-1), /^═+$/);
	assert.match(lines.at(-3), /^─+$/, "the footer separator stays single-line");

	const working = lines.find((l) => l.includes("anthropic/claude-opus-4"));
	assert.match(working, /21\.0%/, "context percentage is right-aligned to one decimal");
	assert.match(working, /[⢀⣀⣠⣤⣴⣶⣾⣿]{8}/, "eight monitor cells");
	assert.match(working, /7 {6}3 {4}\$0\.123 {4}0:00 {2}$/, "turns, tool calls, cost, and elapsed are right-justified against the table edge");
	assert.match(working, /exploring/, "the activity status remains visible when the stats block narrows the column");

	const sub = lines.find((l) => l.includes("↳ grep"));
	assert.ok(sub, "live tool activity renders beneath the working row");

	const failed = lines.find((l) => l.includes("openai/gpt-5"));
	assert.match(failed, /✗ openai\/gpt-5/);
	assert.match(failed, /spawn fail/, "error details remain visible when the stats block narrows the column");
	assert.ok(!lines.some((l) => l.includes("↳ ") && l.includes("gpt-5")), "settled rows drop their activity sub-row");
	widget.stopWidget();
}

// ── activity highlighting: dim arrow, bold toolTitle name, accent argument ──
{
	const { ctx, current } = fakeCtx("tui", TAGGED_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {}, PLAN_NAME);
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.updateActivity(0, "read  src/a/very/long/path/to/some/file.ts");
	widget.updateActivity(1, 'grep  "handleRequest"');
	widget.switchToSynthesizing(SYNTHESIZER, "synthesizing");
	widget.updateRoleActivity("Synthesize", "bash  npm test");

	const lines = current().render(140);
	const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const cases = [
		["read  src/a/very/long/path/to/some/file.ts", "read", "src/a/very/long/path/to/some/file.ts"],
		['grep  "handleRequest"', "grep", '"handleRequest"'],
		["bash  npm test", "bash", "npm test"],
	];
	for (const [original, tool, arg] of cases) {
		const line = lines.find((l) => strip(l).includes(`↳ ${original}`));
		assert.ok(line, `activity line for ${JSON.stringify(original)} renders`);
		assert.match(line, /\x1b\[2m↳ \x1b\[0m/, "the gutter arrow is its own dim segment");
		assert.match(line, TOOL_TITLE_CELL(tool), "the tool name is bold and toolTitle-colored");
		assert.match(line, ACCENT_CELL(escapeRegExp(arg)), "the argument is accent-colored");
		assert.equal(strip(line).includes(`↳ ${original}`), true, "stripped text preserves the original activity exactly, including repeated spaces");
	}
	widget.stopWidget();
}

// ── activity highlighting stays aligned and truncates safely across widths ──
{
	const { ctx, current } = fakeCtx("tui", TAGGED_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {}, PLAN_NAME);
	widget.startFanout(PROPOSERS);
	widget.updateActivity(0, "read  src/a/very/long/path/to/some/file.ts");
	widget.updateActivity(1, 'grep  "handleRequest"');
	const component = current();
	for (let width = 20; width <= 140; width++) {
		const rendered = component.render(width);
		const widths = new Set(rendered.map(visibleWidth));
		assert.equal(widths.size, 1, `ragged right edge at width ${width}`);
		assert.ok([...widths][0] <= width, `line overflows at width ${width}`);
	}
	widget.stopWidget();
}

// ── the title bar carries the summarized plan name, until it cannot ───────
{
	const { widget, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	const component = current();

	assert.match(strip(component.render(100)[0]), /═ voice-transcribe-plan ══$/, "the plan name is right-aligned against the edge");

	// Too narrow for both: the name goes, since a cut-off slug names a different plan.
	const narrow = strip(component.render(40)[0]);
	assert.ok(!narrow.includes(PLAN_NAME), "a narrow title bar drops the name instead of truncating it");
	assert.match(narrow, /^══ MoA Fusion ═+$/, "and keeps the title");
	widget.stopWidget();
}

// ── an unnamed run keeps the bare title bar ────────────────────────────
{
	const { ctx, current } = fakeCtx();
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.startFanout(PROPOSERS);
	assert.match(strip(current().render(100)[0]), /^══ MoA Fusion ═+$/);
	widget.stopWidget();
}

// ── opinion flow can override display labels without changing phases ──────
{
	const { ctx, current } = fakeCtx();
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {
		title: "MoA Opinion",
		phaseLabels: { Plan: "Opinion" },
		fanoutWorkingText: "analyzing & answering",
	});
	widget.setPhaseModels({ Plan: PROPOSERS });
	widget.startFanout(PROPOSERS);
	const lines = current().render(140).map(strip);
	assert.match(lines[0], /^══ MoA Opinion ═+$/);
	assert.ok(lines.some((line) => line.includes("── Opinion ")));
	assert.ok(lines.some((line) => line.includes("analyzing & answering")));
	assert.ok(lines.some((line) => line.includes("Opinion")), "the phase band uses the display label");
	widget.stopWidget();
}

// ── preview formatting follows the tail and is bottom-aligned ────────────
{
	assert.deepEqual(
		formatAgentPreview([], assistantMessage("latest words"), 80, 4),
		["", "", "latest words", "(generating…)"],
		"short streaming output is padded above and ends with its generation marker",
	);
	const waiting = formatAgentPreview([], undefined, 80, 4);
	assert.equal(waiting.at(-1), "_(waiting for first response…)_", "empty output carries the waiting placeholder");
	assert.equal(waiting.filter(Boolean).length, 1, "the waiting placeholder is bottom-aligned");

	const tailed = formatAgentPreview(
		[assistantMessage("old output"), assistantMessage("new output with \x1b[31mred\x1b[0m text")],
		undefined,
		18,
		2,
	);
	assert.ok(!tailed.join(" ").includes("\x1b"), "terminal escapes are stripped before wrapping");
	assert.match(tailed.join(" "), /red text/, "the newest wrapped content remains in the tail window");
	assert.ok(tailed.every((line) => visibleWidth(line) <= 18), "every preview line fits its width");
	assert.equal(visibleWidth(formatAgentPreview([assistantMessage("x".repeat(100))], undefined, 12, 1)[0]), 12, "long words are bounded");
}

// ── every rendered line fits its width, at any width ──────────────────────
{
	const { widget, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	widget.updateActivity(0, "read  src/a/very/long/path/to/some/file.ts");
	widget.updateTranscript(0, [assistantMessage(`preview \x1b[31mred\x1b[0m ${"x".repeat(100)}`)]);
	const component = current();
	for (let width = 20; width <= 140; width++) {
		const rendered = component.render(width);
		const widths = new Set(rendered.map(visibleWidth));
		assert.equal(widths.size, 1, `ragged right edge at width ${width}`);
		assert.ok([...widths][0] <= width, `line overflows at width ${width}`);
		assert.ok(!rendered.join("\n").includes("\x1b[31m"), `raw transcript ANSI leaked at width ${width}`);
	}
	widget.stopWidget();
}

// ── working transcripts render four-line, bottom-pinned gutter blocks ────
{
	const { ctx, current } = fakeCtx("tui", TAGGED_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {}, PLAN_NAME);
	widget.startFanout(PROPOSERS);
	widget.updateActivity(0, "read a.ts");
	widget.updateActivity(1, "read b.ts");
	widget.updateTranscript(0, [assistantMessage("first proposer newest")]);
	widget.updateTranscript(1, [assistantMessage("second proposer newest")]);
	const component = current();
	const rendered = component.render(80);
	const lines = rendered.map(strip);
	const first = lines.findIndex((line) => line.includes("anthropic/claude-opus-4"));
	const second = lines.findIndex((line) => line.includes("openai/gpt-5"));
	assert.match(rendered[first], TEXT_CELL("exploring & planning"), "the active activity value uses the text color");
	const firstActivity = lines.findIndex((line, index) => index > first && line.includes("↳ read a.ts"));
	assert.match(lines[firstActivity + 1], /│ /, "the preview follows activity without a blank separator");
	assert.ok(/^ +$/.test(lines[second - 1]), "the preview ends with a blank separator");
	const firstPreviewOutput = rendered.find((line) => line.includes("│ first proposer newest"));
	assert.ok(firstPreviewOutput, "the first preview output renders");
	assert.match(firstPreviewOutput, MUTED_PREVIEW("first proposer newest"), "preview output uses the muted color");
	const firstPreview = lines.slice(first + 1, second).filter((line) => line.includes("│ "));
	const secondPreview = lines.slice(second + 1).filter((line) => line.includes("│ "));
	assert.equal(firstPreview.length, 4, "the first working row receives four preview lines");
	assert.equal(secondPreview.length, 4, "the second working row receives four preview lines");
	assert.match(firstPreview.at(-1), /first proposer newest/, "newest first-agent output is bottom-pinned");
	assert.match(secondPreview.at(-1), /second proposer newest/, "newest second-agent output is bottom-pinned");
	assert.ok(firstPreview.slice(0, -1).every((line) => line.trim() === "│"), "short previews are padded above");

	widget.updateTranscript(0, [assistantMessage(`preview ${"x".repeat(120)}`)]);
	const wideLines = component.render(100).map(strip);
	const wideHeader = wideLines.find((line) => line.includes("MODEL"));
	const widePreview = wideLines.find((line) => line.includes("│ preview"));
	assert.ok(wideHeader && widePreview, "the long preview and full-width header render");
	const statsStart = wideHeader.indexOf("TURNS");
	assert.ok(statsStart >= 0, "the wide table includes the right-aligned stats columns");
	assert.equal(widePreview.slice(statsStart).trim(), "", "live output stops before the stats columns");

	component.tui.terminal.rows = 20;
	const short = component.render(80).map(strip);
	assert.equal(short.filter((line) => line.includes("↳ ")).length, 2, "activity survives before previews");
	assert.equal(short.filter((line) => line.includes("│ ")).length, 3, "preview lines degrade evenly on a short terminal");
	component.tui.terminal.rows = 16;
	const tighter = component.render(80).map(strip);
	assert.equal(tighter.filter((line) => line.includes("↳ ")).length, 2, "all activity survives when previews are dropped");
	assert.equal(tighter.filter((line) => line.includes("│ ")).length, 0, "previews drop after activity");

	component.tui.terminal.rows = 40;
	assert.equal(component.render(20).map(strip).filter((line) => line.includes("│ ")).length, 0, "narrow terminals suppress previews");

	const mutable = assistantMessage("before revision");
	widget.updateTranscript(0, [mutable]);
	assert.match(component.render(80).map(strip).join("\n"), /before revision/);
	mutable.content[0].text = "after revision";
	widget.updateTranscript(0, [mutable]);
	const revised = component.render(80).map(strip).join("\n");
	assert.match(revised, /after revision/, "a revision invalidates cached output even when a message mutates in place");
	assert.ok(!revised.includes("before revision"));

	widget.update(0, "done");
	assert.ok(!component.render(80).map(strip).some((line) => line.includes("first proposer newest")), "settled rows stay compact");
	widget.update(0, "working", "retrying");
	assert.equal(widget.progressRows()[0].transcript, undefined, "retrying clears the previous attempt transcript");
	assert.equal(widget.progressRows()[0].statusText, "retrying", "a working row renders its detail instead of the default working text");
	assert.equal(widget.progressRows()[1].statusText, "exploring & planning", "a working row without detail keeps the default working text");
	widget.update(0, "working");
	assert.equal(widget.progressRows()[0].statusText, "exploring & planning", "clearing the detail restores the default working text");
	widget.stopWidget();
}

// ── F2 toggles live transcript previews without touching activity rows ───
{
	const { ctx, current } = fakeCtx("tui", TAGGED_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {}, PLAN_NAME);
	widget.startFanout(PROPOSERS);
	widget.updateActivity(0, "read a.ts");
	widget.updateActivity(1, "read b.ts");
	widget.updateTranscript(0, [assistantMessage("first proposer newest")]);
	widget.updateTranscript(1, [assistantMessage("second proposer newest")]);
	const component = current();

	assert.equal(widget.previewVisible, true, "previews render by default");
	const initial = component.render(80).map(strip);
	assert.equal(initial.filter((l) => l.includes("↳ read")).length, 2, "both activity rows render before any toggle");
	assert.ok(initial.some((l) => l.includes("│ ")), "preview rows render before any toggle");

	const afterFirstToggle = widget.togglePreview();
	assert.equal(afterFirstToggle, false, "togglePreview reports the new visibility");
	assert.equal(widget.previewVisible, false);
	const hidden = component.render(80).map(strip);
	assert.equal(hidden.filter((l) => l.includes("↳ read")).length, 2, "activity rows survive hiding previews");
	assert.ok(!hidden.some((l) => l.includes("│ ")), "preview rows are hidden after the first toggle");

	const afterSecondToggle = widget.togglePreview();
	assert.equal(afterSecondToggle, true, "a second toggle restores visibility");
	assert.equal(widget.previewVisible, true);
	const restored = component.render(80).map(strip);
	assert.equal(restored.filter((l) => l.includes("↳ read")).length, 2, "activity rows remain after restoring previews");
	assert.ok(restored.some((l) => l.includes("│ first proposer newest")), "the first preview is restored");
	assert.ok(restored.some((l) => l.includes("│ second proposer newest")), "the second preview is restored");
	widget.stopWidget();
}

// ── snapshots recorded while hidden render immediately after togglePreview ──
{
	const { ctx, current } = fakeCtx("tui", TAGGED_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {}, PLAN_NAME);
	widget.startFanout(PROPOSERS);
	widget.updateActivity(0, "read a.ts");
	widget.updateActivity(1, "read b.ts");
	const component = current();

	assert.equal(widget.togglePreview(), false, "preview hidden");
	widget.updateTranscript(0, [assistantMessage("hidden-proposer-0")]);
	widget.updateTranscript(1, [assistantMessage("hidden-proposer-1")]);
	widget.switchToSynthesizing(SYNTHESIZER, "synthesizing");
	widget.updateRoleTranscript("Synthesize", [assistantMessage("hidden-synthesizer")]);

	const hidden = component.render(80).map(strip);
	assert.ok(!hidden.some((line) => line.includes("│ ")), "preview rows stay hidden");

	assert.equal(widget.togglePreview(), true, "preview restored");
	const restored = component.render(80).map(strip);
	assert.ok(restored.some((line) => line.includes("hidden-proposer-0")), "proposer 0 snapshot displays after re-show");
	assert.ok(restored.some((line) => line.includes("hidden-proposer-1")), "proposer 1 snapshot displays after re-show");
	assert.ok(restored.some((line) => line.includes("hidden-synthesizer")), "role snapshot displays after re-show");
	widget.stopWidget();
}

// ── agent rows reserve activity slots, which yield on short terminals ────
{
	const { widget, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	const component = current();
	const blank = (l) => /^ +$/.test(l);

	const initial = component.render(80).map(strip);
	assert.equal(initial.filter(blank).length, PROPOSERS.length, "one reserved activity line below each active agent");
	assert.ok(!blank(initial[2]), "the phase heading is followed by the first agent");
	assert.ok(blank(initial[4]), "the first reserved slot separates the agents");
	assert.ok(blank(initial.at(-4)), "the last slot reserves room for the final agent's activity");

	widget.updateActivity(0, "read  a.ts");
	widget.updateActivity(1, "read  b.ts");
	const roomy = component.render(80).map(strip);
	assert.equal(roomy.length, initial.length, "activity fills the reserved slots without expanding the table");
	assert.equal(roomy.filter(blank).length, 0, "every reserved slot is filled once agents report activity");
	assert.ok(roomy.some((l) => l.includes("↳ read  a.ts")));

	// The reduced budget leaves room for activity but not cosmetic placeholders.
	component.tui.terminal.rows = 14;
	const tight = component.render(80).map(strip);
	assert.equal(tight.filter(blank).length, 0, "cosmetic padding yields first");
	assert.ok(tight.some((l) => l.includes("↳ read  a.ts")), "tool activity outranks padding");
	widget.stopWidget();
}

// ── short terminals drop sub-rows, never agent rows or the footer ─────────
{
	const { widget, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	widget.updateActivity(0, "read  a.ts");
	widget.updateActivity(1, "read  b.ts");
	const component = current();

	assert.equal(component.render(80).filter((l) => strip(l).includes("↳")).length, 2);
	component.tui.terminal.rows = 12;
	const tight = component.render(80).map(strip);
	assert.equal(tight.filter((l) => l.includes("↳")).length, 0, "sub-rows yield first when space is tight");
	assert.ok(tight.some((l) => l.includes("anthropic/claude-opus-4")));
	assert.ok(tight.some((l) => l.includes("openai/gpt-5")));
	assert.ok(tight.some((l) => l.includes("esc cancel · f2 toggle preview · f3 observe")), "footer must survive");
	widget.stopWidget();
}

// ── fan-out → synthesis keeps one overlay and appends the synthesizer ─────
{
	const { widget, state, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	const fanoutComponent = current();
	widget.updateOutput(0, 10_300, 0);
	widget.update(0, "done");
	widget.update(1, "done");

	widget.switchToSynthesizing(SYNTHESIZER, "adjudicating proposed plans");
	assert.equal(state.mounts, 1, "synthesis must reuse the fan-out table");
	assert.equal(current(), fanoutComponent);

	widget.updateRoleUsage("Synthesize", 10_000, 2, 1, 0.456);
	const lines = current().render(100).map(strip);
	assert.ok(lines.some((l) => l.includes("✓ anthropic/claude-opus-4")), "proposer rows are retained");
	assert.match(widget.progressRows()[0].statusText, /^done \(10\.3k tokens\)$/);
	const wideLines = current().render(140).map(strip);
	assert.ok(wideLines.some((l) => l.includes("✓ anthropic/claude-opus-4") && l.includes("done (10.3k tokens)")), "completed rows show their output-token count");
	assert.ok(lines.some((l) => l.includes("google/gemini-3-pro") && l.includes("adjudicati")), "the synthesizer status remains visible within the activity column");
	assert.ok(lines.some((l) => l.includes("── Synthesize")), "the synthesis phase group carries its own heading");
	widget.stopWidget();
}

// ── a synthesis round after a user prompt remounts the table ─────────────
{
	const { widget, state, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	widget.stopWidget();
	assert.equal(state.widget, undefined, "stopWidget removes the widget");
	assert.equal(state.disposed, 1, "removal disposes the component (clearing its timer)");

	widget.switchToSynthesizing(SYNTHESIZER, "synthesizing plan");
	assert.equal(state.mounts, 2, "a synthesis round after a prompt remounts");
	assert.ok(current().render(100).some((l) => strip(l).includes("google/gemini-3-pro")));

	widget.stopWidget();
	widget.stopWidget();
	assert.equal(state.widget, undefined, "stopWidget is idempotent");
	assert.equal(state.mounts, 2, "a redundant stop must not remount");
}

// ── the cancel/observe overlays never outlive the run they report on ──────
{
	const { widget, state, seen } = makeWidget();
	widget.startFanout(PROPOSERS);
	widget.stopWidget();
	assert.deepEqual(state.order, ["closeStacked", "widgetDisposed"]);

	widget.stopWidget();
	assert.equal(seen.closeStacked, 1, "a stop with no table up must not disturb other overlays");
}

// ── meters: freeze when settled, reset when exact usage supersedes ────────
{
	const { widget, current } = makeWidget();
	widget.startFanout(PROPOSERS);
	const component = current();
	const LEVELS = "⢀⣀⣠⣤⣴⣶⣾⣿";
	const meterOf = (lines, label) => strip(lines.find((l) => l.includes(label))).match(/[⢀⣀⣠⣤⣴⣶⣾⣿]{8}/)[0];

	let now = 1_000;
	for (let i = 0; i < 8; i++) {
		widget.updateOutput(0, i * 20, 0);
		widget.updateOutput(1, i * 20, 0);
		component.sampleMeters((now += 100));
	}
	const busy = meterOf(component.render(100), "anthropic/claude-opus-4");
	// Cells scroll in from the right, so the last cell is the most recent sample.
	const newest = (label) => LEVELS.indexOf(meterOf(component.render(100), label)[7]);
	const peak = newest("openai/gpt-5");
	assert.notEqual(busy, "⢀".repeat(8), "generation must move the meter off idle");

	widget.update(0, "done");
	for (let i = 0; i < 20; i++) component.sampleMeters((now += 100));
	assert.equal(meterOf(component.render(100), "anthropic/claude-opus-4"), busy, "settled rows keep their final trace");
	assert.ok(newest("openai/gpt-5") < peak, "a working row that stops generating decays");

	// An exact-usage correction jumps the cumulative total; the revision bump
	// must reset the tracker so the jump isn't metered as real generation.
	widget.updateOutput(1, 50_000, 1);
	component.sampleMeters((now += 100));
	assert.equal(newest("openai/gpt-5"), 0, "revision change must reset the rate tracker");
	widget.stopWidget();
}

// ── column layout shrinks agent and activity, in that order ──────────────
{
	const labels = ["anthropic/claude-opus-4-20250514"];
	const wide = tableColumns(120, labels);
	assert.equal(wide.agent, visibleWidth(labels[0]), "a wide table seats the whole model ref rather than capping it");
	assert.ok(wide.stats, "and keeps the elapsed/turns columns");
	assert.ok(wide.activity > 20, "the widened stats block still leaves a usable activity column");

	const narrow = tableColumns(60, labels);
	assert.ok(!narrow.stats, "elapsed/turns drop out before the agent name is squeezed to a stub");
	assert.ok(narrow.agent < wide.agent, "agent column shrinks before activity is starved");
	assert.ok(narrow.activity >= 10);

	const tiny = tableColumns(28, labels);
	assert.equal(tiny.activity, 0, "the activity column drops out entirely when there is no room");
	assert.ok(tiny.agent >= 1);
}

// ── elapsed freezes on settle, and minutes never roll into an hours field ─
{
	assert.equal(formatElapsed(0), "0:00");
	assert.equal(formatElapsed(9_000), "0:09");
	assert.equal(formatElapsed(61_500), "1:01");
	assert.equal(formatElapsed(3_723_000), "62:03");

	const { widget } = makeWidget();
	widget.startFanout(PROPOSERS);
	widget.update(0, "done");
	const before = widget.progressRows();
	await new Promise((resolve) => setTimeout(resolve, 25));
	const after = widget.progressRows();
	assert.equal(after[0].elapsedMs, before[0].elapsedMs, "a settled agent freezes its elapsed reading");
	assert.ok(after[1].elapsedMs > before[1].elapsedMs, "a working agent keeps ticking");
	widget.stopWidget();
}

// ── phase band: all four phases with chevrons at matching columns ─────────
{
	const { ctx, current } = fakeCtx("tui", TAGGED_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.setPhaseModels({ Plan: PROPOSERS, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER, Verify: VERIFIER });
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.queueRoleRow("Implement", IMPLEMENTER);
	widget.queueRoleRow("Verify", VERIFIER);

	const lines = current().render(100);
	assert.match(strip(lines[1]), /Plan.*Synthesize.*Implement.*Verify/, "the band names every phase in order");
	assert.match(strip(lines[2]), /opus.*gemini.*opus.*gpt/, "the band names each phase's model compactly");
	assert.equal(strip(lines[3]), "─".repeat(100), "the band closes with a rule");

	// The four phase cells fill the body: 4 cells + 3 chevrons across the body.
	const chevronIndices = (line) => [...strip(line)]
		.map((ch, i) => ({ ch, i }))
		.filter(({ ch }) => CHEVRONS.has(ch))
		.map(({ i }) => i);
	assert.equal(chevronIndices(lines[1]).length, 3, "three chevrons divide the four phases");
	assert.deepEqual(chevronIndices(lines[1]), chevronIndices(lines[2]), "the chevron halves land in the same columns on both band rows");
	assert.equal(visibleWidth(lines[1]), 100, "the band fills the row exactly");

	// Fan-out sets the active phase to Plan, which renders in the text tone
	// while every other phase stays dim.
	assert.match(lines[1], TEXT_CELL("Plan"), "only the active phase highlights");
	assert.match(lines[1], DIM_CELL("Synthesize"), "inactive phases stay dim");
	assert.match(lines[1], DIM_CELL("Verify"), "inactive phases stay dim");
	widget.stopWidget();
}

// ── phase band: the active phase shimmers only with truecolor themes ──────
{
	const theme = {
		fg: (color, text) => `\x1b[${TAG_CODES[color] ?? 3}m${text}\x1b[0m`,
		bold: (text) => `\x1b[9m${text}\x1b[29m`,
		getFgAnsi: (color) => (color === "dim" ? "\x1b[38;2;20;30;40m" : "\x1b[38;2;120;130;140m"),
	};
	const { ctx, current } = fakeCtx("tui", theme);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.setPhaseModels({ Plan: PROPOSERS, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER, Verify: VERIFIER });
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.queueRoleRow("Implement", IMPLEMENTER);
	widget.queueRoleRow("Verify", VERIFIER);
	widget.setActivePhase("Implement");

	// The shimmer colors every character it is handed, so one escape per column
	// of the active cell, plus one per chevron touching it.
	const escapes = (line) => (line.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length;
	const band = current().render(100);
	assert.equal(escapes(band[1]), BAND_COL + 2, "the active phase cell and both adjacent chevrons shimmer on the name row");
	assert.equal(escapes(band[2]), BAND_COL + 2, "the active phase cell and both adjacent chevrons shimmer on the model row");
	assert.ok(!/\x1b\[38;2;[\d;]+m *Plan/.test(band[1]), "inactive phases do not shimmer");

	// Moving the highlight moves the shimmer to the new cell only. The last
	// phase has a single neighbouring chevron.
	widget.setActivePhase("Verify");
	const moved = current().render(100);
	assert.equal(escapes(moved[1]), BAND_COL + 1, "Verify plus the one chevron touching it");
	assert.equal(escapes(moved[2]), BAND_COL + 1, "its model cell plus the same chevron");
	assert.ok(!/\x1b\[38;2;[\d;]+m *Implement/.test(moved[1]), "the previously active phase stops shimmering");
	widget.stopWidget();
}

// ── phase band: flat fallback when the theme has no getFgAnsi ─────────────
{
	const { ctx, current } = fakeCtx("tui", TAGGED_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.setPhaseModels({ Plan: PROPOSERS, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER, Verify: VERIFIER });
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.queueRoleRow("Implement", IMPLEMENTER);
	widget.queueRoleRow("Verify", VERIFIER);
	widget.setActivePhase("Implement");

	const lines = current().render(100);
	assert.equal((lines[1].match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length, 0, "no shimmer escapes without getFgAnsi");
	assert.match(lines[1], TEXT_CELL("Implement"), "the active phase falls back to its flat text tone");
	assert.match(lines[1], DIM_CELL("Plan"), "inactive phases stay dim");
	widget.stopWidget();
}

// ── phase band: suppressed for narrow columns or unknown models ───────────
{
	const { ctx, current } = fakeCtx();
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.setPhaseModels({ Plan: PROPOSERS, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER, Verify: VERIFIER });
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.queueRoleRow("Implement", IMPLEMENTER);
	widget.queueRoleRow("Verify", VERIFIER);

	// A 40-column terminal gives each band column only 8 visible columns,
	// under the 12-column floor.
	const narrow = current().render(40).map(strip);
	assert.match(narrow[1], /MODEL/, "below the width floor the band yields and the header moves up");
	assert.ok(!narrow.some((l) => l.includes("Synthesize") && l.includes("Verify")), "no band row is drawn");

	// No models seeded: the band has nothing to name, so it stays hidden.
	const bare = fakeCtx();
	const unnamed = new MoaProgressWidget(bare.ctx, () => CONTEXT_WINDOW);
	unnamed.startFanout(PROPOSERS);
	const bareLines = bare.current().render(100).map(strip);
	assert.match(bareLines[1], /MODEL/, "with no phase models the band is suppressed");
	widget.stopWidget();
	unnamed.stopWidget();
}

// ── phase band: the Plan cell joins proposer names, falling back to a count ─
{
	const MANY = Array.from({ length: 5 }, () => ({ provider: "anthropic", id: "claude-opus-4" }));
	const { ctx, current } = fakeCtx();
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.setPhaseModels({ Plan: MANY, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER, Verify: VERIFIER });
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.queueRoleRow("Implement", IMPLEMENTER);
	widget.queueRoleRow("Verify", VERIFIER);

	const modelRow = strip(current().render(100)[2]);
	assert.match(modelRow, /5 proposers/, "over-crowded proposer names collapse to a count");
	widget.stopWidget();
}

// ── phase grouping: queued rows render dim under their own headings ───────
{
	const { widget, current } = makeWidget();
	widget.setPhaseModels({ Plan: PROPOSERS, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER, Verify: VERIFIER });
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.queueRoleRow("Implement", IMPLEMENTER);
	widget.queueRoleRow("Verify", VERIFIER);

	const lines = current().render(100).map(strip);
	const indexOf = (text) => lines.findIndex((l) => l.includes(text));
	assert.ok(indexOf("── Plan ") < indexOf("── Synthesize "), "headings render in phase order");
	assert.ok(indexOf("── Synthesize ") < indexOf("── Implement "), "headings render in phase order");
	assert.ok(indexOf("── Implement ") < indexOf("── Verify "), "headings render in phase order");

	const queuedSynth = lines.find((l) => l.includes("google/gemini-3-pro"));
	assert.ok(queuedSynth, "the queued synthesizer row renders before it starts");
	assert.match(queuedSynth, /○/);
	assert.match(queuedSynth, /queued/);
	assert.ok(!queuedSynth.includes("◐") && !queuedSynth.includes("◓"), "queued rows carry no spinner");
	widget.stopWidget();
}

// ── phase switching: each role row lands under the correct heading ────────
{
	const { widget, current } = makeWidget();
	widget.setPhaseModels({ Plan: PROPOSERS, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER, Verify: VERIFIER });
	widget.startFanout(PROPOSERS);
	widget.queueRoleRow("Synthesize", SYNTHESIZER);
	widget.queueRoleRow("Implement", IMPLEMENTER);
	widget.queueRoleRow("Verify", VERIFIER);
	widget.update(0, "done");
	widget.update(1, "done");

	widget.switchToSynthesizing(SYNTHESIZER, "adjudicating proposed plans");
	widget.switchToImplementing(IMPLEMENTER, "implementing plan");
	widget.switchToVerifying(VERIFIER, "verifying implementation");

	// Wide enough that the status column shows each role's full status text.
	const lines = current().render(140).map(strip);
	const indexOf = (text) => {
		const index = lines.findIndex((l) => l.includes(text));
		assert.notEqual(index, -1, `expected a rendered line containing ${JSON.stringify(text)}`);
		return index;
	};
	assert.ok(indexOf("── Plan ") < indexOf("✓ anthropic/claude-opus-4"), "the proposer sits under Plan");
	assert.ok(indexOf("── Synthesize ") < indexOf("adjudicating proposed plans"), "the synthesizer sits under Synthesize");
	assert.ok(indexOf("── Implement ") < indexOf("implementing plan"), "the implementer sits under Implement");
	assert.ok(indexOf("── Verify ") < indexOf("verifying implementation"), "the verifier sits under Verify");
	assert.ok(
		indexOf("✓ anthropic/claude-opus-4") < indexOf("── Synthesize ") &&
		indexOf("adjudicating proposed plans") < indexOf("── Implement ") &&
		indexOf("implementing plan") < indexOf("── Verify "),
		"phase groups render in Plan → Synthesize → Implement → Verify order",
	);
	assert.equal(lines[indexOf("implementing plan")].includes("✓"), false, "the working implementer row spins rather than ticks");
	assert.ok(widget.progressRows().every((row) => !/[.…]$/.test(row.statusText)), "status labels do not end with ellipses");

	// Settling a role row freezes it with a tick under its own heading. The
	// verifier shares a model ref with a proposer, so look below the heading.
	widget.updateRoleOutput("Verify", 10_300, 0);
	widget.settleRoleRow("Verify", "done");
	const settled = current().render(140).map(strip);
	const verifyRow = settled[settled.findIndex((l) => l.includes("── Verify ")) + 1];
	assert.match(verifyRow, /✓ openai\/gpt-5/, "the settled verifier row shows a tick");
	assert.match(verifyRow, /done \(10\.3k tokens\)/);
	widget.stopWidget();
}

// ── role rows: working keeps the clock, settled restarts and clears ───────
{
	const { widget } = makeWidget();
	widget.startFanout(PROPOSERS);
	widget.switchToSynthesizing(SYNTHESIZER, "first pass");
	widget.updateRoleUsage("Synthesize", 1_000, 3, 2, 0.1);
	const rowOf = () => widget.progressRows().find((r) => r.phase === "Synthesize");

	const first = rowOf();
	await new Promise((resolve) => setTimeout(resolve, 25));
	widget.switchToSynthesizing(SYNTHESIZER, "second pass");
	const second = rowOf();
	assert.equal(second.contextTokens, 1_000, "working → working keeps telemetry");
	assert.equal(second.turns, 3, "working → working keeps turn telemetry");
	assert.ok(second.elapsedMs > first.elapsedMs, "working → working keeps the clock running");

	widget.settleRoleRow("Synthesize", "done");
	await new Promise((resolve) => setTimeout(resolve, 25));
	widget.switchToSynthesizing(SYNTHESIZER, "third pass");
	const third = rowOf();
	assert.equal(third.contextTokens, undefined, "settled → working clears context telemetry");
	assert.equal(third.turns, 0, "settled → working clears turn telemetry");
	assert.ok(third.elapsedMs < 60, "settled → working restarts the clock");
	widget.stopWidget();
}

// ── MONITOR meter: each row is tinted by its thinking level's native hue ──
{
	const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const refs = LEVELS.map((lvl, i) => ({ provider: "p", id: `slot${i}-${lvl}` }));
	const { ctx, current } = fakeCtx("tui", HUE_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.startFanout(refs, LEVELS);
	const component = current();
	driveMeters(widget, component, refs.length);

	const lines = component.render(120);
	for (let i = 0; i < LEVELS.length; i++) {
		const lvl = LEVELS[i];
		const line = lines.find((l) => strip(l).includes(`slot${i}-${lvl}`));
		assert.ok(line, `the ${lvl} row renders`);
		const codes = meterHueCodes(line);
		assert.ok(codes.includes(THINKING_HUE[lvl]), `the ${lvl} meter uses its native ${THINKING_HUE[lvl]} hue`);
		assert.ok(!codes.includes(31), `the ${lvl} meter never falls back to accent`);
	}
	widget.stopWidget();
}

// ── MONITOR meter: an unknown thinking level falls back to accent ─────────
{
	const { ctx, current } = fakeCtx("tui", HUE_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.startFanout([{ provider: "p", id: "unknown-level" }]); // no thinking supplied
	const component = current();
	driveMeters(widget, component, 1);

	const line = component.render(120).find((l) => strip(l).includes("unknown-level"));
	const codes = meterHueCodes(line);
	assert.ok(codes.includes(31), "an unknown level paints the meter with accent (31)");
	assert.ok(!codes.some((code) => code >= 90 && code <= 96), "and never with a thinking hue");
	widget.stopWidget();
}

// ── MONITOR meter: the same model in two slots keeps distinct hues ────────
{
	const SAME = { provider: "anthropic", id: "claude-opus-4" };
	const { ctx, current } = fakeCtx("tui", HUE_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.startFanout([SAME, SAME], ["low", "max"]);
	const component = current();
	driveMeters(widget, component, 2);

	const meterLines = component.render(120)
		.filter((l) => strip(l).includes("claude-opus-4") && [...strip(l)].some((ch) => BRAILLE_ANY.includes(ch)));
	assert.equal(meterLines.length, 2, "both same-model rows render a meter");
	assert.ok(meterHueCodes(meterLines[0]).includes(92), "the first slot keeps its low hue");
	assert.ok(meterHueCodes(meterLines[1]).includes(96), "the second slot keeps its max hue — proving the level is stored per row, not per model");
	widget.stopWidget();
}

// ── MONITOR meter: a settled row keeps its hue under trace dimming ────────
{
	const refs = [{ provider: "p", id: "settle-high" }, { provider: "p", id: "still-low" }];
	const { ctx, current } = fakeCtx("tui", HUE_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.startFanout(refs, ["high", "low"]);
	const component = current();
	driveMeters(widget, component, 2);
	widget.update(0, "done");
	for (let sample = 0, now = 3_000; sample < 4; sample++) component.sampleMeters((now += 100));

	const line = component.render(120).find((l) => strip(l).includes("settle-high"));
	assert.ok(meterHueCodes(line).includes(94), "a settled row keeps its thinking hue on its frozen trace");
	// The settled trace is dimmed: its coloured cells are wrapped in SGR 2 … 22,
	// so the hue escape sits inside the dim wrapper rather than being replaced.
	assert.match(line, /\x1b\[2m\x1b\[94m[\u2840-\u28ff]/, "settled meter cells stay dimmed under their hue");
	widget.stopWidget();
}

// ── MONITOR meter: idle cells stay dim even under a thinking hue ──────────
{
	const { ctx, current } = fakeCtx("tui", HUE_THEME);
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
	widget.startFanout([{ provider: "p", id: "high-row" }], ["high"]);
	const component = current();
	// One idle baseline sample then seven generating samples leaves the leading
	// meter cell idle while the rest take the hue.
	driveMeters(widget, component, 1);

	const line = component.render(120).find((l) => strip(l).includes("high-row"));
	const codes = meterHueCodes(line);
	assert.ok(codes.includes(94), "generating cells take the high hue");
	assert.ok(codes.includes(2), "the leading idle cell is rendered dim, not tinted");
	// The idle glyph (⢀, U+2840) carries the dim escape; the hue never paints it.
	assert.match(line, /\x1b\[2m\u2880/, "an idle MONITOR cell stays dim under a hued row");
	assert.doesNotMatch(line, /\x1b\[94m\u2880/, "the thinking hue is never applied to an idle cell");
	widget.stopWidget();
}

// ── MONITOR meter: the thinking level is stored per row across the lifecycle ─
{
	const { widget } = makeWidget();
	widget.startFanout(PROPOSERS, ["low", "high"]);
	const planLevels = () => widget.progressRows().filter((r) => r.phase === "Plan").map((r) => r.thinking);
	assert.deepEqual(planLevels(), ["low", "high"], "proposer levels are stored per slot");

	const synthLevel = () => widget.progressRows().find((r) => r.phase === "Synthesize").thinking;
	widget.queueRoleRow("Synthesize", SYNTHESIZER, "medium");
	assert.equal(synthLevel(), "medium", "a queued row stores its level before activation");

	widget.switchToSynthesizing(SYNTHESIZER, "first", "max");
	assert.equal(synthLevel(), "max", "activation stores the supplied level");
	widget.settleRoleRow("Synthesize", "done");
	assert.equal(synthLevel(), "max", "settling preserves the hue metadata");

	widget.switchToSynthesizing(SYNTHESIZER, "second", "low");
	assert.equal(synthLevel(), "low", "a known → known re-activation swaps to the new level");
	widget.switchToSynthesizing(SYNTHESIZER, "third");
	assert.equal(synthLevel(), undefined, "a known → unknown re-activation clears the stale hue to the accent fallback");
	widget.stopWidget();
}

console.log("MoA progress widget tests passed.");
