import assert from "node:assert/strict";

const taskArg = process.argv.find((arg) => arg.startsWith("Task: "));
if (taskArg?.includes("child-malformed-stream")) {
	const events = [
		"not-json",
		JSON.stringify({ type: 42 }),
		JSON.stringify({ type: "message_start" }),
		JSON.stringify({ type: "message_end", message: { role: "user", content: "child prompt" } }),
		JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
		JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ignored" } }),
		JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 } }),
		JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } }),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				usage: { input: -5, output: 2, cacheRead: -1, cacheWrite: 0, totalTokens: 2, cost: { total: -3 } },
				model: "test/model",
				stopReason: "stop",
			},
		}),
	];
	process.stdout.write(`${events.join("\n")}\n`);
	process.exit(0);
}
if (taskArg?.includes("child-signal-term")) {
	process.kill(process.pid, "SIGTERM");
	setInterval(() => {}, 1000);
} else if (taskArg?.includes("child-ignore-term")) {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else {
	const { cleanupTrackedProcesses } = await import("../src/runtime/processPool.ts");
	const { OutputActivityTracker } = await import("../src/runtime/activityTracking.ts");
	const { parseSessionEvent } = await import("../src/runtime/wire.ts");
	const { runSingleAgent } = await import("../src/runtime/runner.ts");

	const validStart = JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } });
	assert.equal(parseSessionEvent("not-json"), undefined);
	assert.equal(parseSessionEvent("{}"), undefined);
	assert.equal(parseSessionEvent('{"type":42}'), undefined);
	assert.equal(parseSessionEvent('{"type":"message_start"}'), undefined);
	assert.equal(parseSessionEvent('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x"}}'), undefined);
	assert.equal(parseSessionEvent('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x","contentIndex":1000000000}}'), undefined);
	assert.equal(parseSessionEvent('{"type":"tool_execution_start"}'), undefined);
	assert.equal(parseSessionEvent('{"type":"message_end","message":{"role":"user","content":"prompt"}}')?.type, "message_end");
	assert.equal(parseSessionEvent('{"type":"message_end","message":{"role":"assistant","content":[null]}}'), undefined);
	assert.equal(parseSessionEvent('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":42}]}}'), undefined);
	assert.equal(parseSessionEvent('{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall"}}}'), undefined);
	assert.equal(parseSessionEvent(validStart)?.type, "message_start");
	assert.equal(parseSessionEvent('{"type":"future_event","extra":true}')?.type, "future_event");
	assert.equal(
		parseSessionEvent('{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":"bad"}}}')?.type,
		"message_end",
	);

	const agents = [{
		name: "fixture",
		description: "fixture",
		systemPrompt: "",
		source: "project",
		tools: ["read"],
	}];

	const malformedResult = await runSingleAgent(
		process.cwd(), agents, "fixture", "child-malformed-stream", undefined, undefined, undefined,
	);
	assert.equal(malformedResult.exitCode, 0);
	assert.equal(malformedResult.messages.length, 2);
	assert.equal(malformedResult.messages[0].role, "user");
	assert.equal(malformedResult.messages[0].content, "child prompt");
	assert.equal(malformedResult.messages[1].content[0].text, "hello");
	assert.equal(malformedResult.activity, "read README.md");
	assert.equal(malformedResult.usage.input, 0);
	assert.equal(malformedResult.usage.output, 2);
	assert.equal(malformedResult.usage.cacheRead, 0);
	assert.equal(malformedResult.usage.cost, 0);
	assert.equal(malformedResult.usage.toolCalls, 1);
	assert.equal(Number.isFinite(malformedResult.usage.output), true);

	const activity = new OutputActivityTracker();
	activity.messageEnd({ role: "assistant", content: [], usage: { output: -10 } });
	assert.deepEqual(activity.snapshot(), { tokens: 0, revision: 0 });

	const signalled = await runSingleAgent(
		process.cwd(), agents, "fixture", "child-signal-term", undefined, undefined, undefined,
	);
	assert.equal(signalled.signalCode, "SIGTERM");
	assert.notEqual(signalled.exitCode, 0);

	const controller = new AbortController();
	const abortPromise = runSingleAgent(
		process.cwd(), agents, "fixture", "child-ignore-term abort", undefined, controller.signal, undefined,
		undefined, undefined, { resolveOnAbort: true, killTimeoutMs: 25 },
	);
	setTimeout(() => controller.abort(), 100);
	const aborted = await abortPromise;
	assert.equal(aborted.cancelled, true);
	assert.equal(aborted.signalCode, "SIGKILL");

	const reloadPromise = runSingleAgent(
		process.cwd(), agents, "fixture", "child-ignore-term reload", undefined, undefined, undefined,
	);
	setTimeout(() => cleanupTrackedProcesses(25), 100);
	const reloaded = await reloadPromise;
	assert.equal(reloaded.signalCode, "SIGKILL");
	assert.notEqual(reloaded.exitCode, 0);

	console.log("Subagent trust-boundary tests passed.");
}
