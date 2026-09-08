export interface ModelRef {
	provider: string;
	id: string;
}

export type SendUserMessageOptions = { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean };
export const TRIGGER_TURN: SendUserMessageOptions = { triggerTurn: true };
export const FOLLOW_UP: SendUserMessageOptions = { deliverAs: "followUp" };

/**
 * pi's thinking-level vocabulary, in pi's canonical order (see
 * `pi.getThinkingLevel()` / `--thinking <level>`). `xhigh` and `max` are
 * distinct levels a model may expose independently, so neither is folded
 * into the other.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isModelRef(value: unknown): value is ModelRef {
	return !!value
		&& typeof value === "object"
		&& typeof (value as ModelRef).provider === "string"
		&& typeof (value as ModelRef).id === "string";
}

export function modelRefLabel(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/**
 * Anonymous slot label substituted for the real `modelRefLabel(ref)` in the
 * synthesizer's input ONLY. Blinding prevents the synthesizer from favoring a
 * proposal because of which model family/provider wrote it (self-preference
 * bias), so proposals are judged purely on merit.
 *
 * The synthesizer's plan body refers to proposers as `Proposer 1`, `Proposer 2`,
 * … which the user maps by index to the picker's `Proposer N` slot labels and
 * the plan-review overlay's `P1`/`P2`/`P3` title-bar row (both render the real
 * `ModelRef` from `MfPlanInfo`). If the picker's slot labeling ever changes,
 * keep this in sync so the body↔overlay mapping stays correct by construction.
 */
export function proposerBlindedLabel(slotIndex: number): string {
	return `Proposer ${slotIndex + 1}`;
}

const MODEL_ATTR_SEGMENTS = new Set([
	"pro", "plus", "max", "ultra", "mini", "flash", "turbo", "coder", "instruct",
	"preview", "lite", "base", "sonnet", "opus", "haiku", "thinking", "reasoning",
]);
const CLAUDE_FAMILY_SEGMENTS = new Set(["sonnet", "opus", "haiku"]);

function isVersionOrAttrSegment(segment: string): boolean {
	const seg = segment.toLowerCase();
	if (MODEL_ATTR_SEGMENTS.has(seg)) return true;
	if (/^v\d/.test(seg)) return true;
	if (/^k\d/.test(seg)) return true;
	if (/^[a-z]\d+(\.\d+)*$/i.test(seg)) return true;
	if (/^\d+(\.\d+)*$/.test(seg)) return true;
	return false;
}

function modelIdBase(ref: ModelRef): string {
	const slashIdx = ref.id.lastIndexOf("/");
	return slashIdx >= 0 ? ref.id.slice(slashIdx + 1) : ref.id;
}

/** Short display name for MoA overlay (e.g. "claude-opus-4-6" → "opus", "deepseek-v4-pro" → "deepseek"). */
export function shortModelName(ref: ModelRef): string {
	const base = modelIdBase(ref);
	const segments = base.split("-").filter(Boolean);
	// Claude's family is its useful compact identifier; "claude" only names
	// the product and does not distinguish Opus, Sonnet, and Haiku.
	if (segments[0]?.toLowerCase() === "claude") {
		const family = segments.find((segment) => CLAUDE_FAMILY_SEGMENTS.has(segment.toLowerCase()));
		if (family) return family.toLowerCase();
	}
	const kept = segments.filter((s) => !isVersionOrAttrSegment(s));
	let name = kept.length > 0 ? kept.join("-") : base;
	name = name.replace(/\d+(\.\d+)*$/, "");
	return name.toLowerCase() || base;
}
