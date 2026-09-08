import { isModelRef, type ModelRef } from "../shared/modelRefs.ts";

export type PlanReviewDecision = "approve" | "keep" | "edit" | "chat";

export interface MoaProposerPlan {
	/** Zero-based proposer slot, retained when another proposer fails. */
	proposerIndex: number;
	model: ModelRef;
	markdown: string;
}

export interface MfPlanInfo {
	proposers: ModelRef[];
	synthesizer: ModelRef;
	proposerPlans?: MoaProposerPlan[];
	/** The synthesizer's `## Proposer Verdicts` section — its proof of judging every proposal. */
	verdictsMarkdown?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validate MoA review metadata restored from untrusted session entries. */
export function validateMfPlanInfo(value: unknown): MfPlanInfo | undefined {
	if (!isRecord(value) || !Array.isArray(value.proposers) || !value.proposers.every(isModelRef) || !isModelRef(value.synthesizer)) {
		return undefined;
	}
	if (value.verdictsMarkdown !== undefined && typeof value.verdictsMarkdown !== "string") return undefined;
	const proposers = value.proposers as ModelRef[];
	let proposerPlans: MoaProposerPlan[] | undefined;
	if (value.proposerPlans !== undefined) {
		if (!Array.isArray(value.proposerPlans)) return undefined;
		const seenIndices = new Set<number>();
		if (!value.proposerPlans.every((proposal) => {
			if (!isRecord(proposal)
				|| typeof proposal.proposerIndex !== "number"
				|| !Number.isInteger(proposal.proposerIndex)
				|| proposal.proposerIndex < 0
				|| proposal.proposerIndex >= proposers.length
				|| seenIndices.has(proposal.proposerIndex)
				|| !isModelRef(proposal.model)
				|| typeof proposal.markdown !== "string") return false;
			const expectedModel = proposers[proposal.proposerIndex];
			if (proposal.model.provider !== expectedModel.provider || proposal.model.id !== expectedModel.id) return false;
			seenIndices.add(proposal.proposerIndex);
			return true;
		})) return undefined;
		proposerPlans = value.proposerPlans as unknown as MoaProposerPlan[];
	}
	return {
		proposers,
		synthesizer: value.synthesizer,
		...(proposerPlans ? { proposerPlans } : {}),
		...(typeof value.verdictsMarkdown === "string" ? { verdictsMarkdown: value.verdictsMarkdown } : {}),
	};
}
