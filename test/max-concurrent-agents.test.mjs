import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const {
	normalizeMaxConcurrentAgents,
	MIN_CONCURRENT_AGENTS,
	MAX_CONCURRENT_AGENTS,
	DEFAULT_MAX_CONCURRENT_AGENTS,
} = await import("../src/config/settings.ts");
const { mapWithConcurrencyLimit } = await import("../src/runtime/processPool.ts");

assert.equal(MIN_CONCURRENT_AGENTS, 1);
assert.equal(MAX_CONCURRENT_AGENTS, 8);
assert.equal(DEFAULT_MAX_CONCURRENT_AGENTS, 1);

for (const value of [undefined, null, "3", {}, [], NaN, Infinity, -Infinity, true]) {
	assert.equal(normalizeMaxConcurrentAgents(value), 1);
}
assert.equal(normalizeMaxConcurrentAgents(-4), 1);
assert.equal(normalizeMaxConcurrentAgents(0), 1);
assert.equal(normalizeMaxConcurrentAgents(1), 1);
assert.equal(normalizeMaxConcurrentAgents(5), 5);
assert.equal(normalizeMaxConcurrentAgents(8), 8);
assert.equal(normalizeMaxConcurrentAgents(99), 8);
assert.equal(normalizeMaxConcurrentAgents(2.4), 2);
assert.equal(normalizeMaxConcurrentAgents(2.5), 3);
for (const value of [1, 2.5, 8, 99]) {
	assert.equal(Number.isInteger(normalizeMaxConcurrentAgents(value)), true);
}

// mapWithConcurrencyLimit determinism: peak matches limit, order preserved.
async function peakAtLimit(limit, count) {
	let inFlight = 0;
	let peak = 0;
	const holdMs = 50;
	const results = await mapWithConcurrencyLimit(
		Array.from({ length: count }, (_unused, index) => index),
		limit,
		async (index) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, holdMs));
			inFlight--;
			return index;
		},
	);
	assert.deepEqual(results, Array.from({ length: count }, (_unused, index) => index));
	return peak;
}

{
	const peak1 = await peakAtLimit(1, 6);
	assert.equal(peak1, 1);
	const peak3 = await peakAtLimit(3, 6);
	assert.equal(peak3, 3);
}

// Source-contract assertions
const runner = readFileSync(path.join(root, "src/runtime/runner.ts"), "utf8");
assert.doesNotMatch(runner, /MAX_CONCURRENCY/);
assert.match(runner, /MAX_PARALLEL_TASKS = 8/);
assert.match(runner, /mapWithConcurrencyLimit\(tasks, maxConcurrency/);
assert.equal((runner.match(/mapWithConcurrencyLimit\(tasks, maxConcurrency/g) ?? []).length, 2);

const fanoutWiring = readFileSync(path.join(root, "src/moa/fanoutWiring.ts"), "utf8");
assert.match(fanoutWiring, /maxConcurrency,/);
assert.match(fanoutWiring, /onStart:/);

const debateFanout = readFileSync(path.join(root, "src/debate/debateFanout.ts"), "utf8");
assert.match(debateFanout, /maxConcurrency,/);
assert.match(debateFanout, /onStart:/);

const mfPlanSubagent = readFileSync(path.join(root, "src/planning/tools/mfPlanSubagent.ts"), "utf8");
assert.match(mfPlanSubagent, /\{ maxConcurrency \}/);
assert.match(mfPlanSubagent, /loadMoaConfig\(\)\.maxConcurrentAgents/);

const orchestration = readFileSync(path.join(root, "src/moa/orchestration.ts"), "utf8");
assert.match(orchestration, /loadMoaConfig\(\)\.maxConcurrentAgents/);

const runOpinion = readFileSync(path.join(root, "src/opinion/runOpinion.ts"), "utf8");
assert.match(runOpinion, /settings\.maxConcurrentAgents/);

const runDebate = readFileSync(path.join(root, "src/debate/runDebate.ts"), "utf8");
assert.match(runDebate, /settings\.maxConcurrentAgents/);

console.log("Max concurrent agents tests passed.");
