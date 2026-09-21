import type { Message } from "@earendil-works/pi-ai";
import type { OutputActivity } from "./activityTracking.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	cost: number;
	contextTokens?: number;
	turns: number;
	toolCalls: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/**
	 * Live one-line description of the agent's most recent tool call (e.g.
	 * `grep  "handleRequest"`). Transient — updated as the subprocess streams
	 * `tool_execution_start` events, for progress UIs. Not part of the final
	 * agent output.
	 */
	activity?: string;
	/**
	 * In-progress assistant message from the most recent `message_update`.
	 * Transient — the completed message is moved into `messages` on `message_end`.
	 */
	partialAssistant?: Message;
	/**
	 * Live generated-output reading driving the fan-out activity monitor.
	 * Distinct from `usage.output`, which only advances at turn boundaries and
	 * stays at 0 for providers that never report usage.
	 */
	outputActivity?: OutputActivity;
	/**
	 * True when this agent was aborted (per-agent/user cancellation) and the
	 * caller opted into `resolveOnAbort`. Cancelled results still count as
	 * failed (`stopReason: "aborted"`), but callers can distinguish "user
	 * killed it" from "it broke".
	 */
	cancelled?: boolean;
	/** Signal reported by the child close event, when it did not exit normally. */
	signalCode?: NodeJS.Signals | null;
}


/**
 * The text content of the last assistant message that actually said something:
 * all its non-empty text parts joined with a blank line, falling back to
 * earlier assistant messages when the last one only carried empty text or tool
 * calls. Bridged providers can end a run with an empty trailing text block, so
 * the last assistant message is not always the one holding the answer.
 */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = msg.content
				.filter((part) => part.type === "text")
				.map((part) => (part as { text: string }).text)
				.filter((text) => text.length > 0)
				.join("\n\n");
			if (text.length > 0) return text;
		}
	}
	return "";
}

export function isFailedResult(result: { exitCode: number; stopReason?: string; messages: Message[] }): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.messages.length === 0
	);
}

export function getResultOutput(result: { exitCode: number; stopReason?: string; errorMessage?: string; stderr?: string; messages: Message[] }): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "No agent messages were emitted.";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * Longest failure message kept for a status row. Generous enough that a
 * provider's JSON error payload survives whole for a progress table to wrap
 * across several lines, bounded so a multi-KB stderr dump cannot crowd out the
 * table it renders in.
 */
const MAX_STATUS_DETAIL_CHARS = 500;

/**
 * Collapse an agent failure into one bounded line for a progress row. Runs of
 * whitespace — newlines included — are flattened because the row is laid out as
 * a single line before its surface wraps it to the available width.
 */
export function statusDetail(output: string): string {
	const collapsed = output.replace(/\s+/g, " ").trim();
	return collapsed.length <= MAX_STATUS_DETAIL_CHARS ? collapsed : `${collapsed.slice(0, MAX_STATUS_DETAIL_CHARS - 1)}…`;
}

export function truncateOutput(output: string): string {
	const maxBytes = 50 * 1024;
	const bytes = Buffer.from(output, "utf8");
	if (bytes.length <= maxBytes) return output;

	let cut = maxBytes;
	while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
	return `${bytes.subarray(0, cut).toString("utf8")}\n\n[Output truncated]`;
}
