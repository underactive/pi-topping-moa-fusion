import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const taskArg = process.argv.find((arg) => arg.startsWith("Task: "));

if (taskArg?.includes("concurrency-probe")) {
	const probeDir = process.env.MF_CONCURRENCY_PROBE_DIR;
	if (!probeDir) process.exit(1);
	const marker = path.join(probeDir, `active-${process.pid}`);
	writeFileSync(marker, String(process.pid), "utf8");
	if (taskArg.includes("active-cancel")) {
		writeFileSync(path.join(probeDir, "started-active-cancel"), String(process.pid), "utf8");
	}

	let peak = 1;
	const sample = () => {
		const active = readdirSync(probeDir).filter((name) => name.startsWith("active-")).length;
		peak = Math.max(peak, active);
	};
	const interval = setInterval(sample, 25);
	sample();

	setTimeout(() => {
		clearInterval(interval);
		sample();
		writeFileSync(path.join(probeDir, `peak-${process.pid}`), String(peak), "utf8");
		try { rmSync(marker); } catch { /* ignore */ }
		const event = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "probe ok" }],
				usage: { input: 0, output: 1 },
				stopReason: "stop",
			},
		});
		process.stdout.write(`${event}\n`);
		process.exit(0);
	}, 250);
} else {
	const { runParallelAgents, runParallelAgentsWithModels } = await import("../src/runtime/runner.ts");

	const agents = [{
		name: "fixture",
		description: "fixture",
		systemPrompt: "",
		source: "project",
		tools: ["read"],
	}];

	const probeDir = mkdtempSync(path.join(tmpdir(), "parallel-agent-concurrency-"));
	process.env.MF_CONCURRENCY_PROBE_DIR = probeDir;

	const clearPeaks = () => {
		for (const name of readdirSync(probeDir)) {
			if (name.startsWith("peak-") || name.startsWith("active-") || name.startsWith("started-")) {
				rmSync(path.join(probeDir, name), { force: true });
			}
		}
	};

	const observedPeak = () => {
		let peak = 0;
		for (const name of readdirSync(probeDir)) {
			if (name.startsWith("peak-")) {
				peak = Math.max(peak, Number.parseInt(readFileSync(path.join(probeDir, name), "utf8"), 10));
			}
		}
		return peak;
	};

	const peakFileCount = () => readdirSync(probeDir).filter((name) => name.startsWith("peak-")).length;

	const waitForFile = async (name) => {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (readdirSync(probeDir).includes(name)) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.fail(`Timed out waiting for ${name}`);
	};

	const probeTasks = (count, prefix = "concurrency-probe") => Array.from({ length: count }, (_unused, index) => ({
		agent: "fixture",
		task: `${prefix} slot ${index + 1}`,
	}));

	try {
		clearPeaks();
		await runParallelAgents(
			process.cwd(), agents, probeTasks(4), undefined, undefined, undefined, undefined,
			{ maxConcurrency: 1 },
		);
		assert.equal(observedPeak(), 1, "limit 1 via runParallelAgents");

		clearPeaks();
		await runParallelAgents(
			process.cwd(), agents, probeTasks(4), undefined, undefined, undefined, undefined,
			{ maxConcurrency: 3 },
		);
		const peak3 = observedPeak();
		assert.ok(peak3 <= 3, `peak must be ≤ 3, got ${peak3}`);
		assert.ok(peak3 >= 2, `peak must be ≥ 2, got ${peak3}`);

		clearPeaks();
		await runParallelAgents(
			process.cwd(), agents, probeTasks(4), undefined, undefined, undefined, undefined,
		);
		assert.equal(observedPeak(), 1, "omitted options defaults to 1");

		const modelTasks = (count) => Array.from({ length: count }, (_unused, index) => ({
			agent: "fixture",
			task: `concurrency-probe model ${index + 1}`,
			model: "test/model",
		}));

		clearPeaks();
		await runParallelAgentsWithModels(
			process.cwd(), agents, modelTasks(4), undefined, undefined, undefined,
			{ maxConcurrency: 1 },
		);
		assert.equal(observedPeak(), 1, "limit 1 via runParallelAgentsWithModels");

		clearPeaks();
		const started = [];
		await runParallelAgentsWithModels(
			process.cwd(), agents, modelTasks(4), undefined, undefined, undefined,
			{ maxConcurrency: 1, onStart: (index) => started.push(index) },
		);
		assert.deepEqual(started, [0, 1, 2, 3], "each queued model task reports when it acquires the sole slot");

		clearPeaks();
		await runParallelAgentsWithModels(
			process.cwd(), agents, modelTasks(4), undefined, undefined, undefined,
			{ maxConcurrency: 3 },
		);
		const peak3models = observedPeak();
		assert.ok(peak3models <= 3);
		assert.ok(peak3models >= 2);

		// Queued cancellation: abort task 3 from onEach when task 1 settles.
		clearPeaks();
		const controllers = [new AbortController(), new AbortController(), new AbortController()];
		const cancelTasks = controllers.map((controller, index) => ({
			agent: "fixture",
			task: `concurrency-probe cancel ${index + 1}`,
			signal: controller.signal,
		}));
		let settledFirst = false;
		const results = await runParallelAgents(
			process.cwd(), agents, cancelTasks, undefined, undefined,
			(index, result) => {
				if (index === 0 && !result.cancelled && result.exitCode === 0) {
					settledFirst = true;
					controllers[2].abort();
				}
			},
			undefined,
			{ maxConcurrency: 1 },
		);
		assert.equal(settledFirst, true);
		assert.equal(results[2].cancelled, true);
		assert.equal(results[2].exitCode, 130);
		assert.equal(peakFileCount(), 2, "cancelled queued task must never spawn");
		assert.notEqual(results[1].cancelled, true);

		// Cancelling an active child frees the sole slot for its queued sibling.
		clearPeaks();
		const activeController = new AbortController();
		const activeRun = runParallelAgents(
			process.cwd(), agents,
			[
				{ agent: "fixture", task: "concurrency-probe active-cancel", signal: activeController.signal },
				{ agent: "fixture", task: "concurrency-probe active-cancel sibling" },
			],
			undefined, undefined, undefined, undefined,
			{ maxConcurrency: 1 },
		);
		await waitForFile("started-active-cancel");
		activeController.abort();
		const activeResults = await activeRun;
		assert.equal(activeResults[0].cancelled, true);
		assert.notEqual(activeResults[0].exitCode, 0);
		assert.equal(activeResults[1].exitCode, 0);
		assert.notEqual(activeResults[1].cancelled, true);

		await assert.rejects(
			() => runParallelAgents(process.cwd(), agents, probeTasks(9), undefined, undefined, undefined, undefined, { maxConcurrency: 8 }),
			/Too many parallel tasks \(9\)\. Max is 8\./,
		);
	} finally {
		delete process.env.MF_CONCURRENCY_PROBE_DIR;
		rmSync(probeDir, { recursive: true, force: true });
	}

	console.log("Parallel agent concurrency tests passed.");
}
