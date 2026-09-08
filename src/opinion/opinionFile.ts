import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { isValidPlanSlug } from "../planning/planFile.ts";

export type RepoOpinionFileKind = "opinion-prompt" | "opinions";

function repoOpinionSuffix(kind: RepoOpinionFileKind): string {
	return kind === "opinion-prompt" ? "__opinion-prompt" : "__opinions";
}

export function getRepoOpinionDirectory(repoCwd: string): string {
	const opinionDir = path.join(repoCwd, CONFIG_DIR_NAME, "mf-opinion");
	try {
		fs.mkdirSync(opinionDir, { recursive: true });
	} catch {
		// Best effort; the write will report a useful error if this failed.
	}
	return opinionDir;
}

export function saveRepoOpinionFile(
	content: string,
	repoCwd: string,
	baseSlug: string,
	kind: RepoOpinionFileKind,
): string {
	if (!isValidPlanSlug(baseSlug)) throw new Error("Invalid repository opinion slug");
	const opinionDir = getRepoOpinionDirectory(repoCwd);
	const filePath = path.join(opinionDir, `${baseSlug}${repoOpinionSuffix(kind)}.md`);
	fs.writeFileSync(filePath, content, { encoding: "utf-8" });
	return filePath;
}

export function repoOpinionDisplayPath(baseSlug: string, kind: RepoOpinionFileKind): string {
	if (!isValidPlanSlug(baseSlug)) throw new Error("Invalid repository opinion slug");
	return `${CONFIG_DIR_NAME}/mf-opinion/${baseSlug}${repoOpinionSuffix(kind)}.md`;
}
