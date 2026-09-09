import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxThinking, registerFauxProvider } from "@earendil-works/pi-ai/compat";

const tempRoot = mkdtempSync(path.join(tmpdir(), "mf-plan-name-test-"));
const agentDir = path.join(tempRoot, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let faux;

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

	faux = registerFauxProvider({
		api: "mf-plan-name-test",
		models: [{ id: "cheap" }],
	});
	const cheapModel = faux.getModel("cheap");
	let calledModel;
	let requestedReasoning;
	faux.setResponses([(_context, options, _state, model) => {
		calledModel = model;
		requestedReasoning = options?.reasoning;
		return fauxAssistantMessage([fauxThinking("no visible answer")]);
	}]);

	const { summarizePlanPromptName } = await import("../src/config/planName.ts");
	const ctx = {
		modelRegistry: {
			find: (provider, id) => provider === cheapModel.provider && id === cheapModel.id ? cheapModel : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	};

	const name = await summarizePlanPromptName(ctx, "Create standalone SVG portrait");
	assert.equal(name, "create-standalone-svg-portrait");
	assert.equal(calledModel, cheapModel, "the configured cheap model must handle naming");
	assert.equal(requestedReasoning, undefined, "plan naming must keep reasoning disabled");
	assert.notEqual(name, "halcyon-warm-tiger", "an empty model response must not become a random slug");
} finally {
	faux?.unregister();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("plan name tests passed");
