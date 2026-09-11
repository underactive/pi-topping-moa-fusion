import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The only model-facing question tool mf-plan defers to. Whatever extension
 * registers this name is the questionnaire; mf-plan never vendors or registers
 * a competing one. Name-only detection is deliberate: attributing the
 * registration to a specific package would silently disable the tool if that
 * package ever ships under a different path or is vendored.
 */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/**
 * The rpiv questionnaire emits `{ active: boolean }` on this channel around
 * every wait, cleared in a `finally`. The channel name here duplicates the
 * rpiv source rather than importing the package — it may be absent from the
 * session. Channel names are immutable and payloads are append-only by that
 * extension's policy, so a rename is a new channel and added fields are inert
 * (the handler validates the payload and ignores anything else).
 *
 * Referenced source: `@juicesharp/rpiv-ask-user-question/events.ts` (channel
 * names + `{ active: boolean }`) and `ask-user-question.ts` (emit sites).
 */
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

/** Returned by `exit_plan_mode` while a questionnaire is still awaiting answers. */
export const ASK_USER_QUESTION_PENDING_MESSAGE =
	"An ask_user_question questionnaire is still waiting for the user. Wait for its result, incorporate the answers, then call exit_plan_mode by itself in a later message.";

/** True when any registered tool answers to the questionnaire name. */
export function isAskUserQuestionInstalled(pi: ExtensionAPI): boolean {
	return pi.getAllTools().some((tool) => tool.name === ASK_USER_QUESTION_TOOL_NAME);
}

export interface AskUserQuestionTracker {
	/** True while a questionnaire is waiting for the user (rpiv `active: true`). */
	isActive(): boolean;
	/** Clear the blocked flag (e.g. on session start, so a dead process cannot leave it stuck). */
	reset(): void;
	/**
	 * (Re)subscribe to the blocked event. Called on session start and on each
	 * plan-mode entry; the unsubscribe handle is retained so re-subscribing
	 * never stacks handlers.
	 */
	ensureSubscribed(): void;
}

/**
 * Tracks whether the questionnaire is actively blocking the user. The raw
 * `active` payload is validated (`typeof === "boolean"`) so unknown shapes are
 * ignored; the flag then only ever moves when rpiv reports a precise state.
 *
 * Owned by the plan-mode controller (module-singleton discipline is avoided so
 * the fake-`pi` tests stay self-contained and no state leaks across sessions).
 */
export function createAskUserQuestionTracker(pi: ExtensionAPI, onChange?: () => void): AskUserQuestionTracker {
	let active = false;
	let unsubscribe: (() => void) | undefined;

	const handleBlocked = (data: unknown): void => {
		const payload = data as { active?: unknown } | null;
		if (typeof payload?.active !== "boolean" || payload.active === active) return;
		active = payload.active;
		onChange?.();
	};

	const ensureSubscribed = (): void => {
		if (unsubscribe) return;
		// `events` is typed non-optional on ExtensionAPI, but is optional at
		// runtime in the fake-`pi` tests and the headless fixtures. Keep the
		// optional chain so a missing bus degrades to "never blocked".
		unsubscribe = pi.events?.on?.(ASK_USER_BLOCKED_EVENT, handleBlocked);
	};

	return {
		isActive: () => active,
		reset: () => {
			if (!active) return;
			active = false;
			onChange?.();
		},
		ensureSubscribed,
	};
}
