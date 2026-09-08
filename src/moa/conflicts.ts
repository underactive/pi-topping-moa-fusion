import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const CHAT_VALUE = "__chat__";

export interface ConflictOption {
	value: string;
	/** Short, plain-language outcome shown on the primary selectable line. */
	label: string;
	/** Technical implementation details and tradeoffs shown dimmed below the label. */
	description: string;
	proposerLabel?: string;
	recommended: boolean;
}

export interface Conflict {
	id: string;
	label: string;
	prompt: string;
	/** Already ordered: [recommended, ...alternatives, chat option]. */
	options: ConflictOption[];
}

export interface ConflictAnswer {
	optionValue: string;
	kind: "recommended" | "alternative" | "chat";
	chatText?: string;
}

export function chatOption(): ConflictOption {
	return {
		value: CHAT_VALUE,
		label: "Chat about this",
		description: "Ask a question or explain what you'd prefer instead.",
		recommended: false,
	};
}

const CONFLICTS_SECTION_RE = /^##\s*Conflicts\s*$/m;
const CONFLICT_HEADER_RE = /^###\s*Conflict:\s*(.+)$/gm;
const DECISION_RE = /^-\s*\*\*Decision:\*\*\s*(.+)$/;
// Legacy em-dash reasons require whitespace around the separator so hyphenated
// summaries such as “sign-in” remain intact.
const RECOMMENDED_RE = /^-\s*\*\*Recommended:\*\*\s*(.+?)(?:\s+[—-]\s+(.+))?$/;
const ALTERNATIVE_RE = /^-\s*\*\*Alternative\*\*\s*\((Proposer \d+)\):\s*(.+?)(?:\s+[—-]\s+(.+))?$/;
const DETAILS_RE = /^-\s*\*\*Details:\*\*\s*(.*)$/;

function slugify(label: string): string {
	return (
		label
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "option"
	);
}

/**
 * Extracts a `## Conflicts` section (if present) from synthesizer output,
 * parsing it into structured `Conflict` records and returning the plan body
 * with that section stripped out (so it never lands in the written plan
 * file or the approval overlay). Malformed markup degrades gracefully to
 * `{ conflicts: [], remainingPlan: output }`.
 */
export function parseConflicts(output: string): { conflicts: Conflict[]; remainingPlan: string } {
	const startMatch = CONFLICTS_SECTION_RE.exec(output);
	if (!startMatch) return { conflicts: [], remainingPlan: output };

	const sectionStart = startMatch.index;
	const afterHeader = sectionStart + startMatch[0].length;
	let sectionEnd = output.length;
	const rest = output.slice(afterHeader);
	const nextMatch = /^##\s+/m.exec(rest);
	if (nextMatch) sectionEnd = afterHeader + nextMatch.index;

	const block = output.slice(afterHeader, sectionEnd);
	const remainingPlan = (output.slice(0, sectionStart) + output.slice(sectionEnd)).replace(/\n{3,}/g, "\n\n").trim();

	const headerMatches = [...block.matchAll(CONFLICT_HEADER_RE)];
	const conflicts: Conflict[] = [];

	for (let i = 0; i < headerMatches.length; i++) {
		const match = headerMatches[i];
		const label = stripTerminalSequences(match[1].trim());
		const start = match.index! + match[0].length;
		const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index! : block.length;
		const body = block.slice(start, end);
		const bodyLines = body.split("\n").map((l) => l.trim()).filter(Boolean);

		const options: ConflictOption[] = [];
		let decision: string | undefined;
		let precedingOption: ConflictOption | undefined;
		for (const line of bodyLines) {
			const decisionMatch = DECISION_RE.exec(line);
			if (decisionMatch) {
				decision = stripTerminalSequences(decisionMatch[1].trim());
				precedingOption = undefined;
				continue;
			}
			const detailsMatch = DETAILS_RE.exec(line);
			if (detailsMatch) {
				// The protocol puts Details immediately after its option. Explicit details
				// replace an em-dash reason, which remains only for legacy output.
				if (precedingOption) precedingOption.description = stripTerminalSequences(detailsMatch[1].trim());
				precedingOption = undefined;
				continue;
			}
			const recMatch = RECOMMENDED_RE.exec(line);
			if (recMatch) {
				const summary = stripTerminalSequences(recMatch[1].trim());
				const legacyReason = stripTerminalSequences(recMatch[2]?.trim() ?? "");
				const option: ConflictOption = {
					value: `${slugify(summary)}-${options.length}`,
					label: `${summary} (Recommended)`,
					description: legacyReason,
					recommended: true,
				};
				options.push(option);
				precedingOption = option;
				continue;
			}
			const altMatch = ALTERNATIVE_RE.exec(line);
			if (altMatch) {
				const proposerLabel = altMatch[1].trim();
				const summary = stripTerminalSequences(altMatch[2].trim());
				const legacyReason = stripTerminalSequences(altMatch[3]?.trim() ?? "");
				const option: ConflictOption = {
					value: `${slugify(`${proposerLabel}-${summary}`)}-${options.length}`,
					label: summary,
					description: legacyReason,
					proposerLabel,
					recommended: false,
				};
				options.push(option);
				precedingOption = option;
				continue;
			}
			precedingOption = undefined;
		}

		if (options.length === 0) continue;
		// Ensure the recommended option (if any) leads.
		options.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));

		conflicts.push({
			id: `conflict-${i}-${slugify(label)}`,
			label,
			prompt: decision ?? `Choose how to handle “${label}”.`,
			options: [...options, chatOption()],
		});
	}

	return { conflicts, remainingPlan };
}
