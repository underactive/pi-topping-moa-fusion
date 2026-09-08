/**
 * Post-implementation verification + bounded repair phase.
 *
 * Once an approved MoA plan has been implemented in the current session and the
 * turn settles, this phase judges the working tree against the frozen approved
 * plan. It runs the project's own check/lint/test scripts in the parent
 * process, captures a git diff, then launches a read-only `moa-verifier`
 * subprocess (same `--tools read,grep,find,ls` + read-only env handshake as
 * every other planning agent) that emits a parseable verdict. The verifier
 * cannot run tests itself, so the gate results and diff are handed to it as
 * evidence — the implementer's own report is treated as an untrusted claim.
 *
 * A `complete` verdict with a clean script gate ends the phase. Anything less
 * offers the user a bounded repair round (up to MAX_VERIFICATION_REPAIRS): the
 * verifier's gaps and failing checks are shown inline in the repair/accept
 * dialog and sent back to the same in-session implementer via the existing
 * kickoff machinery. The result is then verified again. "Accept implementation
 * as-is" is always available.
 */

import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { loadMoaConfig } from "../config/settings.ts";
import { installShippedAgents, shippedAgentsDir, withAuthoritativeMoaAgents } from "../agents/authoritative.ts";
import { discoverAgents } from "../agents/discovery.ts";
import { readRepoPlanFile, saveRepoPlanFile } from "../planning/planFile.ts";
import { CancelRun, type CancelSession } from "../runtime/cancelRun.ts";
import { formatMutationWarning, MutationTripwire } from "../runtime/mutationTripwire.ts";
import { getFinalOutput, getResultOutput, isFailedResult, type SingleResult } from "../runtime/results.ts";
import { runSingleAgent } from "../runtime/runner.ts";
import { modelRefLabel, TRIGGER_TURN } from "../shared/modelRefs.ts";
import { activityLoopCount } from "../ui/agentStatus.ts";
import { showVerificationFindings } from "../ui/verificationFindingsOverlay.ts";
import {
	buildImplementationKickoffMessage,
	resolveHandoffPlan,
	type ImplementationHandoff,
} from "./implementationRetry.ts";
import { modelExtensionOptions, resolveContextWindow, resolveModelCost } from "./modelRuntime.ts";
import { parseVerificationCriteria, type VerificationCriterion } from "./verificationCriteria.ts";
import type { MoaRunHost } from "./runContext.ts";
import { captureImplementationDiff, discoverVerifyScripts, runVerifyScript, type VerifyResult } from "./verifyGate.ts";

/** How many verifier-driven repair rounds a single implementation may consume. */
export const MAX_VERIFICATION_REPAIRS = 2;

export type VerificationVerdictValue = "complete" | "partial" | "incomplete" | "cannot-verify";

export interface CriterionVerdict {
	id: string;
	status: "pass" | "fail" | "cannot-verify";
	evidence: string;
}

export interface VerificationVerdict {
	/** Undefined when the verifier output could not be parsed — treated as non-passing. */
	verdict: VerificationVerdictValue | undefined;
	summary: string;
	gaps: string[];
	steps: string[];
	criteria: CriterionVerdict[];
}

/** Failure details retained from a verifier subprocess for diagnostics and recovery UI. */
export interface VerifierFailureDetail {
	output?: string;
	stopReason?: string;
	errorMessage?: string;
	exitCode?: number;
	stderr?: string;
	/** Number of parsed messages; zero distinguishes a verifier that never started. */
	messageCount?: number;
	/** Accepted for direct callers/tests that already have the raw message list. */
	messages?: readonly unknown[];
}

interface VerifierRunOutcome extends VerifierFailureDetail {
	output: string;
	cancelled: boolean;
	failed: boolean;
	messageCount: number;
}

const MAX_FAILURE_SUMMARY_CHARS = 1_000;
const MAX_PROMPT_SUMMARY_CHARS = 1_200;
const MAX_PROMPT_GAP_BULLETS = 15;
const MAX_PROMPT_BULLET_CHARS = 200;
const MAX_PROMPT_CHECK_LINES = 6;
const MAX_PROMPT_CHECK_CHARS = 800;
/** ExtensionSelectorComponent uses Text(..., paddingX=1), reserving one column on each side of its title. */
const SELECTOR_TITLE_WIDTH_RESERVE = 2;

function oneLineTail(value: string | undefined, maxChars = MAX_FAILURE_SUMMARY_CHARS): string {
	if (!value) return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `…${normalized.slice(-(maxChars - 1))}`;
}

/**
 * Turn a failed verifier result into a short classified diagnostic. The full
 * output remains available to the caller for notifications and persistence.
 */
export function formatVerifierFailure(result: VerifierFailureDetail): string {
	const messageCount = result.messageCount ?? result.messages?.length;
	const detail = oneLineTail(result.errorMessage)
		|| oneLineTail(result.stderr)
		|| oneLineTail(result.output)
		|| "unknown error";
	if (result.exitCode !== undefined && result.exitCode !== 0 && messageCount === 0) {
		return `verifier never started (exit ${result.exitCode}): ${detail}`;
	}
	if (result.stopReason === "error") return `verifier provider error: ${detail}`;
	return detail;
}

function verifierOutcomeFromResult(result: SingleResult): VerifierRunOutcome {
	const cancelled = result.cancelled === true;
	const failed = !cancelled && isFailedResult(result);
	return {
		output: cancelled ? "" : failed ? getResultOutput(result) : getFinalOutput(result.messages),
		cancelled,
		failed,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
		exitCode: result.exitCode,
		stderr: result.stderr,
		messageCount: result.messages.length,
	};
}

/**
 * Read-only verification contract, carried inside the task text so it reaches
 * the model even when a provider bridge replaces the moa-verifier system prompt
 * with its own harness (same reason as SYNTHESIZER_TASK_PREAMBLE).
 */
export const VERIFIER_TASK_PREAMBLE =
	"You are the read-only VERIFIER in a Mixture-of-Agents planning run. An implementing agent has already applied an approved plan to the working tree; your only deliverable is a verdict on whether the plan actually landed, emitted as markdown text in your reply. This is a read-only audit: do NOT edit files, and do NOT run builds, tests, or any command — the check/lint/test results are provided to you below as evidence. Having only read-only tools is expected and is never a blocker. Verify each plan step against the LIVE repository, reading the files each step names; the implementer's self-report is an untrusted claim, never proof.";

const VERIFIER_OUTPUT_CONTRACT = `## Required output format

Judge each plan step against the live repo, then emit exactly these sections at the end of your reply (the markup is parsed — match it precisely):

## Step Verdicts
- **Step 1:** done | partial | missing | cannot-verify — <evidence: file:line, or what is missing>
(one bullet per approved plan step)

## Deviations
- <anything implemented that the plan did not call for, or done differently> (or "None.")

## Verification Result
**Verdict:** complete | partial | incomplete | cannot-verify
**Summary:** <one paragraph>

### Gaps
- <unmet or partial plan step> — <evidence>

Rules: a change at one of several call sites the plan implies is \`partial\`, not \`done\`. Prefer \`cannot-verify\` over a guess. Use \`complete\` only when every step landed and every provided check passed, and only then omit the \`### Gaps\` section.`;

export function buildVerifierTask(input: {
	plan: string;
	implementerReport: string | undefined;
	diff: string | null;
	scriptResults: VerifyResult[];
	cwd: string;
	criteria?: VerificationCriterion[];
}): string {
	const { plan, implementerReport, diff, scriptResults, criteria } = input;
	const reportSection = implementerReport && implementerReport.trim()
		? implementerReport.trim()
		: "(The implementer produced no final summary message.)";
	const diffSection = diff && diff.trim()
		? diff.trim()
		: "(No git diff available — not a git repository, or no changes detected.)";
	const outputContract = criteria?.length
		? `## Required output format\n\nEmit exactly these sections at the end of your reply:\n\n## Criteria Verdicts\n${criteria.map((criterion) => `- **${criterion.id}:** pass | fail | cannot-verify — <evidence: file:line or what is missing>`).join("\n")}\n(one bullet per supplied criterion; no IDs skipped)\n\n## Deviations\n- <anything implemented differently> (or "None.")\n\n## Verification Result\n**Verdict:** complete | partial | incomplete | cannot-verify\n**Summary:** <one paragraph>\n\n### Gaps\n- <unmet criterion> — <evidence>\n\nUse complete only when every criterion is pass and every provided check passed. Prefer cannot-verify over a guessed pass.`
		: VERIFIER_OUTPUT_CONTRACT;
	const gateSection = scriptResults.length > 0
		? scriptResults
			.map((r) => `- ${r.command} → ${r.status.toUpperCase()} (exit ${r.exitCode})\n\`\`\`\n${r.relevantOutput}\n\`\`\``)
			.join("\n\n")
		: "(No check/lint/test scripts were discovered in package.json.)";

	return [
		VERIFIER_TASK_PREAMBLE,
		"---",
		`## Approved plan (source of truth)\nVerify the working tree against every step of this plan:\n\n${plan}`,
		criteria?.length ? `## Verification criteria (authoritative pass/fail checklist)\n${criteria.map((criterion) => `- **${criterion.id}:** ${criterion.text}`).join("\n")}\n\nWhen criteria are supplied, emit ## Criteria Verdicts with one \`- **C<n>:** pass | fail | cannot-verify — evidence\` bullet for every criterion and no skipped ids, then ## Deviations and the required ## Verification Result. Use complete only when every criterion is pass; use cannot-verify rather than guessing.` : "",
		"---",
		`## Implementer's self-report (UNTRUSTED CLAIM — not evidence)\n${reportSection}`,
		"---",
		`## Recent changes (git diff HEAD — may include pre-existing edits; attribute only plan-relevant changes)\n${diffSection}`,
		"---",
		`## Project verification script results (evidence)\n${gateSection}`,
		"---",
		outputContract,
	].join("\n\n");
}

/** Collect `- …`/`* …` bullets under a heading, stopping at the next heading. */
function sectionBullets(output: string, heading: RegExp): string[] {
	const lines = output.split("\n");
	const start = lines.findIndex((line) => heading.test(line));
	if (start < 0) return [];
	const bullets: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*#{1,6}\s/.test(line)) break;
		const match = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
		if (match) bullets.push(match[1].trim());
	}
	return bullets;
}

/**
 * Parse the moa-verifier output contract. Defaults to `verdict: undefined`
 * (a non-passing outcome) when the `**Verdict:**` line is absent or malformed,
 * so garbled output can never be mistaken for a pass.
 */
export function parseVerificationVerdict(output: string): VerificationVerdict {
	const verdictMatch = output.match(/^\s*\*\*Verdict:\*\*\s*(complete|partial|incomplete|cannot-verify)\b/im);
	const verdict = verdictMatch ? (verdictMatch[1].toLowerCase() as VerificationVerdictValue) : undefined;
	const summaryMatch = output.match(/^\s*\*\*Summary:\*\*\s*(.+)$/im);
	const summary = summaryMatch ? summaryMatch[1].trim() : "";
	const gaps = sectionBullets(output, /^\s*#{2,3}\s+Gaps\b/i);
	const steps = sectionBullets(output, /^\s*##\s+Step Verdicts\b/i);
	const criteria: CriterionVerdict[] = [];
	for (const bullet of sectionBullets(output, /^\s*##\s+Criteria Verdicts\b/i)) {
		const match = bullet.match(/^\*\*(C\d+):?\*\*:?[\s]*(pass|fail|cannot-verify)\b\s*(?:—|-)?\s*(.*)$/i);
		if (match) criteria.push({ id: match[1].toUpperCase(), status: match[2].toLowerCase() as CriterionVerdict["status"], evidence: match[3].trim() });
	}
	return { verdict, summary, gaps, steps, criteria };
}

export function deriveCriteriaVerdict(parsed: VerificationVerdict, expected: VerificationCriterion[]): { verdict: VerificationVerdictValue; gaps: string[] } {
	const byId = new Map(parsed.criteria.map((criterion) => [criterion.id, criterion]));
	const gaps: string[] = [];
	let passed = 0;
	let failed = 0;
	let unverifiable = 0;
	for (const criterion of expected) {
		const result = byId.get(criterion.id);
		if (!result) { unverifiable++; gaps.push(`${criterion.id} was not judged: ${criterion.text}`); continue; }
		if (result.status === "pass") { passed++; continue; }
		if (result.status === "fail") failed++;
		else unverifiable++;
		gaps.push(`${criterion.id} ${result.status}: ${criterion.text} — ${result.evidence}`);
	}
	if (failed > 0) return { verdict: passed > 0 ? "partial" : "incomplete", gaps };
	if (unverifiable > 0) return { verdict: "cannot-verify", gaps };
	return { verdict: "complete", gaps };
}

/**
 * Fold the verifier verdict and the script gate into one pass/fail decision.
 * Only a `complete` verdict with a clean gate passes — an unparseable verdict
 * (`undefined`) or any failing script keeps the implementation repair-eligible.
 */
export function verificationPassed(
	verdict: VerificationVerdictValue | undefined,
	scriptResults: VerifyResult[],
): boolean {
	return verdict === "complete" && scriptResults.every((r) => r.status !== "fail");
}

/** Split a verifier summary into short paragraphs without breaking common references. */
export function splitIntoParagraphs(text: string, sentencesPerParagraph = 2): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const capped = trimmed.length > MAX_PROMPT_SUMMARY_CHARS
		? `${trimmed.slice(0, MAX_PROMPT_SUMMARY_CHARS - 1)}…`
		: trimmed;
	const sentences = capped.split(/(?<!e\.g\.)(?<!i\.e\.)(?<=[.!?])\s+(?=[A-Z0-9`"'(\[])/);
	const paragraphs: string[] = [];
	const paragraphSize = Math.max(1, Math.floor(sentencesPerParagraph));
	for (let i = 0; i < sentences.length; i += paragraphSize) {
		paragraphs.push(sentences.slice(i, i + paragraphSize).join(" "));
	}
	return paragraphs;
}

/** Build a short, deterministic summary for the repair decision dialog. */
export function buildVerificationSummary(parsed: VerificationVerdict, scriptResults: VerifyResult[]): string[] {
	const lines = [`Verification result: ${parsed.verdict ?? "unknown"}.`];
	if (parsed.criteria.length > 0) {
		const passed = parsed.criteria.filter((criterion) => criterion.status === "pass").length;
		const failed = parsed.criteria.length - passed;
		lines.push(`${passed} of ${parsed.criteria.length} criteria passed. ${failed} failed.`);
	} else if (parsed.gaps.length > 0) {
		lines.push(`The verifier found ${parsed.gaps.length} gap${parsed.gaps.length === 1 ? "" : "s"}.`);
	}
	if (scriptResults.length > 0) {
		const failed = scriptResults.filter((result) => result.status === "fail").length;
		lines.push(failed === 0
			? "All project checks passed."
			: `${failed} project check${failed === 1 ? "" : "s"} failed.`);
	}
	return lines.slice(0, 3);
}

function elideMiddle(value: string, width: number): string {
	if (visibleWidth(value) <= width) return value;
	const marker = "…";
	const available = Math.max(2, width - visibleWidth(marker));
	const prefixWidth = Math.floor(available * 0.4);
	const suffixWidth = available - prefixWidth;
	const prefix = truncateToWidth(value, prefixWidth, "", false);
	let suffix = "";
	for (const character of Array.from(value).reverse()) {
		if (visibleWidth(character + suffix) > suffixWidth) break;
		suffix = character + suffix;
	}
	return `${prefix}${marker}${suffix}`;
}

/** Build the compact prompt shown above the fixed repair choices. */
export function buildVerificationDecisionPrompt(
	parsed: VerificationVerdict,
	scriptResults: VerifyResult[],
	reportPath?: string,
	width = 80,
): string {
	const budget = Math.max(20, width);
	const lines = [
		...buildVerificationSummary(parsed, scriptResults),
		"",
		reportPath
			? elideMiddle(`Full findings: ${reportPath}`, budget)
			: "Full findings will be sent to the implementer if you continue.",
	];
	return lines
		.map((line) => line ? truncateToWidth(line, budget, "…", false) : line)
		.join("\n");
}

/** Format the bounded, plain-text findings sent to repairs and terminal notifications. */
export function formatVerificationReport(parsed: VerificationVerdict, failedScripts: VerifyResult[]): string {
	const sections: string[] = [];
	const summaryParagraphs = splitIntoParagraphs(parsed.summary);
	if (summaryParagraphs.length > 0) sections.push(`Verifier summary:\n${summaryParagraphs.join("\n\n")}`);
	if (parsed.gaps.length > 0) {
		const heading = parsed.criteria.length > 0 ? "Criteria not met:" : "Gaps:";
		const bullets = parsed.gaps
			.slice(0, MAX_PROMPT_GAP_BULLETS)
			.map((gap) => `- ${oneLineTail(gap, MAX_PROMPT_BULLET_CHARS)}`);
		if (parsed.gaps.length > MAX_PROMPT_GAP_BULLETS) {
			bullets.push(`… and ${parsed.gaps.length - MAX_PROMPT_GAP_BULLETS} more (see the saved verification report)`);
		}
		sections.push(`${heading}\n${bullets.join("\n")}`);
	}
	if (failedScripts.length > 0) {
		const checks = failedScripts.map((result) => {
			const outputLines = result.relevantOutput.split("\n");
			const output = outputLines.slice(-MAX_PROMPT_CHECK_LINES).join("\n");
			const marker = "… (output truncated)";
			const clipped = outputLines.length > MAX_PROMPT_CHECK_LINES || output.length > MAX_PROMPT_CHECK_CHARS
				? `${marker}\n${output.slice(-(MAX_PROMPT_CHECK_CHARS - marker.length - 1))}`
				: output;
			return `- ${result.command} failed (exit ${result.exitCode}):\n${clipped.split("\n").map((line) => `    ${line}`).join("\n")}`;
		});
		sections.push(`Failing project checks:\n${checks.join("\n")}`);
	}
	return sections.join("\n\n");
}

function buildRepairNote(parsed: VerificationVerdict, failedScripts: VerifyResult[]): string {
	const parts: string[] = [
		"The verifier reviewed your implementation against the approved plan and found it did not fully land.",
		`Verdict: ${parsed.verdict ?? "unclear"}.`,
	];
	if (parsed.summary) parts.push(`Verifier summary: ${parsed.summary}`);
	if (parsed.criteria.some((criterion) => criterion.status !== "pass")) {
		parts.push(`Failing verification criteria:\n${parsed.criteria.filter((criterion) => criterion.status !== "pass").map((criterion) => `- ${criterion.id} ${criterion.status}: ${criterion.evidence}`).join("\n")}`);
	}
	if (parsed.gaps.length > 0) {
		parts.push(`Unmet or partial plan steps:\n${parsed.gaps.map((g) => `- ${g}`).join("\n")}`);
	}
	if (failedScripts.length > 0) {
		const fails = failedScripts
			.map((r) => `- \`${r.command}\` failed (exit ${r.exitCode}):\n${r.relevantOutput}`)
			.join("\n");
		parts.push(`Failing project checks:\n${fails}`);
	}
	parts.push(
		"Close every gap above. The frozen verification criteria will be re-checked. Re-read the approved plan and the files each unmet step names, make the changes, then run the project's check/lint/test scripts yourself to confirm they pass before finishing.",
	);
	return parts.join("\n\n");
}

/**
 * The interactive decision offered when a settled implementation is
 * repair-eligible and a UI is present. Extracted from
 * `runImplementationVerification` so the view/repair/accept branching can be
 * driven directly in tests.
 *
 * "View full findings" is non-terminal: it opens the read-only findings popup
 * and then reopens the same selector, without consuming a repair round, sending
 * a message, mutating handoff state, or finishing verification. Only "Send
 * verifier findings to the implementer" (repair) and "Accept implementation
 * as-is" (also the selector-cancellation fallthrough) end the decision.
 *
 * The findings popup needs a TUI overlay surface, so "View full findings" is
 * offered only when `isTui` is set. Outside the TUI (e.g. an RPC UI, which still
 * reports `hasUI`), the original two choices are shown, avoiding a third option
 * whose popup would immediately return with nothing to display.
 */
export async function runVerificationDecision(deps: {
	ctx: ExtensionContext;
	host: MoaRunHost;
	handoff: ImplementationHandoff;
	parsed: VerificationVerdict;
	scriptResults: VerifyResult[];
	failedScripts: VerifyResult[];
	plan: string;
	/** Raw verifier report, shown verbatim in the read-only findings popup. */
	report: string;
	reportPath: string | undefined;
	repairsUsed: number;
	/** Whether an overlay surface exists; when false, the View option is omitted. */
	isTui: boolean;
	widget: ReturnType<MoaRunHost["getActiveProgressWidget"]>;
	finish: (state: "done" | "error" | "cancelled") => void;
	/** Overridable in tests; defaults to the real read-only overlay. */
	showFindings?: (ctx: ExtensionContext, findingsMarkdown: string) => Promise<void>;
}): Promise<void> {
	const { ctx, host, handoff, parsed, scriptResults, failedScripts, plan, report, reportPath, repairsUsed, isTui, widget, finish } = deps;
	const showFindings = deps.showFindings ?? showVerificationFindings;
	const promptWidth = Math.max(20, (process.stdout.columns ?? 80) - SELECTOR_TITLE_WIDTH_RESERVE);
	const options = isTui
		? ["View full findings", "Send verifier findings to the implementer", "Accept implementation as-is"]
		: ["Send verifier findings to the implementer", "Accept implementation as-is"];
	while (true) {
		const choice = await ctx.ui.select(
			buildVerificationDecisionPrompt(parsed, scriptResults, reportPath, promptWidth),
			options,
		);
		if (choice === "View full findings") {
			await showFindings(ctx, report);
			continue;
		}
		if (choice === "Send verifier findings to the implementer") {
			const updated: ImplementationHandoff = {
				...handoff,
				verificationRepairs: repairsUsed + 1,
				timestamp: Date.now(),
			};
			host.setImplementationHandoff(updated);
			// Reactivate the Implement row for the repair round and leave the table
			// mounted; the next settled turn re-enters this verification flow.
			widget?.settleRoleRow("Verify", "done");
			if (handoff.model) widget?.switchToImplementing(handoff.model, "addressing verifier findings…", handoff.thinking);
			host.markImplementationPending(ctx);
			const repairNote = buildRepairNote(parsed, failedScripts);
			await host.pi.sendUserMessage(
				buildImplementationKickoffMessage(plan, handoff.planFilePath, repairNote),
				TRIGGER_TURN,
			);
			return;
		}
		// "Accept implementation as-is" — and the selector-cancellation fallthrough.
		ctx.ui.notify(`Verification verdict: ${parsed.verdict}. Implementation accepted as-is.`, "warning");
		finish("done");
		return;
	}
}

/**
 * Verify a settled implementation against its approved plan and, on gaps, offer
 * a bounded repair round back to the in-session implementer. Best-effort: any
 * unrecoverable step notifies and returns rather than throwing into the caller
 * (which is a fire-and-forget `onAgentSettled` handler).
 */
export async function runImplementationVerification(
	ctx: ExtensionContext,
	host: MoaRunHost,
	handoff: ImplementationHandoff,
	implementerReport: string | undefined,
	// Overridable in tests; defaults to the real verifier subprocess launcher.
	// The seam lets a test drive the failure → synthesizer-fallback → success path
	// and record the thinking level handed to each subprocess.
	options: { runSingleAgent?: typeof runSingleAgent } = {},
): Promise<void> {
	const runVerifier = options.runSingleAgent ?? runSingleAgent;
	const verifier = handoff.verifier;
	if (!verifier) return; // Callers guard this; defensive.

	const plan = resolveHandoffPlan(handoff, ctx.cwd);
	if (!plan) {
		ctx.ui.notify("Verification skipped — the approved plan content could not be retrieved from disk.", "error");
		return;
	}

	const criteriaMarkdown = handoff.verificationCriteria
		?? (handoff.repoPlanSlug ? readRepoPlanFile(ctx.cwd, handoff.repoPlanSlug, "criteria") : undefined);
	const criteria = criteriaMarkdown ? parseVerificationCriteria(criteriaMarkdown) : [];

	installShippedAgents();
	const discovery = discoverAgents(ctx.cwd, "user");
	const agents = withAuthoritativeMoaAgents(discovery.agents, shippedAgentsDir());

	// The verification phase reuses the table orchestration adopted on approval
	// (or reconstructed on resume), reactivating the Verify row and pointing the
	// band at Verify.
	const widget = host.getActiveProgressWidget();
	widget?.setActivePhase("Verify");
	// `activeVerifierThinking` is not declared yet; the initial project-checks
	// activation carries the handoff's verifier level, which it is seeded from.
	widget?.switchToVerifying(verifier, "running project checks…", handoff.verifierThinking);

	// Diff and script gate run in the parent, BEFORE the verifier's mutation
	// tripwire is armed: `npm test` may legitimately write snapshots/coverage,
	// and baking those into the tripwire baseline is what keeps them from
	// tripping a false "verifier modified the working tree" alarm. The diff is
	// captured before the gate so test artifacts do not pollute it.
	const diff = await captureImplementationDiff(ctx.cwd);
	const scripts = await discoverVerifyScripts(ctx.cwd);
	const scriptResults: VerifyResult[] = [];
	if (scripts.length > 0) {
		ctx.ui.notify(`Verifying implementation — running project checks (${scripts.join(", ")})…`);
		const scriptSession: CancelSession = { title: "MoA verification — project checks", run: undefined, overlayOpen: false };
		host.setActiveCancelSession(scriptSession);
		const scriptRun = new CancelRun();
		scriptSession.run = scriptRun;
		try {
			for (const script of scripts) {
				const slot = scriptRun.add(script);
				scriptResults.push(await runVerifyScript(ctx.cwd, script, slot.signal));
				if (scriptRun.cancelAllRequested) break;
			}
		} finally {
			host.setActiveCancelSession(undefined);
		}
	}

	const config = loadMoaConfig();
	let activeVerifier = verifier;
	let activeVerifierThinking = handoff.verifierThinking;
	let activeHandoff = handoff;

	const runVerifierPreflight = async (): Promise<VerifierRunOutcome> => {
		const verifier = activeVerifier;
		widget?.switchToVerifying(verifier, "checking verifier…", activeVerifierThinking);
		const result = await runVerifier(
			ctx.cwd, agents, "moa-verifier", "Reply with the single word ok", undefined, undefined, undefined,
			modelRefLabel(verifier), activeVerifierThinking, {
				...modelExtensionOptions(ctx, verifier),
				resolveOnAbort: true,
			},
		);
		return verifierOutcomeFromResult(result);
	};

	const runVerifierOnce = async (verificationTask: string): Promise<VerifierRunOutcome> => {
		const verifier = activeVerifier;
		const tripwire = new MutationTripwire();
		await tripwire.arm(ctx.cwd);

		widget?.switchToVerifying(verifier, "verifying implementation…", activeVerifierThinking);
		widget?.updateRoleTranscript("Verify", []);

		const session: CancelSession = { title: "MoA verification", run: undefined, overlayOpen: false };
		host.setActiveCancelSession(session);
		const run = new CancelRun();
		const label = modelRefLabel(verifier);
		const slot = run.add(label);
		session.run = run;
		session.getExtras = () => {
			const s = widget?.getRoleStatus("Verify");
			return {
				contextTokens: s?.contextTokens,
				contextWindow: s?.ref ? resolveContextWindow(ctx, s.ref) : undefined,
				activity: s?.activity,
				loopCount: activityLoopCount(s?.activity, s?.activityHistory),
			};
		};

		try {
			const result = await runVerifier(
				ctx.cwd, agents, "moa-verifier", verificationTask, undefined, slot.signal, undefined,
				label, activeVerifierThinking, {
					...modelExtensionOptions(ctx, verifier),
					resolveOnAbort: true,
					onProgress: (r) => {
						widget?.updateRoleUsage(
							"Verify",
							r.usage.contextTokens,
							r.usage.turns,
							r.usage.toolCalls,
							resolveModelCost(ctx, verifier, r.usage),
						);
						if (r.activity) widget?.updateRoleActivity("Verify", r.activity);
						if (r.outputActivity) widget?.updateRoleOutput("Verify", r.outputActivity.tokens, r.outputActivity.revision);
						widget?.updateRoleTranscript("Verify", r.messages, r.partialAssistant);
					},
				},
			);
			widget?.updateRoleTranscript("Verify", result.messages);
			const changed = await tripwire.check(ctx.cwd);
			if (changed.length > 0) ctx.ui.notify(formatMutationWarning("MoA verification", changed), "error");
			if (result.cancelled || run.cancelAllRequested) {
				return { output: "", cancelled: true, failed: false, messageCount: result.messages.length };
			}
			return verifierOutcomeFromResult(result);
		} finally {
			session.run = undefined;
			session.getExtras = undefined;
			host.setActiveCancelSession(undefined);
		}
	};

	// Run the verifier; on a cancelled/failed/unparseable outcome offer a retry
	// that does NOT consume a repair round (the implementation is unchanged).
	const finish = (state: "done" | "error" | "cancelled"): void => {
		widget?.settleRoleRow("Verify", state);
		host.stopActiveProgressWidget();
	};

	const applySynthesizerFallback = (): void => {
		const synthesizer = config.synthesizer;
		if (!synthesizer) return;
		activeVerifier = synthesizer;
		activeVerifierThinking = config.thinkingOverrides[modelRefLabel(synthesizer)] ?? activeVerifierThinking;
		activeHandoff = {
			...activeHandoff,
			verifier: activeVerifier,
			verifierThinking: activeVerifierThinking,
			timestamp: Date.now(),
		};
		host.setImplementationHandoff(activeHandoff);
		const phaseModels = widget?.phaseModels();
		if (phaseModels) widget?.setPhaseModels({ ...phaseModels, Verify: activeVerifier });
	};

	const recoverFromVerifierFailure = async (outcome: VerifierRunOutcome): Promise<"retry" | "fallback" | "stop"> => {
		if (!ctx.hasUI) {
			const reason = outcome.cancelled ? "cancelled" : `failed: ${outcome.output || "unknown error"}`;
			ctx.ui.notify(`Verification ${reason}. Implementation left as-is.`, "warning");
			finish(outcome.cancelled ? "cancelled" : "error");
			return "stop";
		}

		if (outcome.cancelled) {
			const choice = await ctx.ui.select(
				"Verification was cancelled — what next?",
				["Retry verification", "Skip verification"],
			);
			if (choice === "Retry verification") return "retry";
			ctx.ui.notify("Verification skipped. Implementation left as-is.", "warning");
			finish("cancelled");
			return "stop";
		}

		const verifierLabel = modelRefLabel(activeVerifier);
		const fullReason = [
			outcome.output.trim(),
			outcome.stderr && outcome.stderr !== outcome.output ? `stderr:\n${outcome.stderr.trim()}` : "",
		].filter(Boolean).join("\n\n") || "unknown error";
		ctx.ui.notify(`Verification failed (${verifierLabel}):\n\n${fullReason}`, "error");
		const summary = formatVerifierFailure(outcome);
		const titleReason = summary.length > 200 ? `${summary.slice(0, 199)}…` : summary;
		const fallbackOption = config.synthesizer
			? `Retry with ${modelRefLabel(config.synthesizer)}`
			: undefined;
		const options = fallbackOption
			? [fallbackOption, "Retry verification", "Skip verification"]
			: ["Retry verification", "Skip verification"];
		const choice = await ctx.ui.select(
			`Verification could not complete (${verifierLabel}): ${titleReason}`,
			options,
		);
		if (fallbackOption && choice === fallbackOption) return "fallback";
		if (choice === "Retry verification") return "retry";
		ctx.ui.notify("Verification skipped. Implementation left as-is.", "warning");
		finish("cancelled");
		return "stop";
	};
	let verifierPreflightPassed = false;
	let verifierTask = "";
	let verificationReportPath: string | undefined;
	let parsed: VerificationVerdict | undefined;
	// Retain the accepted verifier report verbatim so the read-only findings
	// popup can show the original audit, not the compact decision summary.
	let verificationReport = "";
	while (true) {
		let outcome: VerifierRunOutcome;
		if (!verifierPreflightPassed) {
			const preflight = await runVerifierPreflight();
			if (preflight.cancelled || preflight.failed) {
				outcome = preflight;
			} else {
				verifierPreflightPassed = true;
				verifierTask = buildVerifierTask({ plan, implementerReport, diff, scriptResults, cwd: ctx.cwd, criteria });
				outcome = await runVerifierOnce(verifierTask);
			}
		} else {
			outcome = await runVerifierOnce(verifierTask);
		}

		if (!outcome.cancelled && host.getPlanRepoSlug()) {
			const verificationOutput = outcome.failed
				? [
					`## Verifier failed — ${formatVerifierFailure(outcome)}`,
					`Stop reason: ${outcome.stopReason ?? "unknown"}`,
					`Exit code: ${outcome.exitCode ?? "unknown"}`,
					"",
					outcome.output || "(No verifier output.)",
					outcome.stderr && outcome.stderr !== outcome.output
						? `\n### Stderr\n${outcome.stderr}`
						: "",
				].join("\n")
				: outcome.output;
			try {
				saveRepoPlanFile(verificationOutput, ctx.cwd, host.getPlanRepoSlug()!, "verification");
				verificationReportPath = `${CONFIG_DIR_NAME}/mf-plan/${host.getPlanRepoSlug()!}__verification.md`;
			} catch {
				// Persisting the report is best-effort; verification proceeds regardless.
			}
		}

		if (outcome.cancelled || outcome.failed) {
			const action = await recoverFromVerifierFailure(outcome);
			if (action === "retry") continue;
			if (action === "fallback") {
				applySynthesizerFallback();
				verifierPreflightPassed = false;
				verifierTask = "";
				continue;
			}
			return;
		}

		const candidate = parseVerificationVerdict(outcome.output);
		if (!candidate.verdict || (criteria.length > 0 && candidate.criteria.length === 0)) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Verifier produced no parseable verdict. Implementation left as-is.", "warning");
				finish("error");
				return;
			}
			const choice = await ctx.ui.select(
				"The verifier produced no parseable verdict — what next?",
				["Retry verification", "Skip verification"],
			);
			if (choice === "Retry verification") continue;
			ctx.ui.notify("Verification inconclusive — implementation left as-is.", "warning");
			finish("error");
			return;
		}

		if (criteria.length > 0) {
			const derived = deriveCriteriaVerdict(candidate, criteria);
			candidate.verdict = derived.verdict;
			candidate.gaps = derived.gaps;
		}
		parsed = candidate;
		verificationReport = outcome.output;
		break;
	}

	const failedScripts = scriptResults.filter((r) => r.status === "fail");
	if (verificationPassed(parsed.verdict, scriptResults)) {
		const checksNote = scriptResults.length > 0 ? " and all project checks passed" : "";
		ctx.ui.notify(criteria.length > 0
			? `Verification passed — all ${criteria.length} criteria met${checksNote}.`
			: `Verification passed — the implementation matches the approved plan${checksNote}.`);
		finish("done");
		return;
	}

	const repairsUsed = activeHandoff.verificationRepairs ?? 0;
	if (ctx.hasUI && repairsUsed < MAX_VERIFICATION_REPAIRS) {
		await runVerificationDecision({
			ctx,
			host,
			handoff: activeHandoff,
			parsed,
			scriptResults,
			failedScripts,
			plan,
			report: verificationReport,
			reportPath: verificationReportPath,
			repairsUsed,
			isTui: ctx.mode === "tui",
			widget,
			finish,
		});
		return;
	}

	const summary = buildVerificationSummary(parsed, scriptResults).join("\n");
	const report = formatVerificationReport(parsed, failedScripts);
	const exhaustedNote = repairsUsed >= MAX_VERIFICATION_REPAIRS ? "\n\nRepair rounds are exhausted." : "";
	ctx.ui.notify(`${summary}\n\n${report}${exhaustedNote}`, "warning");
	finish("done");
}
