import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
	try { execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], { stdio: "inherit" }); }
	catch (err) { process.exit(err.status ?? 1); }
	process.exit(0);
}

const { buildCriteriaRetryTask, buildCriteriaTask, formatCriteriaMarkdown, parseVerificationCriteria } = await import("../src/moa/verificationCriteria.ts");

const parsed = parseVerificationCriteria(`prose
## Verification Criteria
- **c1:** Field is present — src/foo.ts: Widget
- **C2**: Both call sites are wired — grep Widget
- **C1:** duplicate — ignored
## Other
- **C3:** ignored`);
assert.deepEqual(parsed, [
	{ id: "C1", text: "Field is present — src/foo.ts: Widget" },
	{ id: "C2", text: "Both call sites are wired — grep Widget" },
]);
assert.deepEqual(parseVerificationCriteria("prose only"), []);
assert.match(buildCriteriaTask("# Plan\n1. Add widget"), /Do NOT implement, edit, or run anything/);
assert.match(buildCriteriaTask("# Plan\n1. Add widget"), /# Plan/);
assert.match(buildCriteriaTask("# Plan\n1. Add widget"), /at least one criterion per plan step/i);
assert.match(buildCriteriaRetryTask("task", 'bad """ output'), /bad '' output/);
assert.equal(formatCriteriaMarkdown(parsed).split("\n")[0], "## Verification Criteria");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const synthesis = readFileSync(path.join(root, "src/moa/synthesis.ts"), "utf8");
const reviewLoop = readFileSync(path.join(root, "src/moa/reviewLoop.ts"), "utf8");
assert.match(synthesis, /generateVerificationCriteria:\s*\(plan\) => runCriteriaGeneration\(/);
assert.match(reviewLoop, /generatedCriteria = await options\.generateVerificationCriteria\(currentPlan\)[\s\S]*?settleRoleRow\("Synthesize", "done"\)/);
assert.match(reviewLoop, /saveRepoPlanFile\(generatedCriteria\.markdown, ctx\.cwd, repoPlanSlug, "criteria"\)/);
console.log("Verification criteria tests passed.");
