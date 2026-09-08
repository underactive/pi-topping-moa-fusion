import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { StreamingWordCounter } from "../activityMeter.ts";
import { isNonnegativeFiniteNumber, isValidContentIndex, type WireAssistantMessageEvent } from "./wire.ts";

/** Max length of a one-line tool-activity description surfaced for progress UIs. */
const ACTIVITY_MAX = 80;

/** Collapse all whitespace/newlines to single spaces and trim. */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Pick the most informative string argument for a one-line activity label.
 * Prefers well-known tool arg names (command, pattern, path, …); falls back to
 * the first non-empty string value.
 */
function summarizeToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const preferred = ["command", "pattern", "query", "path", "file", "glob", "dir", "url", "name"];
	for (const key of preferred) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return collapseWhitespace(value);
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return collapseWhitespace(value);
	}
	return "";
}

/** Format a `tool_execution_start` event into a single-line "toolName  arg" label. */
export function formatToolActivity(toolName: string, args: unknown): string {
	const detail = summarizeToolArgs(args);
	const label = detail ? `${toolName}  ${detail}` : String(toolName);
	return stripTerminalSequences(collapseWhitespace(label).slice(0, ACTIVITY_MAX));
}

/** Cumulative generated-output reading for the fan-out activity monitor. */
export interface OutputActivity {
	/** Tokens generated so far this run: confirmed turns plus the in-flight turn. */
	tokens: number;
	/**
	 * Bumped whenever exact provider usage replaces a differing estimate.
	 * Consumers reset their rate tracker on a change so the correction doesn't
	 * register as a burst of generation that never happened.
	 */
	revision: number;
}

export class OutputActivityTracker {
	#counter = new StreamingWordCounter();
	#confirmed = 0;
	#liveWords = 0;
	#revision = 0;

	/** Begin a new assistant turn, discarding only the previous turn's live estimate. */
	messageStart(message: { role?: string } | undefined): void {
		if (message?.role !== "assistant") return;
		this.#resetTurn();
	}

	messageUpdate(assistantEvent: { type?: string; delta?: string } | undefined): void {
		if (assistantEvent?.type !== "text_delta" && assistantEvent?.type !== "thinking_delta") return;
		if (typeof assistantEvent.delta !== "string") return;
		// Counted per stream kind so a word split across deltas isn't double
		// counted, and interleaved thinking/text streams don't corrupt each other.
		this.#liveWords += this.#counter.count(assistantEvent.delta, assistantEvent.type);
	}

	messageEnd(message: { role?: string; usage?: { output?: unknown } } | undefined): void {
		if (message?.role !== "assistant") return;
		const exact = message.usage?.output;
		if (isNonnegativeFiniteNumber(exact)) {
			this.#confirmed += exact;
			if (exact !== this.#liveWords) this.#revision++;
		} else {
			this.#confirmed += this.#liveWords;
		}
		this.#resetTurn();
	}

	snapshot(): OutputActivity {
		return { tokens: this.#confirmed + this.#liveWords, revision: this.#revision };
	}

	#resetTurn(): void {
		this.#liveWords = 0;
		this.#counter.reset();
	}
}

type AssistantContentPart = AssistantMessage["content"][number];

/**
 * Rebuilds the in-flight assistant message from streamed deltas.
 *
 * `message_update` carries only `contentIndex`-addressed deltas, so a live view
 * of what an agent is writing has to be reassembled client-side. Tool calls
 * materialise only at `toolcall_end`, once their arguments have finished
 * streaming and are parseable.
 */
export class PartialAssistantAssembler {
	#template: AssistantMessage | undefined;
	#parts: (AssistantContentPart | undefined)[] = [];

	start(message: AgentMessage | undefined): void {
		this.#template = message?.role === "assistant" ? message : undefined;
		this.#parts = [];
	}

	apply(assistantEvent: WireAssistantMessageEvent | undefined): void {
		if (!assistantEvent) return;
		if (("contentIndex" in assistantEvent && !isValidContentIndex(assistantEvent.contentIndex))) return;
		if (assistantEvent.type === "text_delta") {
			const part = this.#parts[assistantEvent.contentIndex];
			if (part?.type === "text") part.text += assistantEvent.delta;
			else this.#parts[assistantEvent.contentIndex] = { type: "text", text: assistantEvent.delta };
		} else if (assistantEvent.type === "thinking_delta") {
			const part = this.#parts[assistantEvent.contentIndex];
			if (part?.type === "thinking") part.thinking += assistantEvent.delta;
			else this.#parts[assistantEvent.contentIndex] = { type: "thinking", thinking: assistantEvent.delta };
		} else if (assistantEvent.type === "toolcall_end") {
			this.#parts[assistantEvent.contentIndex] = assistantEvent.toolCall;
		}
	}

	/** The message as it currently stands, or undefined before any content arrives. */
	snapshot(): Message | undefined {
		if (!this.#template) return undefined;
		const content = this.#parts.filter((part) => part !== undefined);
		return content.length > 0 ? { ...this.#template, content } : undefined;
	}

	clear(): void {
		this.#template = undefined;
		this.#parts = [];
	}
}
