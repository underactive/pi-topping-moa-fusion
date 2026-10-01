import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAgentFile, type AgentConfig } from "./discovery.ts";

/**
 * Names of the `moa-*` agents that are protocol-coupled internals of the
 * `/mf-plan` flow: their prompt wording must stay in lockstep with the
 * parsers/UI in moa/conflicts.ts, moa/verification.ts, and index.ts (e.g. the
 * `## Conflicts` markup, and the `## Verification Criteria`/`## Criteria Verdicts`/
 * `**Verdict:**`/`### Gaps` verification-verdict markup). Unlike user-facing agents (`moa-explore`, `mf-plan`), a stale or
 * hand-edited installed copy of one of these must never desync from the
 * bundled definition — see `withAuthoritativeMoaAgents`.
 */
export const AUTHORITATIVE_MOA_AGENT_NAMES = Object.freeze(["moa-proposer", "moa-synthesizer", "moa-verifier"]);

/**
 * The user-facing agents seeded into `~/.pi/agent/agents/` for customization.
 * That directory is shared: every subagent tool scans it in every session
 * (e.g. pi-subagents' `Agent`), so anything installed there is offered as a
 * general-purpose agent outside `/mf-plan`.
 */
const INSTALLED_AGENT_NAMES = Object.freeze(["moa-explore", "mf-plan", "moa-opinion", "moa-debater"]);

const MAX_WALK_UP_LEVELS = 5;

/**
 * Resolve the directory containing this package's bundled `agents/*.md`
 * definitions relative to this module's location rather than `cwd`.
 * The authoritative module lives below `src/`, so walk up a bounded number of
 * levels and accept only an `agents/` directory carrying `moa-proposer.md`.
 * Defaults to the module-local candidate if none is found, keeping failure
 * deterministic for callers.
 */
export function shippedAgentsDir(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	let currentDir = moduleDir;
	for (let level = 0; level <= MAX_WALK_UP_LEVELS; level++) {
		const candidate = path.join(currentDir, "agents");
		if (fs.existsSync(path.join(candidate, "moa-proposer.md"))) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return path.join(moduleDir, "agents");
}

/**
 * Overlay the current bundled definitions of the protocol-internal `moa-*`
 * agents (see `AUTHORITATIVE_MOA_AGENT_NAMES`) onto a discovered agent list,
 * replacing (or inserting) each by name so a stale or hand-edited installed
 * copy in `~/.pi/agent/agents/` can never desync the synthesizer's prompt
 * from the orchestrator's `## Conflicts` parser, or the verifier's prompt from
 * the `## Verification Criteria`/`## Criteria Verdicts`/`**Verdict:**`/`### Gaps`
 * verification-verdict parser. All other agents (e.g.
 * `moa-explore`, `mf-plan`, any custom agent) pass through untouched.
 */
export function withAuthoritativeMoaAgents(agents: AgentConfig[], shippedDir: string): AgentConfig[] {
	const result = [...agents];

	for (const name of AUTHORITATIVE_MOA_AGENT_NAMES) {
		const sourcePath = path.join(shippedDir, `${name}.md`);
		const bundled = parseAgentFile(sourcePath, "user");
		const index = result.findIndex((a) => a.name === name);
		if (!bundled) {
			if (index >= 0) result.splice(index, 1);
			continue;
		}

		if (index >= 0) result[index] = bundled;
		else result.push(bundled);
	}

	return result;
}

/**
 * Seed the user-facing agents (no-clobber) and remove the protocol-internal
 * copies earlier versions installed alongside them. MoA runs load the
 * protocol agents from the bundled `agents/` directory instead — see
 * withAuthoritativeMoaAgents.
 */
export function installShippedAgents(): void {
	const agentsDir = path.join(getAgentDir(), "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	const sourceDir = shippedAgentsDir();
	for (const name of INSTALLED_AGENT_NAMES) {
		const targetPath = path.join(agentsDir, `${name}.md`);
		if (fs.existsSync(targetPath)) continue; // don't clobber

		const sourcePath = path.join(sourceDir, `${name}.md`);
		if (fs.existsSync(sourcePath)) {
			try {
				fs.copyFileSync(sourcePath, targetPath);
			} catch {
				// ignore
			}
		}
	}

	removeInstalledAuthoritativeAgents(agentsDir, sourceDir);
}

/**
 * Delete installed copies of the protocol-internal agents from `agentsDir`.
 * Other sessions' subagent tools picked them up there (`moa-verifier` ran for
 * unrelated verification work), and MoA runs never read them. Only a file that
 * still declares the agent's own name is removed, and nothing is removed when
 * `agentsDir` resolves to `shippedDir`, whose files are the bundled definitions.
 */
export function removeInstalledAuthoritativeAgents(agentsDir: string, shippedDir: string): void {
	if (isSameDirectory(agentsDir, shippedDir)) return;

	for (const name of AUTHORITATIVE_MOA_AGENT_NAMES) {
		const targetPath = path.join(agentsDir, `${name}.md`);
		try {
			if (parseAgentFile(targetPath, "user")?.name !== name) continue;
			fs.unlinkSync(targetPath);
		} catch {
			// Malformed frontmatter, or another session removed it first.
		}
	}
}

function isSameDirectory(a: string, b: string): boolean {
	try {
		return fs.realpathSync(a) === fs.realpathSync(b);
	} catch {
		return false;
	}
}
