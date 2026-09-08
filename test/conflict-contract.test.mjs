import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { buildConflictContract, CONFLICT_CONTRACT_EXAMPLE } = await import("../src/moa/conflictContract.ts");
const { parseConflicts } = await import("../src/moa/conflicts.ts");

// ── buildConflictContract ─────────────────────────────────────────────────
const labels = ["Proposer 1", "Proposer 2", "Proposer 3"];
const contract = buildConflictContract(labels);

assert.ok(contract.includes("## Conflicts"), "contract names the required section");
assert.ok(contract.includes("### Conflict:"), "contract names the per-disagreement block");
assert.ok(contract.includes("Proposer 1, Proposer 2, Proposer 3"), "contract lists the exact fed slots");
assert.ok(
	contract.includes("placed after `## Proposer Verdicts`"),
	"contract pins the section order relative to verdicts",
);

// Guard: agreement/filtering rules kept verbatim so weak models do not
// fabricate conflicts to comply with the MUST.
assert.ok(
	contract.includes("Omit the section entirely when the proposers agree on all decision points"),
	"contract keeps the omit-when-agreed rule",
);
assert.ok(
	contract.includes("never include a conflict the user has no realistic alternative for"),
	"contract keeps the single-proposer filtering rule",
);
assert.ok(
	contract.includes("never invent a disagreement to comply with this requirement"),
	"contract forbids fabricated conflicts",
);

// Guard: revision-round precedence — later user directives override the MUST,
// mirroring the agent prompt's drop-on-revision rule.
assert.ok(
	contract.includes("those directives override this requirement"),
	"contract states the supersession rule",
);
assert.ok(
	contract.includes("User reviewed your conflict recommendations"),
	"supersession rule names the runtime feedback marker",
);
assert.ok(
	contract.includes("drop the `## Conflicts` section entirely from your revised output"),
	"supersession rule demands the section be dropped on revision",
);
assert.ok(
	contract.includes("do not emit `## Open Question` again"),
	"answered questions are not re-asked",
);

// Guard: blinded labels only.
assert.ok(
	contract.includes("never output any model name, family, provider, or version"),
	"contract keeps the blinding constraint",
);

// ── worked example parses into the overlay structure (lockstep) ───────────
const { conflicts, remainingPlan } = parseConflicts(CONFLICT_CONTRACT_EXAMPLE);
assert.equal(conflicts.length, 1, "example yields exactly one conflict");
const parsed = conflicts[0];
assert.equal(parsed.label, "Auth storage");
assert.equal(parsed.options.length, 3, "recommended + alternative + trailing chat option");
assert.equal(parsed.options[0].label, "Keep the current sign-in experience (Recommended)");
assert.equal(parsed.options[0].recommended, true);
assert.equal(
	parsed.options[0].description,
	"Store session IDs in `Secure`, `HttpOnly` cookies so the existing middleware stays compatible and page scripts cannot read them.",
	"Details line becomes the recommended option's description",
);
assert.equal(parsed.options[1].proposerLabel, "Proposer 2");
assert.equal(parsed.options[1].label, "Make sign-in data available to browser code");
assert.equal(
	parsed.prompt,
	"Choose where sign-in information is stored; this affects both security and how much of the existing sign-in flow can stay unchanged.",
	"Decision line becomes the overlay prompt",
);
assert.ok(!remainingPlan.includes("## Conflicts"), "example section stripped cleanly");

// ── orchestration wiring (source contract) ────────────────────────────────
const root = path.resolve(import.meta.dirname, "..");
const orchestration = readFileSync(path.join(root, "src/moa/synthesis.ts"), "utf8");

// The contract rides the task text (bridges drop the agent system prompt),
// appended after the context contract, which follows the verdict contract,
// all in the same template literal.
assert.match(orchestration, /\$\{buildVerdictContract\(fedLabels\)\}\\n\\n---\\n\\n\$\{buildContextSubsectionsContract\(\)\}\\n\\n---\\n\\n\$\{buildConflictContract\(fedLabels\)\}/);
assert.ok(
	orchestration.indexOf("${buildVerdictContract(fedLabels)}") <
		orchestration.indexOf("${buildContextSubsectionsContract()}") &&
		orchestration.indexOf("${buildContextSubsectionsContract()}") <
		orchestration.indexOf("${buildConflictContract(fedLabels)}"),
	"context contract sits between the verdict and conflict contracts in synthTask",
);

console.log("conflict-contract tests passed");
