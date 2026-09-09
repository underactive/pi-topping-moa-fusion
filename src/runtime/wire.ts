import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type WireAssistantMessageEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

/** Bound content-indexed stream assembly so malformed children cannot allocate sparse arrays. */
export const MAX_STREAM_CONTENT_PARTS = 1024;

/**
 * The wire union carries pi's custom message kinds — interactive `!cmd` bash,
 * compaction and branch summaries — alongside plain LLM messages. None can
 * occur in a non-interactive subagent, and nothing that consumes a subagent
 * transcript knows how to render them.
 */
export function isLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

const USAGE_BEACON_PREFIX = "pi-usage-beacon/1 ";
const USAGE_BEACON_FAMILY_PREFIX = "pi-usage-beacon/";
const MAX_STDERR_BUFFER_CHARS = 65_536;

export function isValidContextTokens(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Parse a v1 beacon line; all malformed payloads are ordinary stderr diagnostics. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isNonnegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isValidContentIndex(value: unknown): value is number {
	return typeof value === "number"
		&& Number.isInteger(value)
		&& value >= 0
		&& value < MAX_STREAM_CONTENT_PARTS;
}

function isTextContent(value: unknown): boolean {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): boolean {
	return isRecord(value)
		&& value.type === "image"
		&& typeof value.data === "string"
		&& typeof value.mimeType === "string";
}

function isThinkingContent(value: unknown): boolean {
	return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCall(value: unknown): boolean {
	return isRecord(value)
		&& value.type === "toolCall"
		&& typeof value.id === "string"
		&& typeof value.name === "string"
		&& isRecord(value.arguments);
}

function isWireMessage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.role !== "string") return false;
	if (value.usage !== undefined && !isRecord(value.usage)) return false;
	if (value.role === "user") {
		return typeof value.content === "string"
			|| (Array.isArray(value.content) && value.content.every((part) => isTextContent(part) || isImageContent(part)));
	}
	if (value.role === "assistant") {
		return Array.isArray(value.content)
			&& value.content.every((part) => isTextContent(part) || isThinkingContent(part) || isToolCall(part));
	}
	if (value.role === "toolResult") {
		return Array.isArray(value.content)
			&& value.content.every((part) => isTextContent(part) || isImageContent(part))
			&& typeof value.toolCallId === "string"
			&& typeof value.toolName === "string"
			&& typeof value.isError === "boolean";
	}
	return false;
}

/** Parse and minimally validate one child JSON-protocol event. */
export function parseSessionEvent(line: string): JsonAgentSessionEvent | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined;
		if (parsed.type === "message_start" || parsed.type === "message_end") {
			return isWireMessage(parsed.message) ? parsed as unknown as JsonAgentSessionEvent : undefined;
		}
		if (parsed.type === "message_update") {
			const assistantEvent = parsed.assistantMessageEvent;
			if (assistantEvent === undefined || assistantEvent === null) return parsed as unknown as JsonAgentSessionEvent;
			if (!isRecord(assistantEvent) || typeof assistantEvent.type !== "string") return undefined;
			if ("contentIndex" in assistantEvent && !isValidContentIndex(assistantEvent.contentIndex)) return undefined;
			if (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") {
				if (typeof assistantEvent.delta !== "string" || !isValidContentIndex(assistantEvent.contentIndex)) return undefined;
			}
			if (assistantEvent.type === "toolcall_end") {
				if (!isValidContentIndex(assistantEvent.contentIndex) || !isToolCall(assistantEvent.toolCall)) return undefined;
			}
			return parsed as unknown as JsonAgentSessionEvent;
		}
		if (parsed.type === "tool_execution_start" && typeof parsed.toolName !== "string") return undefined;
		return parsed as unknown as JsonAgentSessionEvent;
	} catch {
		return undefined;
	}
}

export function parseUsageBeacon(line: string): number | undefined {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (!normalized.startsWith(USAGE_BEACON_PREFIX)) return undefined;
	try {
		const payload: unknown = JSON.parse(normalized.slice(USAGE_BEACON_PREFIX.length));
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		const record = payload as Record<string, unknown>;
		return isValidContextTokens(record.totalTokens) ? record.totalTokens : undefined;
	} catch {
		return undefined;
	}
}

// Silently drop unsupported versions so a newer producer cannot flood failure diagnostics.
function isUnknownUsageBeacon(line: string): boolean {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	return normalized.startsWith(USAGE_BEACON_FAMILY_PREFIX) && !normalized.startsWith(USAGE_BEACON_PREFIX);
}

/** Splits stderr without letting recognized machine beacons grow diagnostic output. */
export class StderrBeaconReader {
	#buffer = "";

	push(chunk: string, flush = false): { beacons: number[]; diagnostics: string } {
		this.#buffer += chunk;
		const lines = this.#buffer.split("\n");
		this.#buffer = (lines.pop() || "").slice(-MAX_STDERR_BUFFER_CHARS);
		if (flush && this.#buffer) {
			lines.push(this.#buffer);
			this.#buffer = "";
		}

		const beacons: number[] = [];
		let diagnostics = "";
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const beacon = parseUsageBeacon(line);
			if (beacon !== undefined) {
				beacons.push(beacon);
			} else if (!isUnknownUsageBeacon(line)) {
				const isFinalTail = flush && index === lines.length - 1 && !chunk.endsWith("\n");
				diagnostics += line + (isFinalTail ? "" : "\n");
			}
		}
		return { beacons, diagnostics };
	}
}

export function reconcileContextTokens(
	current: number | undefined,
	authoritative: boolean,
	totalTokens: number,
	source: "beacon" | "message_end",
): { contextTokens: number; authoritative: boolean; changed: boolean } {
	if (source === "beacon") {
		if (authoritative || (current !== undefined && totalTokens < current)) {
			return { contextTokens: current ?? totalTokens, authoritative, changed: false };
		}
		return { contextTokens: totalTokens, authoritative: false, changed: current !== totalTokens };
	}
	return { contextTokens: totalTokens, authoritative: true, changed: current !== totalTokens };
}
