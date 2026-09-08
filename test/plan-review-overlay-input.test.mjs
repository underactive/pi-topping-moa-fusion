import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// planReviewOverlay.ts uses TypeScript parameter properties, so execute this
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

const { showPlanReview } = await import("../src/ui/planReviewOverlay.ts");

async function mountPlanReview(planMarkdown = "# Plan\n\nSome content.", moaInfo) {
	let component;
	let decision;
	const ctx = {
		cwd: process.cwd(),
		ui: {
			custom: async (factory) => {
				component = factory({ requestRender: () => {} }, {}, undefined, (value) => { decision = value; });
			},
		},
	};

	await showPlanReview(ctx, planMarkdown, moaInfo);
	return { component, decision: () => decision };
}

// `d` must page down by the same amount as the canonical PageDown escape sequence.
{
	const { component } = await mountPlanReview();
	component.handleInput("\u001b[6~"); // PageDown
	const pageDownDelta = component.scrollOffset;
	assert.ok(pageDownDelta > 0, "PageDown must scroll down");

	component.scrollOffset = 0;
	component.handleInput("d");
	assert.equal(component.scrollOffset, pageDownDelta, "'d' must page down by the same amount as PageDown");
}

// `u` must page up by the same amount as the canonical PageUp escape sequence.
{
	const { component } = await mountPlanReview();
	component.handleInput("\u001b[5~"); // PageUp
	const pageUpDelta = component.scrollOffset;
	assert.ok(pageUpDelta < 0, "PageUp must scroll up (negative offset)");

	component.scrollOffset = 0;
	component.handleInput("u");
	assert.equal(component.scrollOffset, pageUpDelta, "'u' must page up by the same amount as PageUp");
}

// `v` must toggle the verdicts view, and any explicit tab choice must leave it.
{
	const ref = { provider: "test", id: "model-x" };
	const moaInfo = {
		proposers: [ref],
		synthesizer: ref,
		proposerPlans: [{ proposerIndex: 0, model: ref, markdown: "## Plan\n1. p1" }],
		verdictsMarkdown: "## Proposer Verdicts\n\n- **Proposer 1:** adopted — core of the plan.",
	};
	const { component } = await mountPlanReview(undefined, moaInfo);

	component.handleInput("v");
	assert.equal(component.showVerdicts, true, "'v' opens the verdicts view");
	component.handleInput("v");
	assert.equal(component.showVerdicts, false, "'v' toggles back to the plan");

	component.handleInput("v");
	component.handleInput("1");
	assert.equal(component.showVerdicts, false, "picking a proposer tab leaves the verdicts view");
	assert.equal(component.activeProposerIndex, 0);

	component.handleInput("v");
	assert.equal(component.activeProposerIndex, undefined, "verdicts view clears the proposer tab");
	component.handleInput("0");
	assert.equal(component.showVerdicts, false, "'0' returns to the synthesized plan");
}

// Without verdicts, `v` must be inert rather than blanking the view.
{
	const { component } = await mountPlanReview();
	component.handleInput("v");
	assert.equal(component.showVerdicts, false, "'v' is a no-op when no verdicts exist");
}

console.log("Plan review overlay input tests passed.");
