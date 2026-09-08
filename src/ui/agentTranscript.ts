import type { Message } from "@earendil-works/pi-ai";
import { wrapWords } from "./chrome.ts";

export const CONTENT_SEPARATOR = "\n\n---\n\n";

const MAX_TOOL_RESULT_CHARS = 2_000;
const MAX_PREVIEW_MESSAGES = 6;
const MAX_PREVIEW_CHARS = 4_000;

/** Keep the end of text (most recent output) when over budget. */
export function truncateFromStart(text: string, max: number): string {
	return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

/** Keep the start of text when over budget (e.g. short tool args). */
function truncateFromEnd(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Drop oldest message blocks first, then tail-truncate if one block alone exceeds budget. */
export function formatContentWithSlidingWindow(parts: string[], maxChars: number): string {
	if (parts.length === 0) return "";

	const suffixLengths = new Array<number>(parts.length);
	for (let index = parts.length - 1; index >= 0; index--) {
		suffixLengths[index] = parts[index].length
			+ (index < parts.length - 1 ? CONTENT_SEPARATOR.length + suffixLengths[index + 1] : 0);
	}

	let start = 0;
	while (start < parts.length - 1) {
		const prefixLength = start > 0 ? 1 + CONTENT_SEPARATOR.length : 0;
		if (prefixLength + suffixLengths[start] <= maxChars) break;
		start++;
	}
	let body = parts.slice(start).join(CONTENT_SEPARATOR);
	if (start > 0) body = `…${CONTENT_SEPARATOR}${body}`;
	return body.length <= maxChars ? body : truncateFromStart(body, maxChars);
}

function formatToolArgs(args: unknown): string {
	if (args === undefined) return "";
	try {
		return truncateFromEnd(JSON.stringify(args), 300);
	} catch {
		return "";
	}
}

export function formatMessage(message: Message): string {
	if (message.role === "assistant") {
		const parts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text" && part.text) parts.push(part.text);
			else if (part.type === "thinking" && part.thinking) parts.push(`#### Thinking\n\n_${part.thinking}_`);
			else if (part.type === "toolCall") {
				const args = formatToolArgs(part.arguments);
				parts.push(`> 🔧 **${part.name}**${args ? ` ${args}` : ""}`);
			}
		}
		return parts.join("\n\n");
	}
	if (message.role === "toolResult") {
		const result = typeof message.content === "string"
			? message.content
			: message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		return `#### 📋 ${message.toolName}\n\n\`\`\`\n${truncateFromStart(result, MAX_TOOL_RESULT_CHARS)}\n\`\`\``;
	}
	return "";
}

export function transcriptBody(
	messages: Message[],
	partial: Message | undefined,
	state: "working" | "done" | "error" | "cancelled",
	maxChars: number,
): string {
	const contentParts = messages.map(formatMessage).filter(Boolean);
	if (partial) {
		const formattedPartial = formatMessage(partial);
		if (formattedPartial) contentParts.push(`${formattedPartial}\n\n_(generating…)_`);
	}
	if (contentParts.length === 0) {
		return state === "error" ? "_(agent failed — no output)_" : "_(waiting for first response…)_";
	}
	return formatContentWithSlidingWindow(contentParts, maxChars);
}

function stripTerminalControls(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|$)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function formatAgentPreview(
	messages: Message[],
	partial: Message | undefined,
	width: number,
	maxLines: number,
): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const recentMessages = messages.slice(-MAX_PREVIEW_MESSAGES);
	const body = stripTerminalControls(transcriptBody(recentMessages, partial, "working", MAX_PREVIEW_CHARS));
	const generatingMarker = "_(generating…)_";
	const generating = body.endsWith(generatingMarker);
	const content = generating ? body.slice(0, -generatingMarker.length).trimEnd() : body;
	const wrapped = wrapWords(content, width);
	if (generating) wrapped.push("(generating…)");
	const visible = wrapped.slice(-maxLines);
	return [...Array<string>(Math.max(0, maxLines - visible.length)).fill(""), ...visible];
}
