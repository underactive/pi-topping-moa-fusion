/**
 * Plan file management — slug generation, path resolution, read/write.
 * Ported from Claude Code's plans.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_SLUG_RETRIES = 10;
const MAX_PLAN_SLUG_LENGTH = 100;
const PLAN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidPlanSlug(slug: unknown): slug is string {
	return typeof slug === "string" && slug.length <= MAX_PLAN_SLUG_LENGTH && PLAN_SLUG_PATTERN.test(slug);
}

// Adjective + adjective + noun word lists for slug generation
const ADJECTIVES = [
	"brave", "calm", "eager", "fair", "gentle", "happy", "jolly", "kind",
	"lively", "nice", "proud", "quick", "salty", "warm", "witty", "zesty",
	"bold", "clever", "daring", "fancy", "graceful", "keen", "loyal", "merry",
	"noble", "polite", "rapid", "sharp", "swift", "tidy", "vivid", "young",
	"mellifluous", "serene", "tranquil", "radiant", "velvet", "cosmic", "whimsical", "luminous",
	"ancient", "playful", "sturdy", "wondrous", "halcyon", "effervescent", "quizzical", "amber",
	"crimson", "silent", "winsome", "rustic",
];

const NOUNS = [
	"otter", "falcon", "dolphin", "eagle", "fox", "hawk", "lion", "moose",
	"owl", "panda", "raven", "shark", "tiger", "whale", "wolf", "zebra",
	"badger", "crane", "heron", "iguana", "jaguar", "koala", "lemur", "mink",
	"narwhal", "ocelot", "puma", "quail", "salmon", "toucan", "viper", "yak",
];

function randomWord(list: string[]): string {
	return list[Math.floor(Math.random() * list.length)];
}

export function generateWordSlug(): string {
	return `${randomWord(ADJECTIVES)}-${randomWord(ADJECTIVES)}-${randomWord(NOUNS)}`;
}

/** Get the plans directory (~/.pi/agent/mf-plan/plans/). Creates it if missing. */
export function getPlansDirectory(): string {
	const plansPath = path.join(getAgentDir(), "mf-plan", "plans");
	try {
		fs.mkdirSync(plansPath, { recursive: true });
	} catch {
		// ignore
	}
	return plansPath;
}

/** Generate a unique plan slug for this session. Cached after first call. */
let cachedSlug: string | undefined;

export function getPlanSlug(): string {
	if (cachedSlug) return cachedSlug;

	const plansDir = getPlansDirectory();
	for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
		const slug = generateWordSlug();
		const filePath = path.join(plansDir, `${slug}.md`);
		if (!fs.existsSync(filePath)) {
			cachedSlug = slug;
			return slug;
		}
	}
	// Fallback: use timestamp
	cachedSlug = `plan-${Date.now()}`;
	return cachedSlug;
}

/** Restore a validated slug from persisted state (for /resume). */
export function setPlanSlug(slug: string): boolean {
	if (!isValidPlanSlug(slug)) return false;
	cachedSlug = slug;
	return true;
}

/** Clear the cached slug when a fresh session starts (for /new). */
export function resetPlanSlug(): void {
	cachedSlug = undefined;
}

/** Get the full plan file path. */
export function getPlanFilePath(): string {
	const plansDirectory = path.resolve(getPlansDirectory());
	const slug = getPlanSlug();
	if (!isValidPlanSlug(slug)) throw new Error("Invalid plan slug");
	const filePath = path.resolve(plansDirectory, `${slug}.md`);
	if (!filePath.startsWith(`${plansDirectory}${path.sep}`)) throw new Error("Plan path escapes plans directory");
	return filePath;
}

/** Read the plan content from disk. Returns null if file doesn't exist. */
export function getPlan(): string | null {
	const filePath = getPlanFilePath();
	try {
		return fs.readFileSync(filePath, { encoding: "utf-8" });
	} catch {
		return null;
	}
}

/** Write content to the plan file. Creates the file if it doesn't exist. */
export function writePlan(content: string): void {
	const filePath = getPlanFilePath();
	fs.writeFileSync(filePath, content, { encoding: "utf-8" });
}

/** Convert a 4-word summary into a filename-safe slug, if it contains usable words. */
export function trySlugifyPlanName(text: string): string | undefined {
	const words = text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 4);

	const normalized = words.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	const bounded = normalized.slice(0, MAX_PLAN_SLUG_LENGTH).replace(/-+$/g, "");
	return isValidPlanSlug(bounded) ? bounded : undefined;
}

/** Convert a 4-word summary into a filename-safe slug, using a random slug for empty input. */
export function slugifyPlanName(text: string): string {
	return trySlugifyPlanName(text) ?? generateWordSlug();
}

/** Fallback slug when LLM summarization is unavailable. */
export function fallbackPlanName(): string {
	return generateWordSlug();
}

export type RepoPlanFileKind = "plan-prompt" | "plan" | "spec" | "verification" | "criteria" | "verification-handoff";

function repoPlanSuffix(kind: RepoPlanFileKind): string {
	return `__${kind}`;
}

export function isApprovedRepoPlanFilename(file: string): boolean {
	return file.endsWith("__plan.md") && !file.endsWith("__plan-prompt.md");
}

export function repoPlanDisplayPath(baseSlug: string, kind: RepoPlanFileKind): string {
	if (!isValidPlanSlug(baseSlug)) throw new Error("Invalid repository plan slug");
	return `${CONFIG_DIR_NAME}/mf-plan/${baseSlug}${repoPlanSuffix(kind)}.md`;
}

export function nextFreeRepoPlanSlug(repoCwd: string, baseSlug: string, kind: RepoPlanFileKind): string {
	if (!isValidPlanSlug(baseSlug)) throw new Error("Invalid repository plan slug");
	const planDir = getRepoPlanDirectory(repoCwd);
	if (!fs.existsSync(path.join(planDir, `${baseSlug}${repoPlanSuffix(kind)}.md`))) return baseSlug;

	for (let suffix = 2; suffix <= 20; suffix++) {
		const suffixText = `-${suffix}`;
		const trimmedBase = baseSlug
			.slice(0, MAX_PLAN_SLUG_LENGTH - suffixText.length)
			.replace(/-+$/g, "");
		const candidate = `${trimmedBase}${suffixText}`;
		if (
			isValidPlanSlug(candidate)
			&& !fs.existsSync(path.join(planDir, `${candidate}${repoPlanSuffix(kind)}.md`))
		) return candidate;
	}
	return generateWordSlug();
}

/** Ensure `<CONFIG_DIR_NAME>/mf-plan/` exists in the given repo directory. */
export function getRepoPlanDirectory(repoCwd: string): string {
	const planDir = path.join(repoCwd, CONFIG_DIR_NAME, "mf-plan");
	try {
		fs.mkdirSync(planDir, { recursive: true });
	} catch {
		// ignore
	}
	return planDir;
}

/** Save content to `<CONFIG_DIR_NAME>/mf-plan/<slug>__plan-prompt.md` or `<slug>__plan.md`. Returns the file path. */
export function saveRepoPlanFile(
	content: string,
	repoCwd: string,
	baseSlug: string,
	kind: RepoPlanFileKind,
): string {
	if (!isValidPlanSlug(baseSlug)) throw new Error("Invalid repository plan slug");
	const planDir = getRepoPlanDirectory(repoCwd);
	const suffix = repoPlanSuffix(kind);
	const filePath = path.join(planDir, `${baseSlug}${suffix}.md`);
	fs.writeFileSync(filePath, content, { encoding: "utf-8" });
	return filePath;
}

/** Read a persisted repository plan artifact, returning undefined on any failure. */
export function readRepoPlanFile(repoCwd: string, baseSlug: string, kind: RepoPlanFileKind): string | undefined {
	if (!isValidPlanSlug(baseSlug)) return undefined;
	try {
		const content = fs.readFileSync(path.join(getRepoPlanDirectory(repoCwd), `${baseSlug}${repoPlanSuffix(kind)}.md`), "utf8").trim();
		return content || undefined;
	} catch {
		return undefined;
	}
}

/** Verbatim on-disk copies of one run's proposer plans, in `succeeded` order. */
export interface ProposalFileSet {
	dir: string;
	files: { label: string; path: string }[];
}

// Shared by the writer and the sweeper: the sweeper only recognizes abandoned
// directories it can match by name, so these must never drift apart.
const PROPOSAL_DIR_PREFIX = "mf-proposals-";

/** How long an abandoned staging directory survives before being swept. */
const PROPOSAL_DIR_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Stage the proposer plans where the synthesizer can re-read them verbatim.
 *
 * These live under `os.tmpdir()`, never the repo: the fan-out mutation tripwire
 * diffs `git status --porcelain`, so an in-repo copy would trip a false "planning
 * agents modified the working tree" alarm and pollute the tree the synthesizer
 * greps. Each run gets its own `mkdtemp` directory holding only its own
 * proposals, so an `ls` cannot expose a sibling run. Filenames are derived from
 * the already-blinded slot label, keeping the synthesizer blind to which model
 * authored which proposal.
 *
 * Returns null if staging fails — callers still inline the proposals, so losing
 * the copies costs recoverability, not correctness.
 */
export function writeProposalFiles(
	proposals: { label: string; plan: string }[],
): ProposalFileSet | null {
	try {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), PROPOSAL_DIR_PREFIX));
		const files = proposals.map(({ label, plan }) => {
			const safeName = label.toLowerCase().replace(/[^\w.-]+/g, "-");
			const filePath = path.join(dir, `${safeName}.md`);
			fs.writeFileSync(filePath, plan, { encoding: "utf-8", mode: 0o600 });
			return { label, path: filePath };
		});
		return { dir, files };
	} catch {
		return null;
	}
}

/** Remove a run's staged proposal copies. Safe to call twice or with null. */
export function cleanupProposalFiles(set: ProposalFileSet | null): void {
	if (!set) return;
	try {
		fs.rmSync(set.dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

/**
 * Drop staging directories that earlier runs abandoned.
 *
 * `cleanupProposalFiles` runs from a `finally`, which a SIGKILL, crash, or power
 * loss never reaches — those runs leak their directory into the temp dir
 * permanently. The age cutoff is far longer than any planning run could last, so
 * a directory old enough to sweep cannot belong to a live session and concurrent
 * runs are never at risk. Best-effort throughout: a planning run must not fail
 * because the temp dir was unreadable.
 */
export function sweepStaleProposalFiles(): void {
	const root = os.tmpdir();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	const cutoff = Date.now() - PROPOSAL_DIR_MAX_AGE_MS;
	for (const entry of entries) {
		// Dirent.isDirectory() reports the entry's own type rather than a symlink
		// target's, so a planted `mf-proposals-*` link cannot redirect the delete
		// somewhere outside the temp dir.
		if (!entry.isDirectory() || !entry.name.startsWith(PROPOSAL_DIR_PREFIX)) continue;
		const dir = path.join(root, entry.name);
		try {
			if (fs.statSync(dir).mtimeMs > cutoff) continue;
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}
