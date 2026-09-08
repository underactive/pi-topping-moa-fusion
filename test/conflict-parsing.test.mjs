import assert from "node:assert/strict";

const { parseConflicts } = await import("../src/moa/conflicts.ts");

// ── No ## Conflicts section at all: passthrough ─────────────────────────────
{
	const plan = "## Context\n\nSomething.\n\n## Plan\n1. Do it.\n";
	const { conflicts, remainingPlan } = parseConflicts(plan);
	assert.deepEqual(conflicts, []);
	// Passthrough when there's no ## Conflicts section at all: verbatim output, untrimmed.
	assert.equal(remainingPlan, plan);
}

// ── One conflict, one alternative ───────────────────────────────────────────
{
	const plan = [
		"## Context",
		"",
		"Blah.",
		"",
		"## Plan",
		"1. Step one.",
		"",
		"## Conflicts",
		"",
		"### Conflict: Auth storage",
		"",
		"- **Decision:** Choose where sign-in information is stored because it affects security and the current sign-in flow.",
		"- **Recommended:** Keep the current sign-in experience",
		"- **Details:** Store session IDs in `Secure`, `HttpOnly` cookies so existing `authMiddleware` stays compatible and page scripts cannot read them.",
		"- **Alternative** (Proposer 2): Make sign-in data available to browser code",
		"- **Details:** Store JWTs in `localStorage`; this simplifies cross-service access but lets injected page scripts read the token.",
		"",
	].join("\n");
	const { conflicts, remainingPlan } = parseConflicts(plan);
	assert.equal(conflicts.length, 1);
	const c = conflicts[0];
	assert.equal(c.label, "Auth storage");
	assert.equal(c.prompt, "Choose where sign-in information is stored because it affects security and the current sign-in flow.");
	assert.equal(c.options.length, 3); // recommended + 1 alternative + chat
	assert.equal(c.options[0].recommended, true);
	assert.equal(c.options[0].label, "Keep the current sign-in experience (Recommended)");
	assert.equal(c.options[0].description, "Store session IDs in `Secure`, `HttpOnly` cookies so existing `authMiddleware` stays compatible and page scripts cannot read them.");
	assert.equal(c.options[1].proposerLabel, "Proposer 2");
	assert.equal(c.options[1].label, "Make sign-in data available to browser code");
	assert.equal(c.options[1].description, "Store JWTs in `localStorage`; this simplifies cross-service access but lets injected page scripts read the token.");
	assert.equal(c.options[2].value, "__chat__");
	assert.doesNotMatch(remainingPlan, /## Conflicts/);
	assert.match(remainingPlan, /## Plan/);
	assert.match(remainingPlan, /1\. Step one\./);
}

// ── Multiple conflicts in one section ───────────────────────────────────────
{
	const plan = [
		"## Context",
		"",
		"## Conflicts",
		"",
		"### Conflict: Auth storage",
		"- **Decision:** Choose where sign-in information is stored because it affects security.",
		"- **Recommended:** Keep the current sign-in experience",
		"- **Details:** Use the existing `sessionCookie` middleware path.",
		"- **Alternative** (Proposer 1): Make sign-in data available to browser code",
		"- **Details:** Persist a JWT in `localStorage`.",
		"",
		"### Conflict: State management",
		"- **Decision:** Choose how shared information is managed because it affects future changes.",
		"- **Recommended:** Use one shared state system",
		"- **Details:** Keep the existing Redux store and selector layer.",
		"- **Alternative** (Proposer 2): Use the framework's built-in sharing",
		"- **Details:** Replace Redux with the Context API.",
		"- **Alternative** (Proposer 3): Use a smaller state library",
		"- **Details:** Replace Redux with Zustand.",
	].join("\n");
	const { conflicts } = parseConflicts(plan);
	assert.equal(conflicts.length, 2);
	assert.equal(conflicts[0].label, "Auth storage");
	assert.equal(conflicts[0].prompt, "Choose where sign-in information is stored because it affects security.");
	assert.equal(conflicts[1].label, "State management");
	assert.equal(conflicts[1].prompt, "Choose how shared information is managed because it affects future changes.");
	assert.equal(conflicts[0].options[1].description, "Persist a JWT in `localStorage`.");
	assert.equal(conflicts[1].options[0].description, "Keep the existing Redux store and selector layer.");
	assert.equal(conflicts[1].options[1].description, "Replace Redux with the Context API.");
	assert.equal(conflicts[1].options[2].description, "Replace Redux with Zustand.");
	assert.equal(conflicts[1].options.length, 4); // recommended + 2 alternatives + chat
}

// ── Explicit Details override legacy em-dash reasons ────────────────────────
{
	const plan = [
		"## Conflicts",
		"",
		"### Conflict: Preview behavior",
		"- **Recommended:** Keep the current behavior — legacy fallback reason",
		"- **Details:** Return `PreviewResult` with `nextRefreshInMs` for the existing polling path.",
	].join("\n");
	const { conflicts } = parseConflicts(plan);
	assert.equal(conflicts.length, 1);
	assert.equal(conflicts[0].options[0].label, "Keep the current behavior (Recommended)");
	assert.equal(conflicts[0].options[0].description, "Return `PreviewResult` with `nextRefreshInMs` for the existing polling path.");
}

// ── Legacy conflicts without a Decision line receive friendly context ───────
{
	const plan = [
		"## Conflicts",
		"",
		"### Conflict: Deployment strategy",
		"- **Recommended:** Gradual rollout — reason",
		"- **Alternative** (Proposer 1): Immediate release — reason",
	].join("\n");
	const { conflicts } = parseConflicts(plan);
	assert.equal(conflicts.length, 1);
	assert.equal(conflicts[0].prompt, "Choose how to handle “Deployment strategy”.");
	assert.equal(conflicts[0].options[1].proposerLabel, "Proposer 1");
}

// ── Trailing whitespace on the ## Conflicts header is tolerated ────────────
{
	const plan = [
		"## Plan",
		"1. Step.",
		"",
		"## Conflicts   ",
		"",
		"### Conflict: Something",
		"- **Recommended:** A — reason",
		"- **Alternative** (Proposer 1): B — reason",
	].join("\n");
	const { conflicts, remainingPlan } = parseConflicts(plan);
	assert.equal(conflicts.length, 1);
	assert.doesNotMatch(remainingPlan, /## Conflicts/);
}

// ── ## Conflicts header present but zero parseable blocks degrades gracefully ─
{
	const plan = "## Plan\n1. Step.\n\n## Conflicts\n\nNothing parseable here.\n";
	const { conflicts, remainingPlan } = parseConflicts(plan);
	assert.deepEqual(conflicts, []);
	// The (unparseable) ## Conflicts section is still stripped from the plan.
	assert.doesNotMatch(remainingPlan, /## Conflicts/);
	assert.match(remainingPlan, /## Plan/);
}

// ── A trailing section after ## Conflicts is preserved, not swallowed ──────
{
	const plan = [
		"## Plan",
		"1. Step.",
		"",
		"## Conflicts",
		"",
		"### Conflict: X",
		"- **Recommended:** A — reason",
		"- **Alternative** (Proposer 1): B — reason",
		"",
		"## Risks",
		"Watch out.",
	].join("\n");
	const { remainingPlan } = parseConflicts(plan);
	assert.doesNotMatch(remainingPlan, /## Conflicts/);
	assert.match(remainingPlan, /## Risks/);
	assert.match(remainingPlan, /Watch out\./);
}

console.log("Conflict parsing tests passed.");
