import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getPlanFilePath, writePlan } from "../planFile.ts";
import { WRITE_PLAN_OUTPUT_SCHEMA } from "./structuredResults.ts";

export function registerWritePlanTool(pi: ExtensionAPI, isEnabled: () => boolean): void {
	pi.registerTool({
		name: "write_plan",
		label: "Write Plan",
		description: "Write or update content in the plan file. This is the ONLY file you can write during plan mode. Use this to build your plan incrementally.",
		parameters: Type.Object({
			content: Type.String({ description: "The full content to write to the plan file (replaces existing content)" }),
		}),
		outputSchema: WRITE_PLAN_OUTPUT_SCHEMA,
		// Replaces the whole plan file; the same content yields a byte-identical file.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!isEnabled()) {
				return {
					details: undefined,
					content: [{ type: "text", text: "Error: Not in plan mode. Use /mf-plan to enter plan mode first." }],
					isError: true,
				};
			}

			const filePath = getPlanFilePath();
			writePlan(params.content);

			return {
				content: [{ type: "text", text: `Plan written to ${filePath} (${params.content.length} chars)` }],
				details: { filePath, length: params.content.length },
				structuredContent: { status: "written", filePath, length: params.content.length },
			};
		},
	});
}
