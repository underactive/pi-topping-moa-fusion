import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(tmpdir(), "agent-defaults-test-"));
const agentDir = path.join(tempRoot, "agent");
const agentsDir = path.join(agentDir, "agents");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

const BODY = "\nYou are a codebase explorer.\n\nDo not edit files.\n";

try {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentsDir, { recursive: true });
	const defaults = await import("../src/agents/defaults.ts");

	assert.equal(defaults.installedAgentPath("moa-explore"), path.join(agentsDir, "moa-explore.md"));

	// Only the user-customizable agents are offered; protocol-internal ones are not.
	assert.deepEqual(defaults.CONFIGURABLE_AGENTS.map((a) => a.name), ["moa-explore"]);

	// ── read: model + thinking, and a missing thinking field ────────────────
	const explorePath = path.join(agentsDir, "moa-explore.md");
	writeFileSync(
		explorePath,
		`---\nname: moa-explore\ndescription: Fast recon\ntools: read, grep\nmodel: claude-haiku-4-5\n---${BODY}`,
		"utf8",
	);
	assert.deepEqual(defaults.readAgentDefault("moa-explore"), { model: "claude-haiku-4-5" });

	// A missing file yields no defaults rather than throwing.
	assert.deepEqual(defaults.readAgentDefault("does-not-exist"), {});

	// ── write: replaces model in place, appends the missing thinking key ────
	assert.equal(defaults.writeAgentDefault("moa-explore", "anthropic/claude-haiku-4-5", "off"), true);
	const written = readFileSync(explorePath, "utf8");
	assert.equal(
		written,
		`---\nname: moa-explore\ndescription: Fast recon\ntools: read, grep\nmodel: anthropic/claude-haiku-4-5\nthinking: off\n---${BODY}`,
	);
	assert.deepEqual(defaults.readAgentDefault("moa-explore"), {
		model: "anthropic/claude-haiku-4-5",
		thinking: "off",
	});

	// ── write again: both keys already exist, so both are replaced in place ─
	assert.equal(defaults.writeAgentDefault("moa-explore", "openai/gpt-5", "high"), true);
	assert.equal(
		readFileSync(explorePath, "utf8"),
		`---\nname: moa-explore\ndescription: Fast recon\ntools: read, grep\nmodel: openai/gpt-5\nthinking: high\n---${BODY}`,
	);

	// ── unrelated frontmatter keys and the body survive verbatim ────────────
	const planPath = path.join(agentsDir, "mf-plan.md");
	const preserved = `---\nname: mf-plan\ndescription: Planner\ncustomKey: keep me\ntools: read\n---\n\n# Body\n\n---\n\nA horizontal rule above must not be treated as frontmatter.\n`;
	writeFileSync(planPath, preserved, "utf8");
	assert.equal(defaults.writeAgentDefault("mf-plan", "anthropic/claude-opus-4-6", "medium"), true);
	const planWritten = readFileSync(planPath, "utf8");
	assert.match(planWritten, /^customKey: keep me$/m);
	assert.match(planWritten, /^model: anthropic\/claude-opus-4-6$/m);
	assert.match(planWritten, /^thinking: medium$/m);
	assert.equal(planWritten.slice(planWritten.indexOf("\n\n# Body")), "\n\n# Body\n\n---\n\nA horizontal rule above must not be treated as frontmatter.\n");

	// ── no frontmatter block: reported as a failure, file left untouched ────
	const bare = path.join(agentsDir, "bare.md");
	writeFileSync(bare, "Just a prompt, no frontmatter.\n", "utf8");
	assert.equal(defaults.writeAgentDefault("bare", "openai/gpt-5", "low"), false);
	assert.equal(readFileSync(bare, "utf8"), "Just a prompt, no frontmatter.\n");
	assert.equal(defaults.writeAgentDefault("does-not-exist", "openai/gpt-5", "low"), false);

	// ── an unrecognized thinking level is dropped on read ───────────────────
	writeFileSync(bare, "---\nname: bare\nmodel: openai/gpt-5\nthinking: turbo\n---\n", "utf8");
	assert.deepEqual(defaults.readAgentDefault("bare"), { model: "openai/gpt-5" });
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Agent defaults tests passed.");
