import type { ContextEditEntryDraft } from "@earendil-works/pi-coding-agent";

import { PLAN_MODE_CONTEXT_TYPE, VERIFICATION_PENDING_CONTEXT_TYPE } from "./tools/shared.ts";

/** Structural entry shape containing only fields read while scanning a branch. */
export interface ScannedEntry {
	id?: string;
	type: string;
	customType?: string;
	message?: { role?: string; content?: unknown };
	targetId?: string;
	replacement?: unknown;
}

export function isPlanModeInstructionText(content: unknown): boolean {
	const isInstruction = (text: string): boolean =>
		text.startsWith("[PLAN MODE ACTIVE]") || text.startsWith("[PLAN MODE RE-ENTRY]");
	if (typeof content === "string") return isInstruction(content);
	if (!Array.isArray(content)) return false;
	return content.some((part) =>
		part !== null
		&& typeof part === "object"
		&& "type" in part
		&& part.type === "text"
		&& "text" in part
		&& typeof part.text === "string"
		&& isInstruction(part.text));
}

export function isPlanInstructionEntry(entry: ScannedEntry): boolean {
	if (entry.type === "custom_message") return entry.customType === PLAN_MODE_CONTEXT_TYPE;
	if (entry.type !== "message" || entry.message?.role !== "user") return false;
	// The one-shot mf-plan-exit reminder remains governed by the per-request
	// context filter; only reusable plan-mode instructions are omitted durably.
	return isPlanModeInstructionText(entry.message.content);
}

export function isVerificationPendingEntry(entry: ScannedEntry): boolean {
	return entry.type === "custom_message" && entry.customType === VERIFICATION_PENDING_CONTEXT_TYPE;
}

export function collectOmissionDrafts(
	entries: readonly ScannedEntry[],
	predicate: (entry: ScannedEntry) => boolean,
	alreadyOmitted: ReadonlySet<string>,
): ContextEditEntryDraft[] {
	const omitted = new Set(alreadyOmitted);
	for (const entry of entries) {
		if (entry.type === "context_edit" && entry.replacement === null && typeof entry.targetId === "string") {
			omitted.add(entry.targetId);
		}
	}
	return entries.flatMap((entry): ContextEditEntryDraft[] => {
		if (typeof entry.id !== "string" || omitted.has(entry.id) || !predicate(entry)) return [];
		return [{ type: "context_edit", targetId: entry.id, replacement: null }];
	});
}

export function buildVerificationPendingMessage(planFilePath: string | undefined): string {
	const target = planFilePath ? ` for ${planFilePath}` : "";
	return `The implementation turn for the approved plan${target} has finished. Independent read-only verification is pending and runs out of band. Treat the implementation as unverified until the verifier reports.`;
}
