import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installShippedAgents, shippedAgentsDir, withAuthoritativeMoaAgents } from "../agents/authoritative.ts";
import { loadMoaConfig } from "../config/settings.ts";
import { discoverAgents } from "../agents/discovery.ts";
import { cleanupProposalFiles, sweepStaleProposalFiles } from "../planning/planFile.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import { formatMutationWarning, MutationTripwire } from "../runtime/mutationTripwire.ts";
import type { ModelRef, ThinkingLevel } from "../shared/modelRefs.ts";
import { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import { runFanoutPhase } from "./fanout.ts";
import { resolveContextWindow } from "./modelRuntime.ts";
import { runReviewLoop } from "./reviewLoop.ts";
import type { MoaRoles, MoaRunContext, MoaRunHost } from "./runContext.ts";
import { runSynthesisPhase } from "./synthesis.ts";

export async function runMoaOrchestration(
	host: MoaRunHost,
	ctx: ExtensionContext,
	prompt: string,
	proposers: ModelRef[],
	synthesizer: ModelRef,
	proposerThinking: (ThinkingLevel | undefined)[],
	initialSynthesizerThinking: ThinkingLevel | undefined,
	session: CancelSession,
	roles?: MoaRoles,
): Promise<"done" | "cancelled"> {
	let runContext: MoaRunContext;
	const widget = new MoaProgressWidget(ctx, (ref) => resolveContextWindow(ctx, ref), {
		closeStacked: () => {
			session.closeOverlay?.();
			runContext.observeSession?.closeOverlay?.();
		},
	}, host.getPlanRepoSlug());
	host.setRunningProgressWidget(widget);
	widget.setPhaseModels({
		Plan: proposers,
		Synthesize: synthesizer,
		Implement: roles?.implementer,
		Verify: roles?.verifier,
	});
	widget.queueRoleRow("Synthesize", synthesizer, initialSynthesizerThinking);
	if (roles) {
		widget.queueRoleRow("Implement", roles.implementer, roles.implementerThinking);
		widget.queueRoleRow("Verify", roles.verifier, roles.verifierThinking);
	}
	runContext = {
		host,
		session,
		widget,
		synthesizer,
		synthesizerThinking: initialSynthesizerThinking,
		synthConversation: [],
		latestVerdicts: null,
		proposalFiles: null,
		observeSession: undefined,
		previousObserveSession: undefined,
		roles,
	};
	try {
		installShippedAgents();
		sweepStaleProposalFiles();
		const maxConcurrency = loadMoaConfig().maxConcurrentAgents;
		const discovery = discoverAgents(ctx.cwd, "user");
		const agents = withAuthoritativeMoaAgents(discovery.agents, shippedAgentsDir());
		const tripwire = new MutationTripwire();
		await tripwire.arm(ctx.cwd);
		const warnIfMutated = async (phase: string): Promise<void> => {
			const changed = await tripwire.check(ctx.cwd);
			if (changed.length > 0) ctx.ui.notify(formatMutationWarning(phase, changed), "error");
		};
		const fanout = await runFanoutPhase({
			host,
			runContext,
			ctx,
			prompt,
			proposers,
			proposerThinking,
			session,
			widget,
			agents,
			warnIfMutated,
			maxConcurrency,
		});
		if (fanout.status !== "continue") return fanout.status;
		const synthesis = await runSynthesisPhase(runContext, {
			ctx,
			prompt,
			proposers,
			succeeded: fanout.succeeded,
			observe: fanout.observe,
			agents,
			warnIfMutated,
		});
		if (synthesis.status !== "review") return synthesis.status;
		return await runReviewLoop(synthesis.options);
	} finally {
		if (host.getRunningProgressWidget() === widget) host.setRunningProgressWidget(undefined);
		if (host.getActiveProgressWidget() !== widget) widget.stopWidget();
		session.run = undefined;
		session.getExtras = undefined;
		if (runContext.observeSession && host.getActiveObserveSession() === runContext.observeSession) {
			host.setActiveObserveSession(runContext.previousObserveSession);
		}
		runContext.observeSession?.closeOverlay?.();
		cleanupProposalFiles(runContext.proposalFiles);
	}
}
