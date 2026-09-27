import assert from "node:assert/strict";
import { slugifyPlanName, saveRepoPlanFile, readRepoPlanFile, getRepoPlanDirectory, writeProposalFiles, cleanupProposalFiles, sweepStaleProposalFiles, getPlanFilePath, getPlansDirectory, isValidPlanSlug, resetPlanSlug, setPlanSlug, generateWordSlug, isApprovedRepoPlanFilename, nextFreeRepoPlanSlug, repoPlanDisplayPath } from "../src/planning/planFile.ts";
import { proposerBlindedLabel } from "../src/shared/modelRefs.ts";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

assert.equal(slugifyPlanName("Add Cool New Feature"), "add-cool-new-feature");
assert.equal(slugifyPlanName("  refactor auth flow now!  "), "refactor-auth-flow-now");
assert.equal(slugifyPlanName("one two three four five"), "one-two-three-four");
const overlongSlug = slugifyPlanName("a".repeat(200));
assert.equal(overlongSlug, "a".repeat(100));
assert.equal(isValidPlanSlug(overlongSlug), true);
assert.equal(isValidPlanSlug(slugifyPlanName("--- !!!")), true);

// Random slugs use adjective-adjective-noun (three words) to minimize collisions.
for (let i = 0; i < 20; i++) {
	const slug = generateWordSlug();
	assert.ok(/^[a-z]+-[a-z]+-[a-z]+$/.test(slug), `expected 3-word slug, got ${slug}`);
	assert.equal(isValidPlanSlug(slug), true);
}

assert.equal(isValidPlanSlug("tidy-wolf"), true);
assert.equal(isValidPlanSlug("plan-123456"), true);
for (const invalid of ["../../x", "a/b", "", "/absolute", "has_underscore", ".hidden"]) {
	assert.equal(isValidPlanSlug(invalid), false);
	assert.equal(setPlanSlug(invalid), false);
}
assert.equal(setPlanSlug("plan-123456"), true);
assert.equal(getPlanFilePath(), path.join(getPlansDirectory(), "plan-123456.md"));
resetPlanSlug();

const repo = mkdtempSync(path.join(tmpdir(), "mf-plan-test-"));
try {
	const expectedPlanDirectory = path.join(repo, CONFIG_DIR_NAME, "mf-plan");
	assert.equal(getRepoPlanDirectory(repo), expectedPlanDirectory);
	const promptPath = saveRepoPlanFile("build a widget", repo, "add-cool-new-feature", "plan-prompt");
	const planPath = saveRepoPlanFile("# Plan\n\nDo things.", repo, "add-cool-new-feature", "plan");
	const criteriaPath = saveRepoPlanFile("## Verification Criteria", repo, "add-cool-new-feature", "criteria");
	const specPath = saveRepoPlanFile("# Planning Brief", repo, "add-cool-new-feature", "spec");

	assert.equal(promptPath, path.join(expectedPlanDirectory, "add-cool-new-feature__plan-prompt.md"));
	assert.equal(planPath, path.join(expectedPlanDirectory, "add-cool-new-feature__plan.md"));
	assert.equal(criteriaPath, path.join(expectedPlanDirectory, "add-cool-new-feature__criteria.md"));
	assert.equal(specPath, path.join(expectedPlanDirectory, "add-cool-new-feature__spec.md"));
	assert.equal(readRepoPlanFile(repo, "add-cool-new-feature", "criteria"), "## Verification Criteria");
	assert.equal(readRepoPlanFile(repo, "add-cool-new-feature", "spec"), "# Planning Brief");
	assert.equal(repoPlanDisplayPath("add-cool-new-feature", "spec"), `${CONFIG_DIR_NAME}/mf-plan/add-cool-new-feature__spec.md`);
	assert.throws(() => repoPlanDisplayPath("../x", "spec"), /Invalid repository plan slug/);

	assert.equal(nextFreeRepoPlanSlug(repo, "unused", "spec"), "unused");
	saveRepoPlanFile("one", repo, "collision", "spec");
	assert.equal(nextFreeRepoPlanSlug(repo, "collision", "spec"), "collision-2");
	saveRepoPlanFile("two", repo, "collision-2", "spec");
	assert.equal(nextFreeRepoPlanSlug(repo, "collision", "spec"), "collision-3");
	const longBase = "a".repeat(100);
	saveRepoPlanFile("long", repo, longBase, "spec");
	assert.ok(nextFreeRepoPlanSlug(repo, longBase, "spec").length <= 100);

	for (const filename of ["a__plan.md", "a__plan-prompt.md", "a__spec.md", "a__criteria.md", "a__verification.md"]) {
		saveRepoPlanFile(filename, repo, "a", filename === "a__plan.md" ? "plan" : filename === "a__plan-prompt.md" ? "plan-prompt" : filename === "a__spec.md" ? "spec" : filename === "a__criteria.md" ? "criteria" : "verification");
	}
	assert.deepEqual(readdirSync(expectedPlanDirectory).filter(isApprovedRepoPlanFilename), ["a__plan.md", "add-cool-new-feature__plan.md"]);
	assert.equal(readFileSync(promptPath, "utf8"), "build a widget");
	assert.equal(readFileSync(planPath, "utf8"), "# Plan\n\nDo things.");
	for (const invalid of ["../../x", "a/b", "", path.join(repo, "absolute")]) {
		assert.throws(() => saveRepoPlanFile("bad", repo, invalid, "plan"), /Invalid repository plan slug/);
	}
} finally {
	rmSync(repo, { recursive: true, force: true });
}

// Staged proposal copies: blinded names, verbatim content, per-run isolation.
const proposalRepo = mkdtempSync(path.join(tmpdir(), "mf-plan-test-repo-"));
try {
	const staged = writeProposalFiles([
		{ label: proposerBlindedLabel(0), plan: "# One\n\nStep one." },
		{ label: proposerBlindedLabel(2), plan: "# Three\n\nStep three." },
	]);

	assert.ok(staged, "expected proposals to stage");
	assert.equal(staged.files.length, 2);

	// Names follow the blinded slot label, so no model identity reaches disk.
	assert.deepEqual(readdirSync(staged.dir).sort(), ["proposer-1.md", "proposer-3.md"]);
	assert.equal(readFileSync(staged.files[0].path, "utf8"), "# One\n\nStep one.");
	assert.equal(readFileSync(staged.files[1].path, "utf8"), "# Three\n\nStep three.");

	// Outside the repo, or the fan-out mutation tripwire reports a false positive.
	assert.ok(!staged.dir.startsWith(proposalRepo));

	// A second run must not be able to see the first run's proposals.
	const other = writeProposalFiles([{ label: proposerBlindedLabel(0), plan: "# Other" }]);
	assert.ok(other);
	assert.notEqual(other.dir, staged.dir);
	assert.equal(readdirSync(other.dir).length, 1);
	cleanupProposalFiles(other);

	cleanupProposalFiles(staged);
	assert.ok(!existsSync(staged.dir));

	// Cleanup runs from a finally that may fire on paths that never staged.
	cleanupProposalFiles(staged);
	cleanupProposalFiles(null);
} finally {
	rmSync(proposalRepo, { recursive: true, force: true });
}

// Sweeping abandoned staging dirs must discriminate purely on age: a crashed
// run's leftovers go, a concurrent live run's do not.
const abandoned = writeProposalFiles([{ label: proposerBlindedLabel(0), plan: "# Abandoned" }]);
const live = writeProposalFiles([{ label: proposerBlindedLabel(0), plan: "# Live" }]);
try {
	const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
	utimesSync(abandoned.dir, hundredDaysAgo, hundredDaysAgo);

	sweepStaleProposalFiles();

	assert.ok(!existsSync(abandoned.dir), "expected the abandoned staging dir to be swept");
	assert.ok(existsSync(live.dir), "expected a live run's staging dir to survive");
	assert.equal(readFileSync(live.files[0].path, "utf8"), "# Live");
} finally {
	cleanupProposalFiles(abandoned);
	cleanupProposalFiles(live);
}

console.log("plan file naming tests passed");
