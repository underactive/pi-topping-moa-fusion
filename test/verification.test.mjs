import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

// verifyGate/verification use only plain TS, but keep the transform guard so
// this file runs identically under both invocations.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], { stdio: "inherit" });
	} catch (err) {
		process.exit(err.status ?? 1);
	}
	process.exit(0);
}

const {
	buildVerifierTask,
	buildVerificationSummary,
	buildVerificationDecisionPrompt,
	formatVerificationReport,
	formatVerifierFailure,
	parseVerificationVerdict,
	splitIntoParagraphs,
	deriveCriteriaVerdict,
	verificationPassed,
	runVerificationDecision,
	runImplementationVerification,
	MAX_VERIFICATION_REPAIRS,
} = await import("../src/moa/verification.ts");
const { discoverVerifyScripts, runVerifyScript } = await import("../src/moa/verifyGate.ts");

// ── parseVerificationVerdict across every verdict + missing ──────────────
{
	const complete = `## Step Verdicts
- **Step 1:** done — src/foo.ts:12 adds the field
- **Step 2:** done — wired in bar.ts:40

## Deviations
None.

## Verification Result
**Verdict:** complete
**Summary:** Every step landed and checks passed.`;
	const parsed = parseVerificationVerdict(complete);
	assert.equal(parsed.verdict, "complete");
	assert.match(parsed.summary, /Every step landed/);
	assert.equal(parsed.steps.length, 2);
	assert.deepEqual(parsed.gaps, []);

	const partial = `## Step Verdicts
- **Step 1:** done — landed
- **Step 2:** partial — only one of two call sites updated

## Verification Result
**Verdict:** partial
**Summary:** Step 2 is incomplete.

### Gaps
- Step 2 — the second call site in baz.ts:88 was not updated
- Step 3 — missing entirely`;
	const p2 = parseVerificationVerdict(partial);
	assert.equal(p2.verdict, "partial");
	assert.equal(p2.gaps.length, 2);
	assert.match(p2.gaps[0], /second call site/);

	assert.equal(parseVerificationVerdict("**Verdict:** incomplete\n**Summary:** Nothing landed.").verdict, "incomplete");
	assert.equal(parseVerificationVerdict("**Verdict:** cannot-verify\n**Summary:** Could not read the files.").verdict, "cannot-verify");

	// Missing / malformed verdict defaults to undefined (a non-passing outcome).
	assert.equal(parseVerificationVerdict("The implementation looks fine to me.").verdict, undefined);
	assert.equal(parseVerificationVerdict("**Verdict:** looks-good").verdict, undefined);
	const criteriaOutput = `## Criteria Verdicts\n- **C1:** PASS — src/foo.ts:1\n- **C2**: cannot-verify — missing\n\n## Verification Result\n**Verdict:** cannot-verify`;
	const criteria = parseVerificationVerdict(criteriaOutput);
	assert.equal(criteria.criteria.length, 2);
	assert.equal(deriveCriteriaVerdict(criteria, [{ id: "C1", text: "Exists" }, { id: "C2", text: "Wired" }]).verdict, "cannot-verify");
	assert.equal(deriveCriteriaVerdict(parseVerificationVerdict(`## Criteria Verdicts\n- **C1:** pass — yes\n- **C2:** fail — no`), [{ id: "C1", text: "Exists" }, { id: "C2", text: "Wired" }]).verdict, "partial");
	assert.equal(deriveCriteriaVerdict(parseVerificationVerdict(`## Criteria Verdicts\n- **C1:** pass — yes\n- **C2:** pass — yes`), [{ id: "C1", text: "Exists" }, { id: "C2", text: "Wired" }]).verdict, "complete");
	assert.equal(deriveCriteriaVerdict(parseVerificationVerdict(`## Criteria Verdicts\n- **C1:** pass — yes`), [{ id: "C1", text: "Exists" }, { id: "C2", text: "Wired" }]).verdict, "cannot-verify");
}

// ── formatVerifierFailure classifies child failures without hiding details ──
{
	const neverStarted = formatVerifierFailure({
		exitCode: 127,
		messageCount: 0,
		errorMessage: "spawn failed",
	});
	assert.match(neverStarted, /verifier never started \(exit 127\)/);
	assert.match(neverStarted, /spawn failed/);

	const providerError = formatVerifierFailure({
		stopReason: "error",
		errorMessage: "model rejected by provider",
	});
	assert.match(providerError, /verifier provider error/);
	assert.match(providerError, /model rejected by provider/);

	const stderrFallback = formatVerifierFailure({
		exitCode: 0,
		messageCount: 1,
		stderr: "stderr tail",
	});
	assert.equal(stderrFallback, "stderr tail");
}

// ── verificationPassed fold: complete + clean gate only ──────────────────
{
	const pass = { script: "test", command: "npm run test", status: "pass", exitCode: 0, relevantOutput: "" };
	const fail = { script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "1 failing" };
	assert.equal(verificationPassed("complete", []), true);
	assert.equal(verificationPassed("complete", [pass]), true);
	// complete verdict + a failing script → NOT passing (repair-eligible).
	assert.equal(verificationPassed("complete", [pass, fail]), false);
	assert.equal(verificationPassed("partial", []), false);
	assert.equal(verificationPassed(undefined, []), false);
	assert.equal(verificationPassed("cannot-verify", [pass]), false);
	assert.ok(MAX_VERIFICATION_REPAIRS >= 1);
}

// ── repair-prompt summary and report stay readable and bounded ──────────
{
	const criteriaParsed = parseVerificationVerdict(`## Criteria Verdicts
- **C1:** pass — src/a.ts:1
- **C2:** fail — src/b.ts:2

## Verification Result
**Verdict:** partial
**Summary:** The first criterion passed. The second criterion failed.`);
	const derived = deriveCriteriaVerdict(criteriaParsed, [{ id: "C1", text: "First" }, { id: "C2", text: "Second" }]);
	criteriaParsed.verdict = derived.verdict;
	criteriaParsed.gaps = derived.gaps;
	const failedCheck = { script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") };
	const criteriaSummary = buildVerificationSummary(criteriaParsed, [failedCheck]);
	assert.ok(criteriaSummary.length <= 3);
	assert.equal(criteriaSummary[0], "Verification result: partial.");
	assert.equal(criteriaSummary[1], "1 of 2 criteria passed. 1 failed.");
	assert.equal(criteriaSummary[2], "1 project check failed.");
	assert.ok(criteriaSummary.every((line) => line.length <= 60));

	const stepParsed = parseVerificationVerdict(`## Verification Result
**Verdict:** incomplete
**Summary:** One requirement is missing.

### Gaps
- Add the missing requirement`);
	assert.deepEqual(buildVerificationSummary(stepParsed, []), [
		"Verification result: incomplete.",
		"The verifier found 1 gap.",
	]);
	assert.deepEqual(buildVerificationSummary({ ...stepParsed, gaps: ["Add the missing requirement", "Wire the second call site"] }, []), [
		"Verification result: incomplete.",
		"The verifier found 2 gaps.",
	]);
	assert.deepEqual(buildVerificationSummary(stepParsed, [{ ...failedCheck, status: "pass", exitCode: 0 }]), [
		"Verification result: incomplete.",
		"The verifier found 1 gap.",
		"All project checks passed.",
	]);

	const paragraphs = splitIntoParagraphs("First sentence ends. Second uses baz.ts:88 and e.g. a value. Third starts here! Fourth ends?");
	assert.deepEqual(paragraphs, [
		"First sentence ends. Second uses baz.ts:88 and e.g. a value.",
		"Third starts here! Fourth ends?",
	]);
	assert.deepEqual(splitIntoParagraphs("Use e.g. Example text. Next sentence.", 1), [
		"Use e.g. Example text.",
		"Next sentence.",
	]);
	assert.equal(splitIntoParagraphs("x".repeat(1_201))[0].endsWith("…"), true);

	const longGap = "x".repeat(250);
	const report = formatVerificationReport({ ...criteriaParsed, gaps: [longGap] }, [failedCheck]);
	assert.match(report, /Verifier summary:/);
	assert.match(report, /Criteria not met:/);
	assert.match(report, /Failing project checks:/);
	assert.match(report, /\n\nCriteria not met:/);
	assert.match(report, /… \(output truncated\)/);
	assert.ok((report.match(/^    /gm) ?? []).length <= 7, "six output lines plus the truncation marker");
	assert.ok(report.split("\n").some((line) => line.startsWith("- …") && line.length <= 202));
	assert.match(formatVerificationReport(stepParsed, []), /Gaps:/);
	assert.equal(formatVerificationReport({ ...stepParsed, summary: "", gaps: [] }, []), "");

	const decisionPrompt = buildVerificationDecisionPrompt(
		{ ...criteriaParsed, gaps: Array.from({ length: 30 }, () => "x".repeat(500)) },
		[failedCheck],
		".pi/mf-plan/example__verification.md",
	);
	assert.ok(decisionPrompt.split("\n").length <= 5, "the decision prompt has a fixed short height");
	assert.doesNotMatch(decisionPrompt, /x{20}/, "verbose findings stay out of the fixed select prompt");
	assert.match(decisionPrompt, /Full findings: \.pi\/mf-plan\/example__verification\.md/);
	assert.doesNotMatch(decisionPrompt, /Send the findings to the implementer, or accept/);

	const longPath = `.pi/mf-plan/${"界".repeat(300)}__verification.md`;
	const boundedPrompt = buildVerificationDecisionPrompt(criteriaParsed, [failedCheck], longPath, 80);
	assert.ok(boundedPrompt.split("\n").every((line) => visibleWidth(line) <= 80));
	const boundedPathLine = boundedPrompt.split("\n").at(-1);
	assert.ok(boundedPathLine?.startsWith("Full findings: .pi/mf-plan/"));
	assert.ok(boundedPathLine?.endsWith("__verification.md"));

	const narrowPrompt = buildVerificationDecisionPrompt(criteriaParsed, [failedCheck], longPath, 40);
	assert.ok(narrowPrompt.split("\n").every((line) => visibleWidth(line) <= 40));

	const fallbackPrompt = buildVerificationDecisionPrompt(criteriaParsed, [failedCheck]);
	assert.match(fallbackPrompt, /Full findings will be sent to the implementer if you continue\./);
}

// ── buildVerifierTask embeds every evidence section + the contract ───────
{
	const task = buildVerifierTask({
		plan: "# Frozen Plan\n1. Add the widget\n2. Wire it up",
		implementerReport: "I added the widget and wired everything up flawlessly.",
		diff: "diff --git a/src/widget.ts b/src/widget.ts\n+export const widget = 1;",
		scriptResults: [
			{ script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "AssertionError: nope" },
		],
		cwd: "/repo",
	});
	// Read-only preamble (survives a bridge stripping the agent system prompt).
	assert.match(task, /do NOT edit files, and do NOT run builds, tests, or any command/);
	// Frozen plan is the source of truth.
	assert.match(task, /# Frozen Plan/);
	assert.match(task, /source of truth/);
	// The implementer's report is flagged as an untrusted claim, not evidence.
	assert.match(task, /UNTRUSTED CLAIM/);
	assert.match(task, /wired everything up flawlessly/);
	// The diff rides along, caveated.
	assert.match(task, /git diff HEAD/);
	assert.match(task, /export const widget = 1/);
	// The script gate results are handed over as evidence.
	assert.match(task, /npm run test → FAIL/);
	assert.match(task, /AssertionError: nope/);
	// The parseable output contract is inline.
	assert.match(task, /\*\*Verdict:\*\* complete \| partial \| incomplete \| cannot-verify/);
	assert.match(task, /## Step Verdicts/);
	assert.match(task, /### Gaps/);
	const criteriaTask = buildVerifierTask({ plan: "# P", implementerReport: undefined, diff: null, scriptResults: [], cwd: "/repo", criteria: [{ id: "C1", text: "Widget exists — src/widget.ts" }] });
	assert.match(criteriaTask, /## Verification criteria/);
	assert.match(criteriaTask, /## Criteria Verdicts/);

	// A run with no scripts / no diff still produces a coherent task.
	const bare = buildVerifierTask({ plan: "# P", implementerReport: undefined, diff: null, scriptResults: [], cwd: "/repo" });
	assert.match(bare, /No check\/lint\/test scripts were discovered/);
	assert.match(bare, /No git diff available/);
	assert.match(bare, /produced no final summary message/);
}

// ── verification reuses the adopted MoA Fusion table ─────────────────────────
// The verifier row lives in the one table adopted on approval: no per-attempt
// widget, no bespoke title, the Verify role row fed through the generic role
// updaters, and a repair round handing the table back to the Implement row.
{
	const source = readFileSync(new URL("../src/moa/verification.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /new MoaProgressWidget\(/, "verification must not construct its own progress table");
	assert.doesNotMatch(source, /plan mode · verification/, "the bespoke verification title is gone");
	assert.match(source, /host\.getActiveProgressWidget\(\)/, "verification reads the adopted table from the host");
	assert.match(source, /switchToVerifying\(verifier, "running project checks…", handoff\.verifierThinking\)/, "the Verify row activates before the script gate, tinted by the handoff's verifier level");
	assert.match(source, /switchToVerifying\(verifier, "checking verifier…", activeVerifierThinking\)/, "the preflight reactivation carries the active verifier level");
	assert.match(source, /switchToVerifying\(verifier, "verifying implementation…", activeVerifierThinking\)/, "and reports the subprocess once it starts, with the active verifier level a fallback keeps in sync");
	assert.match(source, /getRoleStatus\("Verify"\)/);
	assert.match(source, /updateRoleUsage\(\s*"Verify"/);
	assert.match(source, /updateRoleActivity\("Verify"/);
	assert.match(source, /updateRoleOutput\("Verify"/);
	assert.match(source, /switchToImplementing\(handoff\.model, "addressing verifier findings…", handoff\.thinking\)/, "a repair round reactivates the Implement row under the implementer's level");
	assert.match(source, /host\.stopActiveProgressWidget\(\)/, "terminal outcomes dispose the table");
	assert.doesNotMatch(source, /getSynthesizerStatus|updateSynthesizer/, "no synthesizer-named shims remain");
	assert.match(source, /Reply with the single word ok/, "the verifier has a cheap liveness preflight");
	assert.match(source, /\.\.\.modelExtensionOptions\(ctx, verifier\)/, "preflight and full verification load the verifier extension");
	assert.match(source, /formatVerifierFailure\(outcome\)/, "failed results use the classified diagnostic");
	assert.match(
		source,
		/promptWidth = Math\.max\(20, \(process\.stdout\.columns \?\? 80\) - SELECTOR_TITLE_WIDTH_RESERVE\)[\s\S]*?ctx\.ui\.select\([\s\S]*?buildVerificationDecisionPrompt\(parsed, scriptResults, reportPath, promptWidth\)/,
		"the decision dialog uses a fixed-height decision prompt",
	);
	assert.match(
		source,
		/if \(ctx\.hasUI && repairsUsed < MAX_VERIFICATION_REPAIRS\) \{[\s\S]*?await runVerificationDecision\(\{/,
		"the repair-eligible branch delegates to the decision loop",
	);
	assert.match(source, /\["View full findings", "Send verifier findings to the implementer", "Accept implementation as-is"\]/, "the TUI decision offers viewing alongside repair and accept");
	// The viewer needs an overlay surface, so it is gated to the TUI; a non-TUI UI
	// (RPC still reports hasUI) keeps the original two choices.
	assert.match(source, /const options = isTui\s*\?[\s\S]*?\["Send verifier findings to the implementer", "Accept implementation as-is"\]/, "non-TUI keeps the original two choices");
	assert.match(source, /isTui: ctx\.mode === "tui"/, "eligibility for the viewer is TUI-only, not merely hasUI");
	// Viewing the findings is non-terminal: it opens the read-only popup and
	// reopens the same selector without touching handoff or completion state.
	assert.match(source, /if \(choice === "View full findings"\) \{\s*await showFindings\(ctx, report\);\s*continue;\s*\}/, "viewing findings reopens the selector");
	assert.match(source, /report: verificationReport,/, "the accepted verifier report is retained for the findings popup");
	assert.match(source, /verificationReport = outcome\.output;/, "the original verifier output is captured verbatim");
	assert.match(source, /Implementation accepted as-is\./, "the accept path has a brief confirmation");
	// The success and exhausted-repair terminal paths live inside
	// runImplementationVerification (driven by a verifier subprocess, so not unit
	// invocable); assert by source contract that they still notify and finish
	// without entering the decision loop.
	assert.match(source, /if \(verificationPassed\(parsed\.verdict, scriptResults\)\) \{[\s\S]*?Verification passed[\s\S]*?finish\("done"\);/, "the success path notifies and finishes without a decision");
	assert.match(source, /Repair rounds are exhausted\.[\s\S]*?finish\("done"\);/, "the exhausted-repair path notifies and finishes without a decision");
	assert.match(source, /Verification failed \(\$\{verifierLabel\}\)/, "the full failure is notified before recovery choices");
	assert.match(source, /Verification could not complete \(\$\{verifierLabel\}\): \$\{titleReason\}/, "the dialog includes model and capped reason");
	assert.match(source, /Retry with \$\{modelRefLabel\(config\.synthesizer\)\}/, "the synthesizer fallback is offered");
	assert.match(source, /activeVerifierThinking = config\.thinkingOverrides\[modelRefLabel\(synthesizer\)\] \?\? activeVerifierThinking/);
	assert.match(
		source,
		/if \(!outcome\.cancelled && host\.getPlanRepoSlug\(\)\) \{[\s\S]*?saveRepoPlanFile\([\s\S]*?if \(outcome\.cancelled \|\| outcome\.failed\)/,
		"failed reports are persisted before recovery handling",
	);

	const runner = readFileSync(new URL("../src/runtime/runner.ts", import.meta.url), "utf8");
	assert.match(runner, /proc\.on\("error", \(error\) =>[\s\S]*currentResult\.errorMessage/);
	assert.match(runner, /proc\.on\("error", \(error\) =>[\s\S]*currentResult\.stderr/);
	assert.match(runner, /Buffer\.byteLength\(task\)/);
}

// ── runVerificationDecision: viewing is non-terminal; repair/accept end it ──
// The read-only findings popup is a step in the decision, not an outcome:
// closing it returns to the same choices without consuming a repair round,
// mutating handoff state, sending a message, or finishing verification.
{
	function makeDecisionHarness(choices, { isTui = true } = {}) {
		const queue = [...choices];
		const events = {
			selects: 0,
			optionsSeen: [],
			findings: 0,
			lastFindings: undefined,
			snapshotAtView: [],
			notifies: [],
			sent: [],
			pending: 0,
			handoffs: [],
			widget: [],
			finished: [],
		};
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				select: async (_prompt, options) => {
					events.selects++;
					events.optionsSeen.push(options);
					return queue.shift();
				},
				notify: (msg, type) => events.notifies.push({ msg, type }),
			},
		};
		const widget = {
			settleRoleRow: (role, state) => events.widget.push(["settleRoleRow", role, state]),
			switchToImplementing: (ref, status, thinking) => events.widget.push(["switchToImplementing", ref, status, thinking]),
		};
		const host = {
			setImplementationHandoff: (h) => events.handoffs.push(h),
			markImplementationPending: () => { events.pending++; },
			noteRunError: () => {},
			pi: { sendUserMessage: async (text) => { events.sent.push(text); } },
		};
		const deps = {
			ctx,
			host,
			handoff: {
				plan: "# Plan",
				planFilePath: "/tmp/plan.md",
				model: { provider: "test", id: "impl" },
				thinking: "high",
				verificationRepairs: 0,
				timestamp: 1,
			},
			parsed: { verdict: "partial", summary: "s", gaps: ["g"], steps: [], criteria: [] },
			scriptResults: [],
			failedScripts: [],
			plan: "# Plan\n\n1. Do the thing.",
			report: "# Verifier report\n\nThe complete, untruncated findings.",
			reportPath: ".pi/mf-plan/example__verification.md",
			repairsUsed: 0,
			isTui,
			widget,
			finish: (state) => events.finished.push(state),
			showFindings: async (_ctx, markdown) => {
				events.findings++;
				events.lastFindings = markdown;
				// Snapshot terminal state at the moment the popup opens: viewing must
				// not have mutated anything by then.
				events.snapshotAtView.push({
					handoffs: events.handoffs.length,
					pending: events.pending,
					sent: events.sent.length,
					finished: events.finished.length,
				});
			},
		};
		return { deps, events };
	}

	// The three choices appear in the requested order.
	{
		const { deps, events } = makeDecisionHarness(["Accept implementation as-is"]);
		await runVerificationDecision(deps);
		assert.deepEqual(events.optionsSeen[0], [
			"View full findings",
			"Send verifier findings to the implementer",
			"Accept implementation as-is",
		]);
	}

	// view → close → view → close → repair.
	{
		const { deps, events } = makeDecisionHarness([
			"View full findings",
			"View full findings",
			"Send verifier findings to the implementer",
		]);
		await runVerificationDecision(deps);
		assert.equal(events.findings, 2, "each view opens the read-only popup");
		assert.equal(events.lastFindings, deps.report, "the popup shows the original verifier report verbatim");
		assert.equal(events.selects, 3, "the selector reopens after every view");
		assert.deepEqual(events.snapshotAtView, [
			{ handoffs: 0, pending: 0, sent: 0, finished: 0 },
			{ handoffs: 0, pending: 0, sent: 0, finished: 0 },
		], "viewing alone never mutates handoff, repair, messaging, or completion state");
		assert.equal(events.handoffs.length, 1, "only the repair choice records a handoff");
		assert.equal(events.handoffs[0].verificationRepairs, 1, "the repair round increments exactly once");
		assert.equal(events.pending, 1, "the repair marks the implementation pending once");
		assert.equal(events.sent.length, 1, "one repair kickoff is sent");
		assert.ok(events.sent[0].includes("1. Do the thing."), "the kickoff carries the approved plan");
		assert.deepEqual(events.finished, [], "a repair round does not finish verification");
		assert.deepEqual(events.widget.at(-1), ["switchToImplementing", deps.handoff.model, "addressing verifier findings…", deps.handoff.thinking], "the repair round reactivates the implementer under its own thinking level");
	}

	// view → close → accept.
	{
		const { deps, events } = makeDecisionHarness([
			"View full findings",
			"Accept implementation as-is",
		]);
		await runVerificationDecision(deps);
		assert.equal(events.findings, 1);
		assert.equal(events.selects, 2);
		assert.equal(events.handoffs.length, 0, "viewing then accepting never records a handoff");
		assert.equal(events.pending, 0, "viewing then accepting never marks pending");
		assert.equal(events.sent.length, 0, "viewing then accepting sends no message");
		assert.deepEqual(events.finished, ["done"], "accept finishes verification");
		assert.ok(events.notifies.some((n) => /Implementation accepted as-is\./.test(n.msg)));
	}

	// A cancelled selector (undefined) falls through to accept, unchanged.
	{
		const { deps, events } = makeDecisionHarness(["View full findings", undefined]);
		await runVerificationDecision(deps);
		assert.equal(events.findings, 1);
		assert.equal(events.handoffs.length, 0);
		assert.equal(events.pending, 0);
		assert.equal(events.sent.length, 0);
		assert.deepEqual(events.finished, ["done"], "selector cancellation still accepts as-is");
	}

	// Non-TUI (e.g. RPC, which still reports hasUI) keeps the original two
	// choices and never opens the popup: accept stays terminal and unchanged.
	{
		const { deps, events } = makeDecisionHarness(["Accept implementation as-is"], { isTui: false });
		await runVerificationDecision(deps);
		assert.deepEqual(events.optionsSeen[0], [
			"Send verifier findings to the implementer",
			"Accept implementation as-is",
		], "outside the TUI the viewer option is omitted");
		assert.equal(events.findings, 0, "no popup is opened outside the TUI");
		assert.equal(events.handoffs.length, 0);
		assert.equal(events.sent.length, 0);
		assert.deepEqual(events.finished, ["done"], "non-TUI accept finishes verification");
	}

	// Non-TUI repair still hands off exactly as before, without any viewer.
	{
		const { deps, events } = makeDecisionHarness(["Send verifier findings to the implementer"], { isTui: false });
		await runVerificationDecision(deps);
		assert.equal(events.findings, 0, "the viewer is never reachable outside the TUI");
		assert.equal(events.handoffs.length, 1, "the repair choice still records a handoff");
		assert.equal(events.handoffs[0].verificationRepairs, 1);
		assert.equal(events.pending, 1);
		assert.equal(events.sent.length, 1);
		assert.deepEqual(events.finished, [], "a repair round does not finish verification");
	}
}

// ── discoverVerifyScripts ordering + filtering against a temp package.json ─
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-verify-gate-"));
try {
	// No package.json → no scripts.
	assert.deepEqual(await discoverVerifyScripts(tempRoot), []);

	// Only check/lint/test are discovered, always in that canonical order.
	writeFileSync(
		path.join(tempRoot, "package.json"),
		JSON.stringify({ scripts: { test: "true", build: "true", check: "true", lint: "true" } }),
		"utf8",
	);
	assert.deepEqual(await discoverVerifyScripts(tempRoot), ["check", "lint", "test"]);

	// A subset is honored in order; unrelated scripts are ignored.
	writeFileSync(
		path.join(tempRoot, "package.json"),
		JSON.stringify({ scripts: { test: "true", start: "node ." } }),
		"utf8",
	);
	assert.deepEqual(await discoverVerifyScripts(tempRoot), ["test"]);

	// Malformed package.json → no scripts, never throws.
	writeFileSync(path.join(tempRoot, "package.json"), "{ not json", "utf8");
	assert.deepEqual(await discoverVerifyScripts(tempRoot), []);

	// ── runVerifyScript pass/fail ────────────────────────────────────────
	writeFileSync(
		path.join(tempRoot, "package.json"),
		JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(3)\"" } }),
		"utf8",
	);
	const pass = await runVerifyScript(tempRoot, "check");
	assert.equal(pass.status, "pass");
	assert.equal(pass.exitCode, 0);
	assert.equal(pass.command, "npm run check");

	const fail = await runVerifyScript(tempRoot, "test");
	assert.equal(fail.status, "fail");
	assert.notEqual(fail.exitCode, 0);
	assert.equal(fail.command, "npm run test");
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}

// ── verifier fallback re-tints both the widget row and the subprocess ─────
// A runtime drive of runImplementationVerification through the synthesizer
// fallback path, recording the thinking level handed to every switchToVerifying
// activation and every verifier subprocess launch. After the fallback, both the
// Verify row and the subprocess must switch to the fallback verifier's level and
// stay in sync — never a stale hue from the original verifier.
{
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	const workRoot = mkdtempSync(path.join(tmpdir(), "moa-verify-fallback-cwd-"));
	const agentDir = mkdtempSync(path.join(tmpdir(), "moa-verify-fallback-agent-"));
	mkdirSync(path.join(agentDir, "mf-plan"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const SYNTHESIZER = { provider: "test", id: "synth-model" };
	// The fallback verifier's thinking comes from the config thinking override,
	// keyed by the synthesizer's model label.
	writeFileSync(
		path.join(agentDir, "mf-plan", "settings.json"),
		JSON.stringify({ synthesizer: SYNTHESIZER, thinkingOverrides: { "test/synth-model": "xhigh" } }),
		"utf8",
	);

	try {
		const VERIFIER = { provider: "test", id: "verifier-model" };
		const widgetThinking = []; // [status, thinking] per switchToVerifying activation
		const subprocessThinking = []; // thinkingOverride handed to each verifier launch

		const widget = {
			setActivePhase: () => {},
			switchToVerifying: (_ref, status, thinking) => widgetThinking.push([status, thinking]),
			getRoleStatus: () => ({}),
			updateRoleTranscript: () => {},
			updateRoleUsage: () => {},
			updateRoleActivity: () => {},
			updateRoleOutput: () => {},
			settleRoleRow: () => {},
			phaseModels: () => ({ Verify: VERIFIER }),
			setPhaseModels: () => {},
		};
		const host = {
			getActiveProgressWidget: () => widget,
			getPlanRepoSlug: () => undefined,
			setImplementationHandoff: () => {},
			setActiveCancelSession: () => {},
			stopActiveProgressWidget: () => {},
			markImplementationPending: () => {},
			noteRunError: () => {},
			pi: { sendUserMessage: async () => {} },
		};
		const ctx = {
			cwd: workRoot,
			hasUI: true,
			mode: "print",
			modelRegistry: { getRegisteredProviderIds: () => [], find: () => undefined },
			ui: {
				notify: () => {},
				// The failure-recovery dialog: choose the synthesizer fallback option.
				select: async (_title, opts) => opts.find((option) => /^Retry with /.test(option)),
			},
		};

		const completeVerdict = "## Verification Result\n**Verdict:** complete\n**Summary:** Every step landed.";
		const ok = (text) => ({
			cancelled: false, exitCode: 0, stopReason: "stop", errorMessage: undefined, stderr: undefined,
			messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		});
		const fail = () => ({
			cancelled: false, exitCode: 1, stopReason: "error", errorMessage: "verifier boom", stderr: "",
			messages: [],
		});

		let call = 0;
		const runSingleAgent = async (...args) => {
			subprocessThinking.push(args[8]); // positional thinkingOverride
			call++;
			// 1: initial preflight fails → triggers the fallback.
			// 2: post-fallback preflight succeeds.
			// 3: post-fallback verification returns a complete verdict.
			if (call === 1) return fail();
			if (call === 2) return ok("ok");
			return ok(completeVerdict);
		};

		const handoff = {
			plan: "# Plan\n\n1. Do the thing.",
			planFilePath: path.join(workRoot, "plan.md"),
			model: { provider: "test", id: "impl-model" },
			verifier: VERIFIER,
			verifierThinking: "low",
			verificationRepairs: 0,
			timestamp: 1,
		};

		await runImplementationVerification(ctx, host, handoff, "Implemented.", { runSingleAgent });

		// Three subprocess launches: the failing preflight, then the fallback
		// preflight and the fallback verification.
		assert.deepEqual(subprocessThinking, ["low", "xhigh", "xhigh"],
			"the initial verifier subprocess runs at the handoff level, and both fallback launches at the fallback level");

		// The Verify row is re-tinted to match at every activation.
		assert.deepEqual(widgetThinking[0], ["running project checks…", "low"], "the initial project-checks row uses the handoff verifier level");
		assert.deepEqual(widgetThinking[1], ["checking verifier…", "low"], "the first preflight row uses the handoff verifier level");
		const postFallback = widgetThinking.slice(2);
		assert.deepEqual(postFallback.map(([status]) => status), ["checking verifier…", "verifying implementation…"], "the fallback re-runs preflight then verification");
		assert.ok(postFallback.every(([, thinking]) => thinking === "xhigh"), "every post-fallback Verify activation is re-tinted to the fallback level, never a stale hue");

		// The row hue and the subprocess level agree on the fallback verifier.
		assert.equal(postFallback.at(-1)[1], subprocessThinking.at(-1), "the Verify row hue matches the level actually handed to the fallback subprocess");
	} finally {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(workRoot, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
}

console.log("Verification parser / task-builder / gate tests passed.");
