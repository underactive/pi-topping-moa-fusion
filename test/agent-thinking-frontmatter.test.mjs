import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(tmpdir(), "agent-thinking-test-"));
const agentDir = path.join(tempRoot, "agent");
const agentsDir = path.join(agentDir, "agents");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

const write = (name, frontmatter) =>
	writeFileSync(path.join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\nPrompt body.\n`, "utf8");

try {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentsDir, { recursive: true });
	const { discoverAgents } = await import("../src/agents/discovery.ts");

	write("with-thinking", "name: with-thinking\ndescription: d\nmodel: anthropic/claude-haiku-4-5\nthinking: off");
	write("max-thinking", "name: max-thinking\ndescription: d\nmodel: openai/gpt-5\nthinking: max");
	write("bad-thinking", "name: bad-thinking\ndescription: d\nmodel: openai/gpt-5\nthinking: turbo");
	write("no-thinking", "name: no-thinking\ndescription: d\nmodel: openai/gpt-5");

	const byName = new Map(discoverAgents(tempRoot, "user").agents.map((agent) => [agent.name, agent]));

	assert.equal(byName.get("with-thinking").thinking, "off");
	assert.equal(byName.get("with-thinking").model, "anthropic/claude-haiku-4-5");

	// `max` is a level of its own and must reach --thinking intact, not be
	// dropped as unrecognized or rewritten to `xhigh`.
	assert.equal(byName.get("max-thinking").thinking, "max");

	// An unrecognized level must not reach the child process's --thinking flag.
	assert.equal(byName.get("bad-thinking").thinking, undefined);
	assert.equal(byName.get("no-thinking").thinking, undefined);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Agent thinking frontmatter tests passed.");
