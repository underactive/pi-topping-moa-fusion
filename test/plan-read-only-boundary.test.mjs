import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getReadOnlyAgentTools, READ_ONLY_SUBAGENT_ENV } from "../src/runtime/runner.ts";
import { MutationTripwire, diffWorkingTreeStates, formatMutationWarning, porcelainPath } from "../src/runtime/mutationTripwire.ts";
import { FOLLOW_UP } from "../src/shared/modelRefs.ts";

const root = path.resolve(import.meta.dirname, "..");
const orchestration = ["src/index.ts", "src/planning/planMode.ts", "src/planning/tools/shared.ts", "src/planning/tools/enterPlanMode.ts", "src/planning/tools/exitPlanMode.ts", "src/planning/tools/mfPlanSubagent.ts", "src/moa/orchestration.ts", "src/moa/fanout.ts", "src/moa/synthesis.ts", "src/moa/reviewLoop.ts", "src/moa/verification.ts", "src/opinion/runOpinion.ts", "src/opinion/opinionFanout.ts", "src/debate/runDebate.ts", "src/debate/debateFanout.ts"]
	.map((file) => readFileSync(path.join(root, file), "utf8"))
	.join("\n");
const runner = readFileSync(path.join(root, "src/runtime/runner.ts"), "utf8");
const processPool = readFileSync(path.join(root, "src/runtime/processPool.ts"), "utf8");

// Missing or stale user-installed agent definitions must never restore the
// subprocess defaults (which include bash/edit/write).
assert.deepEqual(getReadOnlyAgentTools(), ["read", "grep", "find", "ls"]);
assert.deepEqual(
	getReadOnlyAgentTools(["read", "bash", "edit", "write", "Agent", "grep"]),
	["read", "grep"],
);
assert.deepEqual(getReadOnlyAgentTools(["edit", "write"]), []);
assert.match(runner, /args\.push\("--tools", getReadOnlyAgentTools\(agent\.tools\)\.join\(","\)\)/);

// Parent plan mode must use an allowlist, not pass through every active tool
// except a short list of known mutators. Generic agents and bash are excluded.
assert.match(orchestration, /PLAN_MODE_READ_ONLY_TOOLS/);

// The plan-mode tools that can share a message with the ask_user_question
// questionnaire must run sequentially, so a model that emits both resolves the
// questionnaire first and mf-plan's own overlays never draw over it. Assert
// per-file so a single occurrence can't satisfy all three.
for (const toolFile of ["src/planning/tools/exitPlanMode.ts", "src/planning/tools/enterPlanMode.ts", "src/planning/tools/mfPlanSubagent.ts"]) {
	assert.match(readFileSync(path.join(root, toolFile), "utf8"), /executionMode: "sequential"/);
}
assert.match(orchestration, /activeToolNames\.filter\(\(name\) => PLAN_MODE_READ_ONLY_TOOLS\.has\(name\)\)/);
assert.doesNotMatch(orchestration, /PLAN_MODE_DISABLED_TOOLS/);
assert.doesNotMatch(
	orchestration.match(/const PLAN_MODE_READ_ONLY_TOOLS[\s\S]*?\]\);/)?.[0] ?? "",
	/"bash"|"Agent"|"edit"|"write"/,
);

// The custom plan subagent tool cannot be pointed at an arbitrary user agent.
assert.match(orchestration, /const PLAN_SUBAGENT_NAMES = new Set\(\["moa-explore", "mf-plan"\]\)/);
assert.match(orchestration, /Agent .* is not allowed in plan mode\. Use only moa-explore or mf-plan\./);

// ── Agentic provider bridges (e.g. cursor-bridge) run their OWN local tools ──
// pi's --tools allowlist cannot restrain them. Every planning subprocess must
// therefore carry the read-only env handshake, and the parent session must
// apply/restore it around plan mode for in-process bridges.
assert.equal(READ_ONLY_SUBAGENT_ENV.PI_CURSOR_FORCE_MODE, "plan");
assert.equal(READ_ONLY_SUBAGENT_ENV.PI_CLAUDE_BRIDGE_FORCE_MODE, "read");
assert.match(runner, /env: \{ \.\.\.process\.env, \.\.\.READ_ONLY_SUBAGENT_ENV, \.\.\.USAGE_BEACON_SUBAGENT_ENV \}/);
assert.match(runner, /const USAGE_BEACON_SUBAGENT_ENV = Object\.freeze\(\{ PI_USAGE_BEACON: "1" \}\)/);
assert.match(orchestration, /applyReadOnlyProviderEnv\(\);\s*\n\s*pi\.setActiveTools\(getPlanModeTools\(toolsBeforePlanMode\)\);/);
assert.match(orchestration, /restoreReadOnlyProviderEnv\(\);\s*\n\s*pi\.setActiveTools\(restored\.filter\(\(name\) => !PLAN_ONLY_REGISTERED_TOOLS\.includes\(name\)\)\);/);

// Plan-mode-only registered tools (write_plan, exit_plan_mode, mf_plan_subagent)
// must be deactivated in sessions that are NOT in plan mode — registerTool()
// activates them session-wide, and models were picking mf_plan_subagent over
// the general-purpose subagent tool during normal agentic sessions.
assert.match(orchestration, /const PLAN_ONLY_REGISTERED_TOOLS = \["write_plan", "exit_plan_mode", "mf_plan_subagent"\]/);
assert.match(orchestration, /\} else \{[^}]*pi\.setActiveTools\(pi\.getActiveTools\(\)\.filter\(\(name\) => !PLAN_ONLY_REGISTERED_TOOLS\.includes\(name\)\)\);[^}]*\}\s*\n\s*updateStatus\(ctx\);/);

// Restoring the env on approval is inert for a running agentic-bridge query — it
// keeps the read-only tool set it was created with for the whole planning turn,
// and (for claude-bridge) a message riding alongside the trailing tool result is
// replayed as a continuation that INHERITS that read-only tool set. So
// single-model approval must NOT return the go-ahead in-turn: it tells the model
// to STOP (ending the read-only query) and delivers implementation as a separate
// follow-up, which pi drains as a fresh, full-access query. Guard both halves.
assert.deepEqual(FOLLOW_UP, { deliverAs: "followUp" });
assert.match(
	orchestration,
	/host\.pi\.sendUserMessage\(\s*buildImplementationKickoffMessage\([^)]+\),\s*FOLLOW_UP,\s*\)/,
);
assert.match(orchestration, /Stop here — do not write files, run commands, or call any tools in this turn/);
// The buggy in-turn/terminate approaches must not creep back in.
assert.doesNotMatch(orchestration, /pendingImplementationKickoff/);
assert.doesNotMatch(orchestration, /terminate: true/);

// Every session shutdown restores extension-owned provider environment state
// and terminates tracked subprocesses.
assert.match(
	orchestration,
	/onSessionShutdown: \(_event: \{ reason: string \}\) => \{\s*implementationPending = false;\s*lastImplementationStopReason = undefined;\s*lastImplementationReport = undefined;\s*resetImplementationTranscript\(\);\s*stopActiveProgressWidget\(\);\s*restoreReadOnlyProviderEnv\(\);\s*cleanupTrackedProcesses\(\);/,
);

// ── The read-only verifier subprocess is spawned like every planning agent ──
// (runSingleAgent applies the --tools allowlist + read-only env handshake), and
// its task text carries the read-only planning contract so a bridged verifier
// that loses the moa-verifier system prompt still knows not to edit or run
// commands. Its snapshot script gate runs in the parent, never the subprocess.
// The verifier launches through the injectable `runVerifier` seam, which
// defaults to the real runSingleAgent (same --tools allowlist + read-only env
// handshake) — the injection is test-only and cannot weaken the boundary.
assert.match(orchestration, /const runVerifier = options\.runSingleAgent \?\? runSingleAgent/);
assert.match(orchestration, /runVerifier\(\s*ctx\.cwd, agents, "moa-verifier"/);
assert.match(orchestration, /do NOT edit files, and do NOT run builds, tests, or any command/);

// Cleanup captures the targets, signals them, then clears the registry. The
// delayed callback must inspect that snapshot rather than the cleared set.
assert.match(
	processPool,
	/const processes = \[\.\.\.trackedProcesses\];\s*for \(const proc of processes\) \{[\s\S]*?proc\.kill\("SIGTERM"\)[\s\S]*?\}\s*trackedProcesses\.clear\(\);[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?for \(const proc of processes\)/,
);
assert.match(processPool, /proc\.exitCode !== null \|\| proc\.signalCode !== null/);
assert.match(
	processPool,
	/setTimeout\(\(\) => \{[\s\S]*?for \(const proc of processes\) \{[\s\S]*?proc\.kill\("SIGKILL"\)/,
);
assert.doesNotMatch(processPool, /setTimeout\(\(\) => \{\s*for \(const proc of trackedProcesses\)/);
assert.doesNotMatch(processPool, /if \(!proc\.killed\)/);
assert.match(processPool, /proc\.exitCode !== null \|\| proc\.signalCode !== null/);

// ── Mutation tripwire: the read-only boundary is cooperative, so the MoA ──
// orchestration and the plan subagent tool must snapshot git state and warn
// when the working tree changes while planning agents run.
assert.match(orchestration, /await tripwire\.arm\(ctx\.cwd\)/);
assert.match(orchestration, /warnIfMutated\("MoA proposer fan-out"\)/);
assert.match(orchestration, /warnIfMutated\("MoA synthesis"\)/);
assert.match(orchestration, /formatMutationWarning\("plan-mode subagents", changed\)/);
assert.match(orchestration, /formatMutationWarning\("MoA opinion fan-out", changed\)/);
assert.match(orchestration, /formatMutationWarning\("MoA debate rounds", changed\)/);

// Pure diff behavior.
assert.deepEqual(diffWorkingTreeStates("", " M a.ts\n?? b.ts\n"), ["a.ts", "b.ts"]);
assert.deepEqual(diffWorkingTreeStates(" M a.ts\n", " M a.ts\n"), []);
assert.deepEqual(diffWorkingTreeStates(" M a.ts\n", ""), ["a.ts"]); // reverted counts too
assert.equal(porcelainPath(' M "space \\t and unicode-λ.ts"'), "space \t and unicode-λ.ts");
assert.equal(porcelainPath('R  "old -> name.ts" -> "new \\n name.ts"'), "old -> name.ts -> new \n name.ts");
assert.match(formatMutationWarning("MoA synthesis", ["a.ts"]), /changed during MoA synthesis/);
assert.match(
	formatMutationWarning("x", ["1", "2", "3", "4", "5", "6", "7", "8"]),
	/\(\+2 more\)/,
);

// Live tripwire against a scratch git repo: arm → mutate → detect → re-baseline.
const scratch = mkdtempSync(path.join(os.tmpdir(), "moa-tripwire-"));
try {
	execFileSync("git", ["init", "-q"], { cwd: scratch });
	const tripwire = new MutationTripwire();
	const dirtyPath = path.join(scratch, "already-dirty.ts");
	writeFileSync(dirtyPath, "staged baseline\n");
	execFileSync("git", ["add", "already-dirty.ts"], { cwd: scratch });
	writeFileSync(dirtyPath, "dirty before arm\n");
	const nestedDirectory = path.join(scratch, "untracked-dir");
	mkdirSync(path.join(nestedDirectory, "nested"), { recursive: true });
	const nestedPath = path.join(nestedDirectory, "nested", "file.ts");
	writeFileSync(nestedPath, "untracked baseline\n");
	await tripwire.arm(scratch);
	assert.deepEqual(await tripwire.check(scratch), []);
	writeFileSync(dirtyPath, "changed again while status stays AM\n");
	assert.deepEqual(await tripwire.check(scratch), ["already-dirty.ts"]);
	assert.deepEqual(await tripwire.check(scratch), []);
	writeFileSync(nestedPath, "changed beneath an already-untracked directory\n");
	assert.deepEqual(await tripwire.check(scratch), ["untracked-dir/"]);
	assert.deepEqual(await tripwire.check(scratch), []);
	writeFileSync(path.join(scratch, "rogue.ts"), "mutated by a proposer\n");
	assert.deepEqual(await tripwire.check(scratch), ["rogue.ts"]);
	// Re-baselined: the same change is not reported twice.
	assert.deepEqual(await tripwire.check(scratch), []);
	const unusualPath = "odd\tλ.ts";
	writeFileSync(path.join(scratch, unusualPath), "unusual path\n");
	assert.deepEqual(await tripwire.check(scratch), [unusualPath]);
	// Non-git directories disarm gracefully.
	const plain = mkdtempSync(path.join(os.tmpdir(), "moa-tripwire-plain-"));
	try {
		const disarmed = new MutationTripwire();
		await disarmed.arm(plain);
		assert.deepEqual(await disarmed.check(plain), []);
	} finally {
		rmSync(plain, { recursive: true, force: true });
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log("Plan read-only boundary contract passed.");
