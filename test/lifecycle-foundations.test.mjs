import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/index.ts transitively loads overlay modules that use TypeScript parameter
// properties, so execute this assertion script under Node's TS transform.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], {
			stdio: "inherit",
		});
	} catch (err) {
		process.exit(err.status ?? 1);
	}
	process.exit(0);
}

const { default: mfPlanExtension } = await import("../src/index.ts");
const { READ_ONLY_SUBAGENT_ENV } = await import("../src/runtime/runner.ts");
const [[envKey, planValue]] = Object.entries(READ_ONLY_SUBAGENT_ENV);
const previousEnvValue = process.env[envKey];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-lifecycle-test-"));

let activeTools = ["read", "write"];
const commands = new Map();
const handlers = new Map();
const appendedEntries = [];
const fakePi = {
	getThinkingLevel: () => "medium",
	getAllTools: () => [{ name: "read" }, { name: "write" }],
	getActiveTools: () => activeTools,
	setActiveTools: (tools) => { activeTools = tools; },
	appendEntry: (type, data) => { appendedEntries.push({ type, data }); },
	registerFlag: () => {},
	registerCommand: (name, options) => commands.set(name, options),
	registerShortcut: () => {},
	registerTool: () => {},
	on: (name, handler) => handlers.set(name, handler),
	getFlag: () => false,
};
const commandContext = {
	hasUI: false,
	cwd: tempRoot,
	ui: {
		notify: () => {},
		setStatus: () => {},
		theme: { fg: (_color, text) => text },
	},
};

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	mfPlanExtension(fakePi);
	const shutdown = handlers.get("session_shutdown");
	const sessionStart = handlers.get("session_start");
	const togglePlanMode = commands.get("mf-plan");
	assert.equal(typeof shutdown, "function");
	assert.equal(typeof sessionStart, "function");
	assert.equal(typeof handlers.get("agent_before_settle"), "function");
	assert.equal(handlers.has("context_with_system"), false);
	assert.equal(typeof togglePlanMode?.handler, "function");

	const indexSource = readFileSync(new URL("../src/moa/reviewLoop.ts", import.meta.url), "utf8");
	assert.match(
		indexSource,
		/const revisionVerdicts =[\s\S]*?activeRunMoaInfo\.synthesizer = getSynthesizer\(\);[\s\S]*?persistState\(\);[\s\S]*?currentPlan = revisionVerdicts\.remainingPlan;/,
		"successful review revisions must persist the synthesizer that produced them",
	);

	const moaInfo = {
		proposers: [{ provider: "p", id: "one" }],
		synthesizer: { provider: "p", id: "synth" },
		proposerPlans: [{ proposerIndex: 0, model: { provider: "p", id: "one" }, markdown: "# Plan" }],
		verdictsMarkdown: "## Proposer Verdicts",
	};
	await sessionStart({}, {
		...commandContext,
		sessionManager: { getEntries: () => [{ type: "custom", customType: "mf-plan", data: { enabled: true, slug: "tidy-wolf", repoPlanSlug: "repo-plan", moaInfo } }] },
	});
	await togglePlanMode.handler("", commandContext); // exit and persist restored metadata
	assert.deepEqual(appendedEntries.at(-1).data.moaInfo, { ...moaInfo, proposerPlans: undefined });

	const oversizedMoaInfo = {
		...moaInfo,
		proposerPlans: [{ ...moaInfo.proposerPlans[0], markdown: "x".repeat(600 * 1024) }],
	};
	await sessionStart({}, {
		...commandContext,
		sessionManager: { getEntries: () => [{ type: "custom", customType: "mf-plan", data: { enabled: true, slug: "tidy-wolf", moaInfo: oversizedMoaInfo } }] },
	});
	await togglePlanMode.handler("", commandContext);
	assert.equal(appendedEntries.at(-1).data.moaInfo.proposerPlans, undefined);
	assert.deepEqual(appendedEntries.at(-1).data.moaInfo.proposers, moaInfo.proposers);
	assert.equal(appendedEntries.at(-1).data.moaInfo.verdictsMarkdown, moaInfo.verdictsMarkdown);
	assert.ok(Buffer.byteLength(JSON.stringify(appendedEntries.at(-1).data), "utf8") <= 512 * 1024);

	const oversizedVerdictsMoaInfo = {
		...moaInfo,
		proposerPlans: undefined,
		verdictsMarkdown: "v".repeat(600 * 1024),
	};
	await sessionStart({}, {
		...commandContext,
		sessionManager: { getEntries: () => [{ type: "custom", customType: "mf-plan", data: { enabled: true, slug: "tidy-wolf", moaInfo: oversizedVerdictsMoaInfo } }] },
	});
	await togglePlanMode.handler("", commandContext);
	assert.equal(appendedEntries.at(-1).data.moaInfo, undefined);
	assert.ok(Buffer.byteLength(JSON.stringify(appendedEntries.at(-1).data), "utf8") <= 512 * 1024);

	const mismatchedMoaInfo = {
		...moaInfo,
		proposerPlans: [{ proposerIndex: 0, model: { provider: "p", id: "different" }, markdown: "# Misattributed" }],
	};
	await sessionStart({}, {
		...commandContext,
		sessionManager: { getEntries: () => [{ type: "custom", customType: "mf-plan", data: { enabled: true, slug: "tidy-wolf", moaInfo: mismatchedMoaInfo } }] },
	});
	await togglePlanMode.handler("", commandContext);
	assert.equal(appendedEntries.at(-1).data.moaInfo, undefined);

	await sessionStart({}, {
		...commandContext,
		sessionManager: { getEntries: () => [{ type: "custom", customType: "mf-plan", data: { enabled: true, slug: "../../escape", repoPlanSlug: "a/b", moaInfo: { proposers: "bad" } } }] },
	});
	await togglePlanMode.handler("", commandContext);
	assert.equal(appendedEntries.at(-1).data.moaInfo, undefined);
	assert.notEqual(appendedEntries.at(-1).data.slug, "../../escape");
	assert.equal(appendedEntries.at(-1).data.repoPlanSlug, undefined);

	process.env[envKey] = "before-plan-mode";
	await togglePlanMode.handler("", commandContext);
	assert.equal(process.env[envKey], planValue);
	await shutdown({ reason: "new" });
	assert.equal(process.env[envKey], "before-plan-mode");

	await togglePlanMode.handler("", commandContext);
	delete process.env[envKey];
	await togglePlanMode.handler("", commandContext);
	assert.equal(process.env[envKey], planValue);
	await shutdown({ reason: "resume" });
	assert.equal(process.env[envKey], undefined);
} finally {
	if (previousEnvValue === undefined) delete process.env[envKey];
	else process.env[envKey] = previousEnvValue;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Lifecycle foundation tests passed.");
