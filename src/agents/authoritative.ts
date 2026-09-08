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

export function installShippedAgents(): void {
	const agentsDir = path.join(getAgentDir(), "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	// This still writes user-visible files for direct inspection/customization,
	// but note `moa-proposer`/`moa-synthesizer` are no longer authoritative at
	// runtime once written here — see withAuthoritativeMoaAgents.
	const sourceDir = shippedAgentsDir();
	for (const name of ["moa-explore.md", "mf-plan.md", "moa-opinion.md", "moa-debater.md", "moa-proposer.md", "moa-synthesizer.md", "moa-verifier.md"]) {
		const targetPath = path.join(agentsDir, name);
		if (fs.existsSync(targetPath)) continue; // don't clobber

		const sourcePath = path.join(sourceDir, name);
		if (fs.existsSync(sourcePath)) {
			try {
				fs.copyFileSync(sourcePath, targetPath);
			} catch {
				// ignore
			}
		}
	}
}
