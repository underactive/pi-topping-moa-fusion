import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], { stdio: "inherit" });
	} catch (error) {
		process.exit(error.status ?? 1);
	}
	process.exit(0);
}

const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { showCancelOverlay } = await import("../src/ui/cancelOverlay.ts");
const { showObserveOverlay } = await import("../src/ui/observeOverlay.ts");
const { showConflictReview } = await import("../src/ui/conflictOverlay.ts");
const { showPlanReview } = await import("../src/ui/planReviewOverlay.ts");
const { showVerificationFindings } = await import("../src/ui/verificationFindingsOverlay.ts");

initTheme(undefined, false);
const previousColumns = process.stdout.columns;
const previousRows = process.stdout.rows;
process.stdout.columns = 120;
process.stdout.rows = 40;

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};
const tui = { requestRender() {}, terminal: { columns: 120, rows: 40 } };

function assertRoundedFrame(component, label) {
	const lines = component.render(80);
	assert.equal(lines[0], `╭${"─".repeat(74)}╮`, `${label} top border`);
	assert.equal(lines.at(-1), `╰${"─".repeat(74)}╯`, `${label} bottom border`);
	assert.ok(lines.some((line) => line === `├${"─".repeat(74)}┤`), `${label} separator`);
	assert.deepEqual([...new Set(lines.map(visibleWidth))], [76], `${label} rows keep one frame width`);
}

try {
	let cancelComponent;
	await showCancelOverlay({
		mode: "tui",
		ui: { custom: async (factory) => { cancelComponent = factory(tui, theme, {}, () => {}); } },
	}, {
		title: "MoA fan-out",
		run: { agents: [{ label: "test/model", state: "running" }] },
		overlayOpen: true,
	});
	assertRoundedFrame(cancelComponent, "cancel");
	cancelComponent.dispose();

	let observeComponent;
	await showObserveOverlay({
		mode: "tui",
		ui: { custom: async (factory) => { observeComponent = factory(tui, theme, {}, () => {}); } },
	}, {
		title: "MoA fan-out",
		phase: "fanout",
		agents: [{ label: "Proposer 1", model: "test/model", task: "test task", messages: [], state: "working" }],
		overlayOpen: true,
	});
	assertRoundedFrame(observeComponent, "observe");
	observeComponent.dispose();

	let conflictComponent;
	await showConflictReview({
		mode: "tui",
		ui: { custom: async (factory) => { conflictComponent = factory(tui, theme, {}, () => {}); } },
	}, [{
		id: "conflict-1",
		label: "Storage",
		prompt: "Choose storage.",
		options: [{ value: "cookies", label: "Cookies (Recommended)", description: "Keep sessions secure.", recommended: true }],
	}]);
	assertRoundedFrame(conflictComponent, "conflict");
	conflictComponent.dispose();

	let planComponent;
	await showPlanReview({
		cwd: process.cwd(),
		ui: { custom: async (factory) => { planComponent = factory(tui, theme, {}, () => {}); } },
	}, "# Plan\n\n1. Keep behavior unchanged.");
	assertRoundedFrame(planComponent, "plan review");
	planComponent.dispose();

	let findingsComponent;
	await showVerificationFindings({
		mode: "tui",
		ui: { custom: async (factory) => { findingsComponent = factory(tui, theme, {}, () => {}); } },
	}, "# Verification findings\n\n- Every step landed.");
	assertRoundedFrame(findingsComponent, "verification findings");
	findingsComponent.dispose();
} finally {
	process.stdout.columns = previousColumns;
	process.stdout.rows = previousRows;
}

console.log("Overlay chrome parity tests passed.");
