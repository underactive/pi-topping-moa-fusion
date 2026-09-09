/**
 * Working-tree mutation tripwire for plan mode.
 *
 * Plan-mode subprocesses are spawned read-only (pi `--tools` allowlist plus
 * the PI_CURSOR_FORCE_MODE handshake for agentic provider bridges), but that
 * boundary is ultimately cooperative for providers that run full agents with
 * their own local tools outside pi's tool loop. This module detects — via
 * `git status --porcelain` snapshots — any working-tree change that appears
 * while planning agents run, so the orchestration can warn loudly instead of
 * silently absorbing rogue edits.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { mapWithConcurrencyLimit } from "./processPool.ts";

const execFileAsync = promisify(execFile);

/** `git status --porcelain` snapshot, or null when unavailable (not a git repo, no git). */
export async function captureWorkingTreeState(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], {
			cwd,
			maxBuffer: 10 * 1024 * 1024,
		});
		const fields = stdout.split("\0");
		const lines: string[] = [];
		for (let index = 0; index < fields.length; index++) {
			const field = fields[index];
			if (!field) continue;
			const status = field.slice(0, 2);
			const destination = field.slice(3);
			if (status.includes("R") || status.includes("C")) {
				const source = fields[++index];
				if (source === undefined) continue;
				lines.push(`${status} ${JSON.stringify(source)} -> ${JSON.stringify(destination)}`);
			} else {
				lines.push(`${status} ${JSON.stringify(destination)}`);
			}
		}
		return lines.length > 0 ? `${lines.join("\n")}\n` : "";
	} catch {
		return null;
	}
}

interface PorcelainEntry {
	displayPath: string;
	relativePath: string;
}

function parseJsonPathPrefix(value: string): { path: string; end: number } | undefined {
	if (!value.startsWith('"')) return undefined;
	let escaped = false;
	for (let index = 1; index < value.length; index++) {
		const char = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char !== '"') continue;
		try {
			const parsed: unknown = JSON.parse(value.slice(0, index + 1));
			return typeof parsed === "string" ? { path: parsed, end: index + 1 } : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Parse canonical JSON-quoted snapshots and legacy human-readable porcelain lines. */
function parsePorcelainEntry(line: string): PorcelainEntry {
	const field = line.slice(3).trim();
	const first = parseJsonPathPrefix(field);
	if (first) {
		const remainder = field.slice(first.end);
		if (remainder.startsWith(" -> ")) {
			const second = parseJsonPathPrefix(remainder.slice(4));
			if (second) return { displayPath: `${first.path} -> ${second.path}`, relativePath: second.path };
		}
		return { displayPath: first.path, relativePath: first.path };
	}
	const renameAt = field.lastIndexOf(" -> ");
	return renameAt >= 0
		? { displayPath: field, relativePath: field.slice(renameAt + 4) }
		: { displayPath: field, relativePath: field };
}

/** "XY path" / "XY old -> new" porcelain line → displayable path. */
export function porcelainPath(line: string): string {
	return parsePorcelainEntry(line).displayPath;
}

const MAX_HASH_FILE_BYTES = 16 * 1024 * 1024;
const MAX_HASH_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_HASH_DIRECTORY_ENTRIES = 2048;

interface DirectoryEntryFingerprint {
	hash: string;
	statSignature: string;
}

async function fingerprintDirectory(
	directory: string,
	previous?: WorkingTreeFingerprint,
): Promise<WorkingTreeFingerprint> {
	const hash = createHash("sha256");
	const directoryEntries = new Map<string, DirectoryEntryFingerprint>();
	let entryCount = 0;
	let contentBytes = 0;
	let truncated = false;

	const walk = async (current: string, prefix: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (entryCount >= MAX_HASH_DIRECTORY_ENTRIES) {
				truncated = true;
				return;
			}
			entryCount++;
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const entryPath = path.join(current, entry.name);
			const metadata = await lstat(entryPath);
			const kind = entry.isDirectory() ? "d" : entry.isFile() ? "f" : entry.isSymbolicLink() ? "l" : "o";
			hash.update(`${kind}:${relative}:${metadata.size}:${metadata.mtimeMs}\0`);
			if (entry.isDirectory()) {
				await walk(entryPath, relative);
				if (truncated) return;
			} else if (entry.isFile()
				&& metadata.size <= MAX_HASH_FILE_BYTES
				&& contentBytes + metadata.size <= MAX_HASH_DIRECTORY_BYTES) {
				const statSignature = `${metadata.size}:${metadata.mtimeMs}`;
				const prior = previous?.directoryEntries?.get(relative);
				const contentHash = prior?.statSignature === statSignature
					? prior.hash
					: createHash("sha256").update(await readFile(entryPath)).digest("hex");
				contentBytes += metadata.size;
				directoryEntries.set(relative, { hash: contentHash, statSignature });
				hash.update(contentHash);
			}
		}
	};

	await walk(directory, "");
	return {
		hash: `directory:${entryCount}:${contentBytes}:${truncated ? "truncated" : "complete"}:${hash.digest("hex")}`,
		directoryEntries,
	};
}

export interface WorkingTreeFingerprint {
	hash: string;
	statSignature?: string;
	directoryEntries?: ReadonlyMap<string, DirectoryEntryFingerprint>;
}

/** Fingerprint every path currently mentioned by porcelain output. */
export async function hashWorkingTreeFiles(
	cwd: string,
	porcelain: string,
	previous?: ReadonlyMap<string, WorkingTreeFingerprint>,
): Promise<Map<string, WorkingTreeFingerprint>> {
	const fingerprints = new Map<string, WorkingTreeFingerprint>();
	const root = path.resolve(cwd);
	await mapWithConcurrencyLimit(porcelain.split("\n").filter(Boolean), 8, async (line) => {
		const { displayPath, relativePath } = parsePorcelainEntry(line);
		try {
			const filePath = path.resolve(root, relativePath);
			if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new Error("Path escapes repository");
			const metadata = await lstat(filePath);
			if (metadata.isDirectory()) {
				fingerprints.set(displayPath, await fingerprintDirectory(filePath, previous?.get(displayPath)));
				return;
			}
			const statSignature = `${metadata.size}:${metadata.mtimeMs}`;
			if (!metadata.isFile() || metadata.size > MAX_HASH_FILE_BYTES) {
				fingerprints.set(displayPath, { hash: statSignature, statSignature });
				return;
			}
			const prior = previous?.get(displayPath);
			if (prior?.statSignature === statSignature) {
				fingerprints.set(displayPath, prior);
				return;
			}
			const content = await readFile(filePath);
			fingerprints.set(displayPath, {
				hash: createHash("sha256").update(content).digest("hex"),
				statSignature,
			});
		} catch {
			fingerprints.set(displayPath, { hash: "unreadable" });
		}
	});
	return fingerprints;
}

/** Paths whose porcelain status differs between two snapshots (either direction). */
export function diffWorkingTreeStates(before: string, after: string): string[] {
	const beforeLines = new Set(before.split("\n").filter(Boolean));
	const afterLines = new Set(after.split("\n").filter(Boolean));
	const changed = new Set<string>();
	for (const line of afterLines) if (!beforeLines.has(line)) changed.add(porcelainPath(line));
	for (const line of beforeLines) if (!afterLines.has(line)) changed.add(porcelainPath(line));
	return [...changed];
}

export class MutationTripwire {
	private baseline: string | null = null;
	private baselineHashes: Map<string, WorkingTreeFingerprint> | null = null;

	/** Snapshot the working tree before spawning planning agents. */
	async arm(cwd: string): Promise<void> {
		this.baseline = await captureWorkingTreeState(cwd);
		this.baselineHashes = this.baseline === null ? null : await hashWorkingTreeFiles(cwd, this.baseline);
	}

	/**
	 * Paths changed since the last arm()/check(). Re-baselines on every call so
	 * subsequent checks only report NEW changes (a fan-out warning is not
	 * repeated after synthesis). Returns [] when git state is unavailable.
	 */
	async check(cwd: string): Promise<string[]> {
		if (this.baseline === null) return [];
		const current = await captureWorkingTreeState(cwd);
		if (current === null) return [];
		const currentHashes = await hashWorkingTreeFiles(cwd, current, this.baselineHashes ?? undefined);
		const changed = new Set(diffWorkingTreeStates(this.baseline, current));
		for (const path of new Set([...(this.baselineHashes?.keys() ?? []), ...currentHashes.keys()])) {
			if (this.baselineHashes?.get(path)?.hash !== currentHashes.get(path)?.hash) changed.add(path);
		}
		this.baseline = current;
		this.baselineHashes = currentHashes;
		return [...changed];
	}
}

/** One-line warning for a non-empty change set, capped for notify() display. */
export function formatMutationWarning(phase: string, changed: string[]): string {
	const shown = changed.slice(0, 6).join(", ");
	const more = changed.length > 6 ? ` (+${changed.length - 6} more)` : "";
	return `⚠ Repo files changed during ${phase} — planning agents must never modify the working tree. Review with git status / git diff: ${shown}${more}`;
}
