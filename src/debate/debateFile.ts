import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { isValidPlanSlug } from "../planning/planFile.ts";

export type RepoDebateFileKind = "debate-prompt" | "debate";

function repoDebateSuffix(kind: RepoDebateFileKind): string {
	return kind === "debate-prompt" ? "__debate-prompt" : "__debate";
}

export function getRepoDebateDirectory(repoCwd: string): string {
	const debateDir = path.join(repoCwd, CONFIG_DIR_NAME, "mf-debate");
	try {
		fs.mkdirSync(debateDir, { recursive: true });
	} catch {
		// Best effort; the write will report a useful error if this failed.
	}
	return debateDir;
}

export function saveRepoDebateFile(
	content: string,
	repoCwd: string,
	baseSlug: string,
	kind: RepoDebateFileKind,
): string {
	if (!isValidPlanSlug(baseSlug)) throw new Error("Invalid repository debate slug");
	const debateDir = getRepoDebateDirectory(repoCwd);
	const filePath = path.join(debateDir, `${baseSlug}${repoDebateSuffix(kind)}.md`);
	fs.writeFileSync(filePath, content, { encoding: "utf-8" });
	return filePath;
}

export function repoDebateDisplayPath(baseSlug: string, kind: RepoDebateFileKind): string {
	if (!isValidPlanSlug(baseSlug)) throw new Error("Invalid repository debate slug");
	return `${CONFIG_DIR_NAME}/mf-debate/${baseSlug}${repoDebateSuffix(kind)}.md`;
}
