import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { MfPlanInfo } from "../moa/planInfo.ts";
import type { ImplementationHandoff } from "../moa/implementationRetry.ts";

export interface PlanModeState {
	enabled: boolean;
	slug: string;
	repoPlanSlug?: string;
	needsExitReminder?: boolean;
	moaInfo?: MfPlanInfo;
	implementationHandoff?: ImplementationHandoff;
}

export const MAX_PERSISTED_STATE_BYTES = 512 * 1024;

export function serializePlanModeState(state: PlanModeState): { state: PlanModeState; serialized: string } {
	let persisted = state.moaInfo?.proposerPlans
		? { ...state, moaInfo: { ...state.moaInfo, proposerPlans: undefined } }
		: state;
	let serialized = JSON.stringify(persisted);
	if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_STATE_BYTES && persisted.moaInfo) {
		persisted = { ...persisted, moaInfo: undefined };
		serialized = JSON.stringify(persisted);
	}
	if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_STATE_BYTES && persisted.implementationHandoff?.plan) {
		persisted = {
			...persisted,
			implementationHandoff: { ...persisted.implementationHandoff, plan: "" },
		};
		serialized = JSON.stringify(persisted);
	}
	return { state: persisted, serialized };
}

export class PlanModeStatePersistence {
	private lastPersistedState: string | undefined;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	persist(state: PlanModeState): void {
		const persisted = serializePlanModeState(state);
		if (persisted.serialized === this.lastPersistedState) return;
		this.lastPersistedState = persisted.serialized;
		this.pi.appendEntry("mf-plan", persisted.state);
	}

	reset(): void {
		this.lastPersistedState = undefined;
	}
}

export function latestPlanModeStateEntry(entries: readonly { type: string; customType?: string; data?: unknown }[]): PlanModeState | undefined {
	const entry = entries
		.filter((candidate) => candidate.type === "custom" && candidate.customType === "mf-plan")
		.pop();
	return entry?.data && typeof entry.data === "object" ? entry.data as PlanModeState : undefined;
}
