import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProposalFileSet } from "../planning/planFile.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import type { SingleResult } from "../runtime/results.ts";
import type { ThinkingLevel, ModelRef } from "../shared/modelRefs.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import type { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { MfPlanInfo } from "./planInfo.ts";

import type { ImplementationHandoff } from "./implementationRetry.ts";
import type { VerificationCriterion } from "./verificationCriteria.ts";

export interface MoaRunHost {
	pi: ExtensionAPI;
	getPlanRepoSlug(): string | undefined;
	getActiveObserveSession(): ObserveSession | undefined;
	setActiveObserveSession(session: ObserveSession | undefined): void;
	getActiveRunMoaInfo(): MfPlanInfo | undefined;
	setActiveRunMoaInfo(info: MfPlanInfo | undefined): void;
	persistState(): void;
	currentThinkingLevel(): ThinkingLevel;
	applyImplementingSelection(
		ctx: ExtensionContext,
		selection: { ref: ModelRef; thinking: ThinkingLevel },
		successNotice: string,
	): Promise<void>;
	exitPlanMode(ctx: ExtensionContext): void;
	saveApprovedPlanToRepo(ctx: ExtensionContext, plan: string): void;
	getImplementationHandoff(): ImplementationHandoff | undefined;
	setImplementationHandoff(handoff: ImplementationHandoff | undefined): void;
	markImplementationPending(ctx?: ExtensionContext): void;
	/**
	 * Take ownership of the MoA progress widget from orchestration, so it stays
	 * mounted across in-session implementation and verification. Orchestration's
	 * own `finally` skips its stop when the controller holds the widget.
	 */
	adoptProgressWidget(widget: MoaProgressWidget): void;
	getActiveProgressWidget(): MoaProgressWidget | undefined;
	stopActiveProgressWidget(): void;
	/**
	 * Publish (or clear) the F4-cancellable session the input triggers open the
	 * cancel overlay against. The verification phase uses this to make its
	 * read-only verifier subprocess cancellable, mirroring how fan-out/synthesis
	 * publish their run via the plan-prompt session.
	 */
	setActiveCancelSession(session: CancelSession | undefined): void;
}

/**
 * Models chosen up front in the MoA picker for the post-approval phases:
 * the implementer that writes the approved plan in-session, and the verifier
 * that judges the result against the plan. Threaded from the picker through
 * orchestration into the review loop and the implementation handoff.
 */
export interface MoaRoles {
	implementer: ModelRef;
	implementerThinking?: ThinkingLevel;
	verifier: ModelRef;
	verifierThinking?: ThinkingLevel;
}

export interface SynthesisRoundResult {
	result: SingleResult;
	cancelled?: boolean;
	failed?: boolean;
}

export interface SucceededProposal {
	ref: ModelRef;
	plan: string;
	originalIndex: number;
}

export interface ReviewLoopOptions {
	host: MoaRunHost;
	ctx: ExtensionContext;
	session: CancelSession;
	widget: MoaProgressWidget;
	proposers: ModelRef[];
	succeeded: SucceededProposal[];
	initialPlan: string;
	synthConversation: string[];
	getSynthesizer(): ModelRef;
	/** Current synthesizer thinking level, read live so review-round activations show the active selection. */
	getSynthesizerThinking(): ThinkingLevel | undefined;
	getLatestVerdicts(): string | null;
	setLatestVerdicts(markdown: string): void;
	rebuildSynthTask(): void;
	getSynthTask(): string;
	runSynthWithRecovery(task: string): Promise<SynthesisRoundResult>;
	warnIfMutated(phase: string): Promise<void>;
	roles?: MoaRoles;
	generateVerificationCriteria?(plan: string): Promise<{ criteria: VerificationCriterion[]; markdown: string } | undefined>;
}

export interface MoaRunContext {
	host: MoaRunHost;
	session: CancelSession;
	widget: MoaProgressWidget;
	synthesizer: ModelRef;
	synthesizerThinking: ThinkingLevel | undefined;
	synthConversation: string[];
	latestVerdicts: string | null;
	proposalFiles: ProposalFileSet | null;
	observeSession: ObserveSession | undefined;
	previousObserveSession: ObserveSession | undefined;
	roles?: MoaRoles;
}
