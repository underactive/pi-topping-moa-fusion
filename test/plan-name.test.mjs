import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(tmpdir(), "mf-plan-name-test-"));
const agentDir = path.join(tempRoot, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

try {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(path.join(agentDir, "mf-plan"), { recursive: true });
	writeFileSync(
		path.join(agentDir, "mf-plan", "settings.json"),
		JSON.stringify({
			useSummaryName: true,
			cheap: { provider: "faux", id: "cheap" },
		}),
		"utf8",
	);

	const cheapModel = { provider: "faux", id: "cheap" };
	const calls = [];
	let nextResponse;
	let throwSynchronously = false;
	const modelRegistry = {
		find: (provider, id) => provider === cheapModel.provider && id === cheapModel.id ? cheapModel : undefined,
		streamSimple: (model, context, options) => {
			calls.push({ model, context, options });
			if (throwSynchronously) throw new Error("missing auth");
			const response = nextResponse;
			return { result: async () => response };
		},
	};
	const ctx = { modelRegistry };
	const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason });

	const { summarizePlanPromptName } = await import("../src/config/planName.ts");

	// A visible text response is slugified and the configured cheap model handles naming.
	nextResponse = assistant([{ type: "text", text: "standalone svg portrait maker" }]);
	const name = await summarizePlanPromptName(ctx, "Create standalone SVG portrait");
	assert.equal(name, "standalone-svg-portrait-maker");
	assert.equal(calls.at(-1).model, cheapModel, "the configured cheap model must handle naming");
	assert.equal(calls.at(-1).options?.reasoning, undefined, "plan naming must keep reasoning disabled");
	assert.match(calls.at(-1).context.messages[0].content[0].text, /Create standalone SVG portrait/);

	// Thinking-only and empty text responses fall back to the prompt-derived slug.
	nextResponse = assistant([{ type: "thinking", thinking: "no visible answer" }]);
	assert.equal(
		await summarizePlanPromptName(ctx, "Create standalone SVG portrait"),
		"create-standalone-svg-portrait",
	);
	nextResponse = assistant([{ type: "text", text: "   " }]);
	assert.equal(
		await summarizePlanPromptName(ctx, "Create standalone SVG portrait"),
		"create-standalone-svg-portrait",
	);

	// An already-aborted signal must short-circuit before streamSimple is called.
	{
		const callsBefore = calls.length;
		const controller = new AbortController();
		controller.abort();
		const abortedName = await summarizePlanPromptName(ctx, "Create standalone SVG portrait", { signal: controller.signal });
		assert.equal(abortedName, "create-standalone-svg-portrait");
		assert.equal(calls.length, callsBefore);
	}

	// A live signal is threaded to the registry stream without changing the happy path.
	{
		nextResponse = assistant([{ type: "text", text: "standalone svg portrait maker" }]);
		const controller = new AbortController();
		const liveName = await summarizePlanPromptName(ctx, "Create standalone SVG portrait", { signal: controller.signal });
		assert.equal(liveName, "standalone-svg-portrait-maker");
		assert.equal(calls.at(-1).options?.signal, controller.signal);
		assert.equal(calls.at(-1).options?.signal.aborted, false);
	}

	// A resolved aborted response and a synchronous registry failure both fall back.
	nextResponse = assistant([], "aborted");
	assert.equal(
		await summarizePlanPromptName(ctx, "Create standalone SVG portrait"),
		"create-standalone-svg-portrait",
	);
	throwSynchronously = true;
	assert.equal(
		await summarizePlanPromptName(ctx, "Create standalone SVG portrait"),
		"create-standalone-svg-portrait",
	);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("plan name tests passed");
