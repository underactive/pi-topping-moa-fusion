import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	AUTHORITATIVE_MOA_AGENT_NAMES,
	installShippedAgents,
	removeInstalledAuthoritativeAgents,
	shippedAgentsDir,
	withAuthoritativeMoaAgents,
} from "../src/agents/authoritative.ts";
import { discoverAgents } from "../src/agents/discovery.ts";

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
// protocol-authoritative overlay. The protocol agents are never installed:
// every subagent tool scans that directory in every session, so an installed
// moa-verifier was offered as a general-purpose agent outside /mf-plan.
{
	const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-opinion-agent-install-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = tempRoot;
		installShippedAgents();
		assert.equal(readFileSync(path.join(tempRoot, "agents", "moa-opinion.md"), "utf8"), opinionAgent);
		assert.equal(readFileSync(path.join(tempRoot, "agents", "moa-debater.md"), "utf8"), debaterAgent);
		for (const name of ["moa-explore", "mf-plan"]) {
			assert.equal(existsSync(path.join(tempRoot, "agents", `${name}.md`)), true, `${name} is installed`);
		}
		for (const name of AUTHORITATIVE_MOA_AGENT_NAMES) {
			assert.equal(existsSync(path.join(tempRoot, "agents", `${name}.md`)), false, `${name} must not be installed`);
		}

		// MoA runs still resolve every protocol agent, from the bundled definitions.
		const resolved = withAuthoritativeMoaAgents(discoverAgents(tempRoot, "user").agents, dir);
		for (const name of AUTHORITATIVE_MOA_AGENT_NAMES) {
			assert.equal(resolved.find((a) => a.name === name)?.filePath, path.join(dir, `${name}.md`));
		}
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

// ── Protocol agents installed by earlier versions are removed ───────────────
// Only files that still declare the protocol agent's name; a customized
// user-facing agent and files that are not ours stay.
{
	const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-installed-agent-cleanup-"));
	const agentsDir = path.join(tempRoot, "agents");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(path.join(agentsDir, "moa-verifier.md"), readFileSync(path.join(dir, "moa-verifier.md"), "utf8"));
		writeFileSync(
			path.join(agentsDir, "moa-synthesizer.md"),
			`---\nname: moa-synthesizer\ndescription: stale installed copy\n---\n\n${staleSynthesizerPrompt}\n`,
		);
		const foreignProposer = "---\nname: my-proposer\ndescription: Another agent reusing the filename.\n---\n\nCustom prompt.\n";
		writeFileSync(path.join(agentsDir, "moa-proposer.md"), foreignProposer);
		const customExplore = "---\nname: moa-explore\ndescription: Customized explore agent.\n---\n\nCustom explore instructions.\n";
		writeFileSync(path.join(agentsDir, "moa-explore.md"), customExplore);
		const unrelated = "---\nname: moa-red-team\ndescription: Installed by another package.\n---\n\nNot ours.\n";
		writeFileSync(path.join(agentsDir, "moa-red-team.md"), unrelated);

		process.env.PI_CODING_AGENT_DIR = tempRoot;
		installShippedAgents();

		assert.equal(existsSync(path.join(agentsDir, "moa-verifier.md")), false, "an installed moa-verifier is removed");
		assert.equal(existsSync(path.join(agentsDir, "moa-synthesizer.md")), false, "a stale moa-synthesizer is removed");
		assert.equal(readFileSync(path.join(agentsDir, "moa-proposer.md"), "utf8"), foreignProposer);
		assert.equal(readFileSync(path.join(agentsDir, "moa-explore.md"), "utf8"), customExplore);
		assert.equal(readFileSync(path.join(agentsDir, "moa-red-team.md"), "utf8"), unrelated);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

// ── Removal never deletes the bundled definitions, and never throws ────────
{
	const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-installed-agent-guards-"));
	try {
		const bundled = path.join(tempRoot, "bundled");
		mkdirSync(bundled);
		for (const name of AUTHORITATIVE_MOA_AGENT_NAMES) {
			writeFileSync(path.join(bundled, `${name}.md`), readFileSync(path.join(dir, `${name}.md`), "utf8"));
		}

		// An agent dir that resolves to the bundled dir is skipped entirely.
		const linkedDir = path.join(tempRoot, "linked-agents");
		symlinkSync(bundled, linkedDir, "dir");
		removeInstalledAuthoritativeAgents(linkedDir, bundled);
		for (const name of AUTHORITATIVE_MOA_AGENT_NAMES) {
			assert.equal(existsSync(path.join(bundled, `${name}.md`)), true, `bundled ${name} survives a linked agent dir`);
		}

		// A per-file link into the bundled dir is itself removed; its target stays.
		const agentsDir = path.join(tempRoot, "agents");
		mkdirSync(agentsDir);
		symlinkSync(path.join(bundled, "moa-verifier.md"), path.join(agentsDir, "moa-verifier.md"));
		removeInstalledAuthoritativeAgents(agentsDir, bundled);
		assert.equal(existsSync(path.join(agentsDir, "moa-verifier.md")), false);
		assert.equal(existsSync(path.join(bundled, "moa-verifier.md")), true);

		// Malformed frontmatter is skipped rather than thrown out of session_start.
		const broken = "---\nname: moa-verifier\ndescription: [unterminated\n---\n\nBody.\n";
		writeFileSync(path.join(agentsDir, "moa-verifier.md"), broken);
		assert.doesNotThrow(() => removeInstalledAuthoritativeAgents(agentsDir, bundled));
		assert.equal(readFileSync(path.join(agentsDir, "moa-verifier.md"), "utf8"), broken);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

console.log("MoA authoritative-agent overlay tests passed.");
