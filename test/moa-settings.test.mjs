import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-settings-test-"));
const agentDir = path.join(tempRoot, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

try {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const config = await import("../src/config/settings.ts");

	const settingsPath = path.join(agentDir, "mf-plan", "settings.json");
	assert.equal(config.moaSettingsPath(), settingsPath);
	assert.equal(config.moaSettingsExist(), false);

	const empty = config.loadMoaConfig();
	assert.deepEqual(empty.proposers, []);
	assert.deepEqual(empty.opinionModels, []);
	assert.deepEqual(empty.debateModels, []);
	assert.equal(empty.debateRounds, 3);
	assert.equal(empty.mode, "single");
	assert.equal(empty.autoResolveConflicts, false);
	assert.equal(empty.agentDefaultsConfigured, false);
	assert.equal(empty.maxConcurrentAgents, 1);
	// A config (or file) lacking `verifier` loads it as undefined — no migration.
	assert.equal(empty.verifier, undefined);
	// A file without rosters loads an empty list.
	assert.deepEqual(empty.rosters, []);

	const proposer = { provider: "test", id: "proposer" };
	const synthesizer = { provider: "test", id: "synthesizer" };
	const implementer = { provider: "test", id: "implementer" };
	const verifier = { provider: "test", id: "verifier" };
	const cheap = { provider: "test", id: "cheap" };
	const saved = {
		mode: "moa",
		proposers: [proposer],
		opinionModels: [proposer, verifier],
		debateModels: [proposer, verifier, cheap],
		debateRounds: 4,
		synthesizer,
		implementer,
		verifier,
		cheap,
		autoResolveConflicts: true,
		useSummaryName: true,
		agentDefaultsConfigured: true,
		// `max` is a level of its own, distinct from `xhigh`, so it must survive
		// the parse filter rather than being dropped or folded into `xhigh`.
		thinkingOverrides: { "test/cheap": "minimal", "test/deep": "max" },
		rosters: [],
		maxConcurrentAgents: 4,
	};
	config.saveMoaConfig(saved);
	assert.equal(config.moaSettingsExist(), true);
	const reloaded = config.loadMoaConfig();
	assert.deepEqual(reloaded, saved);
	assert.equal(reloaded.autoResolveConflicts, true);
	assert.equal(reloaded.agentDefaultsConfigured, true);
	assert.deepEqual(reloaded.verifier, verifier);
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).cheap, cheap);
	assert.equal(reloaded.maxConcurrentAgents, 4);

	// Out-of-range maxConcurrentAgents values clamp into 1–8.
	const concurrencyClamped = JSON.parse(readFileSync(settingsPath, "utf8"));
	concurrencyClamped.maxConcurrentAgents = 0;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 1);
	concurrencyClamped.maxConcurrentAgents = -3;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 1);
	concurrencyClamped.maxConcurrentAgents = 9;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 8);
	concurrencyClamped.maxConcurrentAgents = 100;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 8);

	// Rounding and malformed maxConcurrentAgents fall back or clamp.
	concurrencyClamped.maxConcurrentAgents = 2.4;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 2);
	concurrencyClamped.maxConcurrentAgents = 2.5;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 3);
	concurrencyClamped.maxConcurrentAgents = "four";
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 1);
	concurrencyClamped.maxConcurrentAgents = null;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 1);
	concurrencyClamped.maxConcurrentAgents = true;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 1);
	concurrencyClamped.maxConcurrentAgents = {};
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 1);
	delete concurrencyClamped.maxConcurrentAgents;
	writeFileSync(settingsPath, `${JSON.stringify(concurrencyClamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().maxConcurrentAgents, 1);

	// Out-of-range and non-finite debateRounds values clamp into the 2–5 picker range.
	const clamped = JSON.parse(readFileSync(settingsPath, "utf8"));
	clamped.debateRounds = 9;
	writeFileSync(settingsPath, `${JSON.stringify(clamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().debateRounds, 5);
	clamped.debateRounds = 0;
	writeFileSync(settingsPath, `${JSON.stringify(clamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().debateRounds, 2);
	clamped.debateRounds = "three";
	writeFileSync(settingsPath, `${JSON.stringify(clamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().debateRounds, 3);
	delete clamped.debateRounds;
	writeFileSync(settingsPath, `${JSON.stringify(clamped, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().debateRounds, 3);

	// A persisted file without newer optional roster keys still loads safely.
	const legacy = JSON.parse(readFileSync(settingsPath, "utf8"));
	delete legacy.verifier;
	delete legacy.opinionModels;
	delete legacy.debateModels;
	writeFileSync(settingsPath, `${JSON.stringify(legacy, null, "\t")}\n`, "utf8");
	assert.equal(config.loadMoaConfig().verifier, undefined);
	assert.deepEqual(config.loadMoaConfig().opinionModels, []);
	assert.deepEqual(config.loadMoaConfig().debateModels, []);
	assert.deepEqual(config.loadMoaConfig().rosters, []);

	// ── Roster persistence ──────────────────────────────────────────────────
	const roster = {
		name: "team1",
		proposers: [
			{ ref: proposer, thinking: "high" },
			{ ref: synthesizer, thinking: "medium" },
			// A 6th slot beyond the 2–5 cap is truncated on load.
			{ ref: implementer, thinking: "low" },
			{ ref: verifier, thinking: "off" },
			{ ref: cheap, thinking: "off" },
			{ ref: cheap, thinking: "off" },
		],
		synthesizer: { ref: synthesizer, thinking: "high" },
		implementer: { ref: implementer, thinking: "medium" },
		verifier: { ref: verifier, thinking: "off" },
	};
	const withRoster = { ...config.loadMoaConfig(), rosters: [roster] };
	config.saveMoaConfig(withRoster);
	const reloadedRosters = config.loadMoaConfig().rosters;
	assert.equal(reloadedRosters.length, 1);
	assert.equal(reloadedRosters[0].name, "team1");
	assert.equal(reloadedRosters[0].proposers.length, 5, "roster proposers must cap at 5 on load");
	assert.deepEqual(reloadedRosters[0].synthesizer.ref, synthesizer);

	// Invalid roster entries are dropped, valid neighbours survive.
	const dirty = JSON.parse(readFileSync(settingsPath, "utf8"));
	dirty.rosters = [
		"not-an-object",
		{ name: "bad name", proposers: [], synthesizer: {}, implementer: {}, verifier: {} },
		{ name: "noproposers", proposers: [], synthesizer: roster.synthesizer, implementer: roster.implementer, verifier: roster.verifier },
		roster,
	];
	writeFileSync(settingsPath, `${JSON.stringify(dirty, null, "\t")}\n`, "utf8");
	assert.deepEqual(config.loadMoaConfig().rosters.map((r) => r.name), ["team1"]);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("MoA settings tests passed.");
