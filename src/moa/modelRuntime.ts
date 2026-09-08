import { calculateCost } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadMoaConfig, saveMoaConfig } from "../config/settings.ts";
import type { UsageStats } from "../runtime/results.ts";
import { modelRefLabel, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";

export function modelUsesExtensionRegisteredProvider(ctx: ExtensionContext, ref: ModelRef): boolean {
	return ctx.modelRegistry.getRegisteredProviderIds().includes(ref.provider);
}

export function cursorBridgeExtensionPath(): string | undefined {
	const packageDir = path.join(getAgentDir(), "extensions", "cursor-bridge");
	try {
		const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
			pi?: { extensions?: unknown };
		};
		const entries = packageJson.pi?.extensions;
		if (!Array.isArray(entries)) return undefined;
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			const entryPath = path.resolve(packageDir, entry);
			if (fs.existsSync(entryPath)) return entryPath;
		}
	} catch {
		// Fall back to normal extension discovery below when cursor-bridge is
		// installed outside the conventional global-extension package layout.
	}
	return undefined;
}

export function modelExtensionOptions(ctx: ExtensionContext, ref: ModelRef): { loadExtensions?: boolean; extensionPath?: string } {
	if (ref.provider === "cursor-bridge") {
		const extensionPath = cursorBridgeExtensionPath();
		if (extensionPath) return { extensionPath };
	}
	return modelUsesExtensionRegisteredProvider(ctx, ref) ? { loadExtensions: true } : {};
}

export function resolveContextWindow(ctx: ExtensionContext, ref: ModelRef): number | undefined {
	return ctx.modelRegistry.find(ref.provider, ref.id)?.contextWindow;
}

/** Calculate cumulative cost from the registry rates and the runner's token totals. */
export function resolveModelCost(ctx: ExtensionContext, ref: ModelRef, usage: UsageStats): number | undefined {
	const model = ctx.modelRegistry.find(ref.provider, ref.id);
	if (!model) return undefined;
	const cost = calculateCost(model, {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cacheWrite1h: usage.cacheWrite1h,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	return Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : undefined;
}

export async function applyImplementingSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selection: { ref: ModelRef; thinking: ThinkingLevel },
	successNotice: string,
): Promise<void> {
	const model = ctx.modelRegistry.find(selection.ref.provider, selection.ref.id);
	if (!model) {
		ctx.ui.notify(`Model ${modelRefLabel(selection.ref)} not in registry; keeping current model.`, "warning");
		return;
	}
	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(`No API key for ${modelRefLabel(selection.ref)}; keeping current model.`, "warning");
		return;
	}
	const settings = loadMoaConfig();
	saveMoaConfig({
		...settings,
		implementer: selection.ref,
		thinkingOverrides: { ...settings.thinkingOverrides, [modelRefLabel(selection.ref)]: selection.thinking },
	});
	pi.setThinkingLevel(selection.thinking);
	ctx.ui.notify(successNotice);
}
