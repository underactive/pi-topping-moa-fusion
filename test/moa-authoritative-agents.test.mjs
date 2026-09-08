import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AUTHORITATIVE_MOA_AGENT_NAMES, installShippedAgents, shippedAgentsDir, withAuthoritativeMoaAgents } from "../src/agents/authoritative.ts";

const root = path.resolve(import.meta.dirname, "..");
const agentsSource = readFileSync(path.join(root, "src", "agents", "authoritative.ts"), "utf8");
assert.match(agentsSource, /import \{ fileURLToPath \} from "node:url";/);
assert.match(agentsSource, /path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/);

// Real bundled agent bodies, so assertions are tied to the actual shipped
// prompts rather than a hand-copied fixture that could drift.
const dir = shippedAgentsDir();
assert.equal(dir, path.join(root, "agents"), "the deeper authoritative module walks up to package agents/");
assert.equal(path.basename(dir), "agents");
assert.match(readFileSync(path.join(dir, "moa-proposer.md"), "utf8"), /^---\n/);
const opinionAgent = readFileSync(path.join(dir, "moa-opinion.md"), "utf8");
assert.match(opinionAgent, /## Opinion/);
assert.match(opinionAgent, /read-only/i);
assert.equal(AUTHORITATIVE_MOA_AGENT_NAMES.includes("moa-opinion"), false);
assert.equal(AUTHORITATIVE_MOA_AGENT_NAMES.includes("moa-debater"), false);

const debaterAgent = readFileSync(path.join(dir, "moa-debater.md"), "utf8");
assert.match(debaterAgent, /^---\n/);
assert.match(debaterAgent, /## Position/);
assert.match(debaterAgent, /\*\*Stance:\*\*/);
assert.match(debaterAgent, /read-only/i);

// The opinion agent is installed for customization, but remains outside the
// protocol-authoritative overlay.
{
	const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-opinion-agent-install-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = tempRoot;
		installShippedAgents();
		assert.equal(readFileSync(path.join(tempRoot, "agents", "moa-opinion.md"), "utf8"), opinionAgent);
		assert.equal(readFileSync(path.join(tempRoot, "agents", "moa-debater.md"), "utf8"), debaterAgent);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function bundledBody(name) {
	const raw = readFileSync(path.join(dir, `${name}.md`), "utf8");
	// Strip the frontmatter block the same way parseFrontmatter would.
	return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

const staleSynthesizerPrompt =
	"You are the synthesizer. Act as a judge, not a co-author. Pick the stronger plan and return it.";

function baseDiscovery() {
	return [
		{
			name: "moa-synthesizer",
			description: "stale installed copy",
			systemPrompt: staleSynthesizerPrompt,
			source: "user",
			filePath: "/fake/moa-synthesizer.md",
		},
		{
			name: "moa-explore",
			description: "user-customized explore agent",
			systemPrompt: "Custom explore instructions the user wrote by hand.",
			source: "user",
			filePath: "/fake/moa-explore.md",
		},
	];
}

// ── A stale moa-synthesizer is replaced by the bundled definition ──────────
{
	const overlaid = withAuthoritativeMoaAgents(baseDiscovery(), dir);
	const synth = overlaid.find((a) => a.name === "moa-synthesizer");
	assert.ok(synth, "moa-synthesizer must be present after overlay");
	assert.notEqual(synth.systemPrompt, staleSynthesizerPrompt);
	assert.equal(synth.systemPrompt.trim(), bundledBody("moa-synthesizer"));
	assert.match(synth.systemPrompt, /## Conflicts/);
	assert.match(synth.systemPrompt, /\*\*Decision:\*\*/);
	assert.match(synth.systemPrompt, /\*\*Details:\*\*/);
	assert.match(synth.systemPrompt, /short, non-technical summary/i);
	assert.match(synth.systemPrompt, /technical implementation specifics/i);
	assert.match(synth.systemPrompt, /## Verification Criteria/);
	assert.doesNotMatch(synth.systemPrompt, /Act as a judge, not a co-author/);
}

// ── moa-explore (a user-facing, non-protocol agent) passes through untouched ─
{
	const overlaid = withAuthoritativeMoaAgents(baseDiscovery(), dir);
	const explore = overlaid.find((a) => a.name === "moa-explore");
	assert.ok(explore);
	assert.equal(explore.systemPrompt, "Custom explore instructions the user wrote by hand.");
}

// ── moa-proposer is overlaid too, even without a stale entry ────────────
// (insertion path: the name does not exist in the discovered array at all).
{
	const overlaid = withAuthoritativeMoaAgents(baseDiscovery(), dir);
	const proposer = overlaid.find((a) => a.name === "moa-proposer");
	assert.ok(proposer, "moa-proposer must be inserted when absent from discovery");
	assert.equal(proposer.systemPrompt.trim(), bundledBody("moa-proposer"));
}

// ── moa-verifier is overlaid from the bundled copy and carries the ─────────
// verification-verdict contract its parser depends on.
{
	const overlaid = withAuthoritativeMoaAgents(baseDiscovery(), dir);
	const verifier = overlaid.find((a) => a.name === "moa-verifier");
	assert.ok(verifier, "moa-verifier must be inserted when absent from discovery");
	assert.equal(verifier.systemPrompt.trim(), bundledBody("moa-verifier"));
	assert.match(verifier.systemPrompt, /## Step Verdicts/);
	assert.match(verifier.systemPrompt, /## Criteria Verdicts/);
	assert.match(verifier.systemPrompt, /\*\*Verdict:\*\*/);
	assert.match(verifier.systemPrompt, /### Gaps/);
	assert.match(verifier.systemPrompt, /complete \| partial \| incomplete \| cannot-verify/);
}

// ── Unreadable authoritative definitions are dropped while unrelated ───────
// agents remain available.
{
	const overlaid = withAuthoritativeMoaAgents(baseDiscovery(), "/nonexistent/agents/dir");
	assert.equal(overlaid.length, 1);
	assert.equal(overlaid.some((a) => a.name === "moa-synthesizer"), false);
	assert.equal(overlaid[0].name, "moa-explore");
}

console.log("MoA authoritative-agent overlay tests passed.");
