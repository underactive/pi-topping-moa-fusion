/**
 * Default model/thinking selections for the user-customizable planning
 * subagents, stored in the frontmatter of the installed agent files.
 *
 * The installed copies under `~/.pi/agent/agents/` are authoritative at
 * runtime, so writes target those rather than this package's shipped `agents/`
 * directory (which only seeds them, no-clobber, via installShippedAgents).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel, type ThinkingLevel } from "../shared/modelRefs.ts";

export interface ConfigurableAgent {
	name: string;
	menuLabel: string;
	title: string;
	description: string;
}

/**
 * The shipped agents whose model the user may choose. `moa-proposer` and
 * `moa-synthesizer` are excluded: their model is assigned per slot at runtime,
 * and withAuthoritativeMoaAgents replaces their on-disk copies wholesale, so
 * any frontmatter written to them would be ignored. `mf-plan` is excluded
 * too: it follows the session model chosen when entering plan mode, so a
 * configured default would never be read.
 */
export const CONFIGURABLE_AGENTS: readonly ConfigurableAgent[] = [
	{
		name: "moa-explore",
		menuLabel: "explore agent",
		title: "Explore agent — fast codebase recon",
		description: "Runs high-volume file reads and greps to gather context before planning. Favor a fast, inexpensive model: this role needs breadth and speed, not deep reasoning.",
	},
];

export interface AgentFrontmatterDefault {
	/** Raw frontmatter value — shipped defaults are bare ids (`claude-haiku-4-5`), not `provider/id`. */
	model?: string;
	thinking?: ThinkingLevel;
}

export function installedAgentPath(name: string): string {
	return path.join(getAgentDir(), "agents", `${name}.md`);
}

/** Index of the closing `---` of a leading frontmatter block, or -1 if there is none. */
function frontmatterEnd(lines: string[]): number {
	if (lines[0]?.trim() !== "---") return -1;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index]?.trim() === "---") return index;
	}
	return -1;
}

/** The value of `line` if it assigns `key`, else undefined. */
function readField(line: string, key: string): string | undefined {
	const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
	if (!match || match[1] !== key) return undefined;
	return match[2]!.trim();
}

function setField(frontmatterLines: string[], key: string, value: string): void {
	const index = frontmatterLines.findIndex((line) => readField(line, key) !== undefined);
	if (index >= 0) frontmatterLines[index] = `${key}: ${value}`;
	else frontmatterLines.push(`${key}: ${value}`);
}

export function readAgentDefault(name: string): AgentFrontmatterDefault {
	let content: string;
	try {
		content = fs.readFileSync(installedAgentPath(name), "utf-8");
	} catch {
		return {};
	}

	const lines = content.split("\n");
	const end = frontmatterEnd(lines);
	if (end < 0) return {};

	const result: AgentFrontmatterDefault = {};
	for (let index = 1; index < end; index++) {
		const line = lines[index]!;
		const model = readField(line, "model");
		if (model) result.model = model;
		const thinking = readField(line, "thinking");
		if (thinking && isThinkingLevel(thinking)) result.thinking = thinking;
	}
	return result;
}

/**
 * Rewrite just the `model:`/`thinking:` lines of an installed agent's
 * frontmatter, leaving every other line — including the prompt body and any
 * hand-added keys — byte-for-byte intact. Returns false when the file is
 * missing or carries no frontmatter block.
 */
export function writeAgentDefault(name: string, model: string, thinking: ThinkingLevel): boolean {
	const filePath = installedAgentPath(name);
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return false;
	}

	const lines = content.split("\n");
	const end = frontmatterEnd(lines);
	if (end < 0) return false;

	const frontmatterLines = lines.slice(1, end);
	setField(frontmatterLines, "model", model);
	setField(frontmatterLines, "thinking", thinking);

	try {
		fs.writeFileSync(filePath, [lines[0]!, ...frontmatterLines, ...lines.slice(end)].join("\n"), "utf-8");
	} catch {
		return false;
	}
	return true;
}
