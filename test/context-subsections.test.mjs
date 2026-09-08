import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { buildContextSubsectionsContract, missingContextSubsections, buildContextRetryHeader, CONTEXT_SUBSECTION_HEADINGS } =
	await import("../src/moa/contextContract.ts");

// ── missingContextSubsections ─────────────────────────────────────────────
const fullContext = [
	"## Context",
	"",
	"Why this change is being made.",
	"",
	"### Evaluation dimensions",
	"Proposer 2 scored best on correctness.",
	"",
	"### Proposer alignment",
	"All proposers agreed on the storage layer.",
	"",
	"### Synthesis decisions",
	"Took Proposer 1's verification matrix.",
].join("\n");

assert.deepEqual(missingContextSubsections(fullContext), [], "complete Context passes");
assert.deepEqual(
	missingContextSubsections("## Context\n\nwhy\n\n### Evaluation Dimensions\nx"),
	["Proposer alignment", "Synthesis decisions"],
	"case-insensitive match tolerates casing drift and reports only real gaps",
);
assert.deepEqual(
	missingContextSubsections("## Context\nwhy\n\n###   Evaluation dimensions  \nx\n\n### Synthesis decisions\ny"),
	["Proposer alignment"],
	"flexible whitespace around headings is tolerated",
);
assert.deepEqual(
	missingContextSubsections("## Plan\n1. step"),
	[...CONTEXT_SUBSECTION_HEADINGS],
	"a plan with no Context reports all three missing",
);
assert.deepEqual(
	missingContextSubsections(fullContext.replace("### Evaluation dimensions", "Evaluation dimensions")),
	["Evaluation dimensions"],
	"non-heading mentions do not count",
);

// ── buildContextSubsectionsContract ───────────────────────────────────────
const contract = buildContextSubsectionsContract();
for (const heading of CONTEXT_SUBSECTION_HEADINGS) {
	assert.ok(contract.includes(`\`### ${heading}\``), `contract names ${heading} as a required subsection`);
}
assert.ok(contract.includes("`## Context`"), "contract pins placement under ## Context");
assert.ok(contract.includes("rejected and sent back"), "contract states the enforcement consequence");
assert.ok(contract.includes("including revisions after conflict resolutions or user feedback"), "contract covers revision rounds");
assert.ok(contract.includes("never collapse them into one impression"), "contract keeps the dimension-separation rule");

// ── buildContextRetryHeader ───────────────────────────────────────────────
const header = buildContextRetryHeader(["Proposer alignment"]);
assert.ok(header.includes("`### Proposer alignment`"), "retry names each missing heading");
assert.ok(header.includes("`### Evaluation dimensions`"), "retry restates the complete trio");
assert.doesNotMatch(header, /Proposer \d+/, "retry stays clear of slot-label phrasing");

// ── orchestration wiring (source contract) ────────────────────────────────
const root = path.resolve(import.meta.dirname, "..");
const synthesis = readFileSync(path.join(root, "src/moa/synthesis.ts"), "utf8");

// The contract rides the task text (bridges drop the agent system prompt),
// between the verdict and conflict contracts.
assert.match(synthesis, /\$\{buildVerdictContract\(fedLabels\)\}\\n\\n---\\n\\n\$\{buildContextSubsectionsContract\(\)\}\\n\\n---\\n\\n\$\{buildConflictContract\(fedLabels\)\}/);

// A plan missing the Context subsections is rejected once with the missing
// headings named, after the verdict gate and before conflict parsing.
assert.match(
	synthesis,
	/if \(!questionMatch && missingContext\.length > 0 && !contextRetried && round < MAX_SYNTH_ROUNDS - 1\) \{[\s\S]*?contextRetried = true;[\s\S]*?buildRetryCorrection\(buildContextRetryHeader\(missingContext\), synthOutput\)[\s\S]*?synthConversation\.push\(contextRetryCorr\);[\s\S]*?rebuildSynthTask\(\);/,
);
const verdictRetryAt = synthesis.indexOf("buildRetryCorrection(buildVerdictRetryHeader(missingVerdicts), synthOutput)");
const contextRetryAt = synthesis.indexOf("buildRetryCorrection(buildContextRetryHeader(missingContext), synthOutput)");
const conflictsAt = synthesis.indexOf("const { conflicts, remainingPlan } = parseConflicts(synthOutput)");
assert.ok(
	verdictRetryAt > 0 && contextRetryAt > verdictRetryAt && conflictsAt > contextRetryAt,
	"context gate sits between the verdict gate and conflict parsing",
);

// The user is warned when no auditable-reasoning section ever materialized.
assert.match(synthesis, /omitted the required Context subsections/);

// The agent prompt states the orchestrator enforces the subsections.
const synthesizerAgent = readFileSync(path.join(root, "agents/moa-synthesizer.md"), "utf8");
assert.match(synthesizerAgent, /The orchestrator verifies their presence and rejects a plan that omits any of them/);
assert.ok(synthesizerAgent.includes("MANDATORY in every full-plan output"), "agent prompt marks the subsections mandatory");

console.log("context-subsections tests passed");
