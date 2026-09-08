/**
 * Deterministic script gate + working-tree diff for the verification phase.
 *
 * The read-only verifier subprocess cannot run tests itself (it is spawned with
 * the same `--tools read,grep,find,ls` + read-only env handshake as every other
 * planning agent), so the orchestrator runs the project's own check/lint/test
 * scripts in the parent process and hands the results to the verifier as
 * evidence. `captureImplementationDiff` likewise runs in the parent — never in
 * the read-only subprocess — so a git diff of what the implementer changed can
 * be attached to the verifier task.
 *
 * The gate (`discoverVerifyScripts`/`runVerifyScript`) is ported nearly verbatim
 * from the sibling pi-topping-persona-audit's `src/verify.ts`, with a local
 * `tail` and a local result type so it carries no persona-audit dependencies.
 * It runs AFTER the read-only verifier's mutation-tripwire check, because
 * `npm test` can legitimately write snapshots/coverage and must not trip a
 * false "verifier modified the working tree" alarm.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Preferred script discovery order. */
const SCRIPT_ORDER = ["check", "lint", "test"] as const;

const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 4_000;

/** Keep the trailing `maxChars` of long output, prefixing an ellipsis when cut. */
function tail(text: string, maxChars: number): string {
	const trimmed = text.trim();
	return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed;
}

export interface VerifyResult {
	script: string;
	command: string;
	status: "pass" | "fail";
	exitCode: number;
	relevantOutput: string;
}

/** Discover which of check/lint/test exist in package.json#scripts, in that order. */
export async function discoverVerifyScripts(cwd: string): Promise<string[]> {
	let raw: string;
	try {
		raw = await readFile(`${cwd}/package.json`, "utf-8");
	} catch {
		return [];
	}

	let scripts: Record<string, unknown>;
	try {
		const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
		scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
	} catch {
		return [];
	}

	return SCRIPT_ORDER.filter((name) => typeof scripts[name] === "string");
}

/** Run one discovered verification script via `npm run <script>`. Never throws. */
export async function runVerifyScript(cwd: string, script: string, signal?: AbortSignal): Promise<VerifyResult> {
	const command = `npm run ${script}`;
	try {
		const { stdout, stderr } = await execFileAsync("npm", ["run", script], {
			cwd,
			encoding: "utf-8",
			timeout: SCRIPT_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
			signal,
		});
		return {
			script,
			command,
			status: "pass",
			exitCode: 0,
			relevantOutput: tail(`${stdout}\n${stderr}`, OUTPUT_TAIL_CHARS),
		};
	} catch (error) {
		const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
		return {
			script,
			command,
			status: "fail",
			exitCode: typeof err.code === "number" ? err.code : 1,
			relevantOutput: tail(`${err.stdout ?? ""}\n${err.stderr ?? ""}`, OUTPUT_TAIL_CHARS) || (err.message ?? "unknown error"),
		};
	}
}

const DIFF_MAX_BYTES = 64 * 1024;

/**
 * Best-effort git diff of the current working tree against HEAD, for the
 * verifier task. Returns null outside a git repo. The diff includes any
 * pre-existing uncommitted edits, so the verifier task caveats it as a pointer
 * to what moved rather than proof of what this implementation changed.
 */
export async function captureImplementationDiff(cwd: string): Promise<string | null> {
	const run = async (args: string[]): Promise<string | null> => {
		try {
			const { stdout } = await execFileAsync("git", args, {
				cwd,
				encoding: "utf-8",
				maxBuffer: 16 * 1024 * 1024,
			});
			return stdout;
		} catch {
			return null;
		}
	};

	const stat = await run(["diff", "HEAD", "--stat"]);
	if (stat === null) return null; // not a git repo (or git unavailable)

	let full = (await run(["diff", "HEAD"])) ?? "";
	let truncated = false;
	if (Buffer.byteLength(full, "utf-8") > DIFF_MAX_BYTES) {
		full = full.slice(0, DIFF_MAX_BYTES);
		truncated = true;
	}

	const untracked = await run(["ls-files", "--others", "--exclude-standard"]);

	const sections: string[] = [];
	if (stat.trim()) sections.push(`Diffstat (git diff HEAD --stat):\n${stat.trim()}`);
	if (untracked?.trim()) sections.push(`Untracked files:\n${untracked.trim()}`);
	if (full.trim()) {
		sections.push(`Diff (git diff HEAD)${truncated ? " — TRUNCATED to 64 KB" : ""}:\n${full.trim()}`);
	}
	return sections.length > 0 ? sections.join("\n\n") : "(no changes detected against HEAD)";
}
