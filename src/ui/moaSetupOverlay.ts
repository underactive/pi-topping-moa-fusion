/**
 * Persistent MoA model setup overlay.
 *
 * Lets users configure the planning-subagent and cheap/fast model defaults,
 * the plan options, and the named MoA agent rosters without entering plan
 * mode. The overview and filtered slot picker share one component so Escape
 * returns from a slot to the overview before it can cancel the overlay.
 *
 * Two kinds of slot are configured here. Planning-subagent slots persist into
 * the frontmatter of the installed agent files; MoA fan-out roles are no
 * longer set per role here — they live in named rosters, edited by the staged
 * roster manager and persisted only when this overlay's Save is chosen.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI } from "@earendil-works/pi-tui";
import {
	defaultThinkingForModel,
	loadMoaConfig,
	saveMoaConfig,
	type MoaConfig,
} from "../config/settings.ts";
import type { PlanRoster } from "../config/rosters.ts";
import { modelRefLabel, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { CONFIGURABLE_AGENTS, readAgentDefault, writeAgentDefault } from "../agents/defaults.ts";
import { getAvailableModelRefs } from "./moaModelPicker.ts";
import { showRosterManager } from "./rosterEditor.ts";
import { TwoPaneModelThinking } from "./twoPaneModelThinking.ts";
import { getModelCatalogue } from "../config/modelCatalogue.ts";
import {
	MenuComponent,
	PLAN_OVERLAY_OPTIONS,
	renderMenuBottomBorder,
	renderMenuContentRow,
	renderMenuSeparator,
	renderMenuTopBorder,
	type MenuItem,
} from "./menu.ts";
import { ratioViewport, wrapWords } from "./chrome.ts";

const AGENT_SLOT_COUNT = CONFIGURABLE_AGENTS.length;

interface SetupSlot {
	/** Row label in the overview menu. */
	menuLabel: string;
	/** Title bar of the slot's picker. */
	title: string;
	/** Guidance on what kind of model suits this role, shown under the picker title. */
	description: string;
	/** Whether the overview row appends the selected thinking level. */
	showThinkingValue: boolean;
	/** Where a confirmed selection is persisted. */
	target: { kind: "agent"; agentName: string } | { kind: "role" };
}

const SLOTS: readonly SetupSlot[] = [
	...CONFIGURABLE_AGENTS.map((agent): SetupSlot => ({
		menuLabel: agent.menuLabel,
		title: agent.title,
		description: agent.description,
		showThinkingValue: true,
		target: { kind: "agent", agentName: agent.name },
	})),
	{
		menuLabel: "cheap/fast agent",
		title: "Cheap / fast agent — plan-file naming",
		description: "Only summarizes a plan prompt into a short file name. Always called with thinking off and falls back safely if it cannot respond, so pick the cheapest model available.",
		showThinkingValue: false,
		target: { kind: "role" },
	},
];

/** Working state carried across the staged settings ↔ roster-manager round trip. */
interface SetupDraft {
	selections: (ModelRef | undefined)[];
	slotThinking: (ThinkingLevel | undefined)[];
	thinkingOverrides: Record<string, ThinkingLevel>;
	autoResolveConflicts: boolean;
	useSummaryName: boolean;
	rosters: PlanRoster[];
}

type SetupResult = { action: "save"; draft: SetupDraft } | { action: "rosters"; draft: SetupDraft } | undefined;
type View = "overview" | "slot";

class MoaSetupComponent implements Component {
	private view: View = "overview";
	private selectedSlot = 0;
	private readonly twoPane: TwoPaneModelThinking;
	private readonly menu: MenuComponent;
	private autoResolveConflicts: boolean;
	private useSummaryName: boolean;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		availableRefs: ModelRef[],
		private readonly config: MoaConfig,
		private readonly currentThinking: ThinkingLevel,
		private readonly ctx: ExtensionContext,
		private readonly draft: SetupDraft,
		title: string,
		private readonly done: (result: SetupResult) => void,
	) {
		this.twoPane = new TwoPaneModelThinking(tui, theme, availableRefs, config, currentThinking, ctx);
		this.autoResolveConflicts = draft.autoResolveConflicts;
		this.useSummaryName = draft.useSummaryName;
		const slotItem = (slotIndex: number): MenuItem => ({
			id: `role-${slotIndex}`,
			label: SLOTS[slotIndex]!.menuLabel,
			displayValue: this.roleDisplayValue(slotIndex),
			onSelect: () => this.openSlot(slotIndex),
		});
		this.menu = new MenuComponent({
			title,
			fullWidth: true,
			sections: [
				{ title: "planning subagents", items: SLOTS.slice(0, AGENT_SLOT_COUNT).map((_unused, index) => slotItem(index)) },
				{ title: "model roles", items: SLOTS.slice(AGENT_SLOT_COUNT).map((_unused, index) => slotItem(AGENT_SLOT_COUNT + index)) },
				{
					title: "rosters",
					items: [{
						id: "agent-rosters",
						label: "agent rosters",
						displayValue: `${this.draft.rosters.length} configured`,
						description: "Reusable model + thinking assignments for every MoA role. Load one from the picker's Load Roster row.",
						onSelect: () => this.done({ action: "rosters", draft: this.draftOut() }),
					}],
				},
				{ title: "options", items: [
					{ id: "auto-resolve", label: "auto resolve conflicts", value: this.autoResolveConflicts, onChange: (value: boolean) => { this.autoResolveConflicts = value; } },
					{ id: "use-summary-name", label: "summarize plan names", value: this.useSummaryName, onChange: (value: boolean) => { this.useSummaryName = value; } },
				] },
			],
			buttons: [
				{ id: "save", label: "Save and Close", primary: true, onSelect: () => this.saveAndClose() },
				{ id: "cancel", label: "Cancel", onSelect: () => this.done(undefined) },
			],
		}, theme, () => {
			this.done(undefined);
		}, tui);
	}

	private openSlot(slotIndex: number): void {
		this.view = "slot";
		this.selectedSlot = slotIndex;
		const selectedRef = this.draft.selections[slotIndex];
		this.twoPane.reset(selectedRef, this.draft.slotThinking[slotIndex]);
		this.tui.requestRender();
	}

	private closeSlot(): void {
		this.view = "overview";
		this.tui.requestRender();
	}

	private roleDisplayValue(slotIndex: number): string | undefined {
		const selected = this.draft.selections[slotIndex];
		if (!selected) return undefined;
		if (!SLOTS[slotIndex]!.showThinkingValue) return modelRefLabel(selected);
		return `${modelRefLabel(selected)} (thinking: ${this.thinkingForSlot(slotIndex, selected)})`;
	}

	private draftOut(): SetupDraft {
		return {
			selections: [...this.draft.selections],
			slotThinking: [...this.draft.slotThinking],
			thinkingOverrides: { ...this.draft.thinkingOverrides },
			autoResolveConflicts: this.autoResolveConflicts,
			useSummaryName: this.useSummaryName,
			rosters: [...this.draft.rosters],
		};
	}

	private saveAndClose(): void {
		this.done({ action: "save", draft: this.draftOut() });
	}

	private thinkingForSlot(slotIndex: number, ref: ModelRef): ThinkingLevel {
		return this.draft.slotThinking[slotIndex]
			?? defaultThinkingForModel(
				modelRefLabel(ref),
				this.config,
				this.currentThinking,
				getModelCatalogue(this.ctx.modelRegistry).thinkingLevelsFor(ref),
			);
	}

	private confirmSlot(): void {
		const selection = this.twoPane.getSelected();
		this.draft.selections[this.selectedSlot] = selection.ref;
		this.draft.slotThinking[this.selectedSlot] = selection.thinking;
		this.draft.thinkingOverrides[modelRefLabel(selection.ref)] = selection.thinking;
		// `config` is this invocation's own copy, so recording the choice here is
		// what makes the level stick when the same slot is reopened before saving.
		this.config.thinkingOverrides[modelRefLabel(selection.ref)] = selection.thinking;
		this.menu.setItemValue(`role-${this.selectedSlot}`, this.roleDisplayValue(this.selectedSlot));
		this.closeSlot();
	}

	private handleSlotInput(data: string): void {
		const action = this.twoPane.handleInput(data);
		if (action === "confirm") this.confirmSlot();
		else if (action === "back") this.closeSlot();
	}

	handleInput(data: string): void {
		if (this.view === "overview") this.menu.handleInput(data);
		else this.handleSlotInput(data);
	}

	render(width: number): string[] {
		const viewport = ratioViewport(process.stdout.rows, {
			fallbackRows: 24,
			ratio: 0.7,
			minimum: 6,
		});
		if (this.view === "overview") {
			this.menu.setViewport(viewport);
			return this.menu.render(width);
		}

		const th = this.theme;
		const innerWidth = Math.max(20, width - 2);
		const bodyWidth = Math.max(10, innerWidth - 2);
		const slot = SLOTS[this.selectedSlot]!;
		const descriptionLines = wrapWords(slot.description, bodyWidth).slice(0, viewport >= 16 ? 2 : 1);
		const hint = "type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select • esc back";
		const { actionRow, hintRows } = this.twoPane.renderFooter(bodyWidth, hint);
		this.twoPane.setMaxVisibleRows(Math.max(1, viewport - 7 - descriptionLines.length - (hintRows.length - 1)));
		const pickerLines = this.twoPane.render(bodyWidth);
		const top = renderMenuTopBorder(th, innerWidth, slot.title);
		const bottom = renderMenuBottomBorder(th, innerWidth);
		const framedPicker = pickerLines.map((line) => renderMenuContentRow(th, innerWidth, ` ${line}`));
		const lines = [
			top,
			...descriptionLines.map((line) => renderMenuContentRow(th, innerWidth, th.fg("muted", ` ${line}`))),
			renderMenuSeparator(th, innerWidth),
			...framedPicker,
			renderMenuSeparator(th, innerWidth),
			renderMenuContentRow(th, innerWidth, actionRow),
			renderMenuSeparator(th, innerWidth),
			...hintRows.map((line) => renderMenuContentRow(th, innerWidth, line)),
			bottom,
		];
		if (lines.length <= viewport) return lines;
		return [
			top,
			...framedPicker.slice(0, Math.max(1, viewport - 3)),
			renderMenuContentRow(th, innerWidth, actionRow),
			bottom,
		].slice(0, viewport);
	}

	invalidate(): void {
		this.menu.invalidate();
		this.twoPane.invalidate();
	}

	dispose(): void {
		this.menu.dispose();
	}
}

/** Match a frontmatter model value, which may be a bare id rather than `provider/id`. */
function resolveModelRef(raw: string | undefined, available: ModelRef[]): ModelRef | undefined {
	if (!raw) return undefined;
	return available.find((ref) => modelRefLabel(ref) === raw) ?? available.find((ref) => ref.id === raw);
}

/** Show the interactive MoA defaults setup overlay and persist selections on save. */
export async function showMoaSetup(
	ctx: ExtensionContext,
	currentThinking: ThinkingLevel,
	options: { firstRun?: boolean } = {},
): Promise<boolean> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("MoA Fusion Settings requires interactive mode.", "warning");
		return false;
	}

	const available = getAvailableModelRefs(ctx);
	if (available.length === 0) {
		ctx.ui.notify("No callable models are available for MoA Fusion Settings.", "warning");
		return false;
	}

	const saved = loadMoaConfig();
	const currentModelRef: ModelRef = ctx.model
		? { provider: ctx.model.provider, id: ctx.model.id }
		: available[0]!;

	// Agent slots read their current value from the installed agent files, which
	// stay authoritative even if someone hand-edits them.
	const agentDefaults = CONFIGURABLE_AGENTS.map((agent) => readAgentDefault(agent.name));
	const draft: SetupDraft = {
		selections: [...agentDefaults.map((entry) => resolveModelRef(entry.model, available)), saved.cheap ?? currentModelRef],
		slotThinking: [...agentDefaults.map((entry) => entry.thinking), undefined],
		thinkingOverrides: {},
		autoResolveConflicts: saved.autoResolveConflicts,
		useSummaryName: saved.useSummaryName,
		rosters: [...saved.rosters],
	};

	// Seed the shared thinking map so an agent's frontmatter level is preselected
	// the first time its picker opens, not just shown on the overview row.
	const seeded: MoaConfig = { ...saved, thinkingOverrides: { ...saved.thinkingOverrides } };
	for (const [index, entry] of agentDefaults.entries()) {
		const ref = draft.selections[index];
		if (ref && entry.thinking) seeded.thinkingOverrides[modelRefLabel(ref)] = entry.thinking;
	}

	const title = options.firstRun
		? "MoA Fusion Settings — set up agents and rosters before planning"
		: "MoA Fusion Settings — configure agents and rosters";

	// Staged loop: the overlay closes around the roster manager and reopens with
	// the draft preserved, so one settings visit can edit slots and rosters.
	let result: SetupResult;
	for (;;) {
		result = await ctx.ui.custom<SetupResult>(
			(tui, theme, _keybindings, done) =>
				new MoaSetupComponent(tui, theme, available, seeded, currentThinking, ctx, draft, title, done),
			PLAN_OVERLAY_OPTIONS,
		);
		if (result === undefined) return false;
		if (result.action === "rosters") {
			draft.rosters = await showRosterManager(ctx, draft.rosters, { currentThinking });
			continue;
		}
		break;
	}
	const finalDraft = result.draft;

	const unwritable: string[] = [];
	for (const [index, agent] of CONFIGURABLE_AGENTS.entries()) {
		const ref = finalDraft.selections[index];
		if (!ref) continue;
		const thinking = finalDraft.slotThinking[index]
			?? defaultThinkingForModel(
				modelRefLabel(ref),
				seeded,
				currentThinking,
				getModelCatalogue(ctx.modelRegistry).thinkingLevelsFor(ref),
			);
		if (!writeAgentDefault(agent.name, modelRefLabel(ref), thinking)) unwritable.push(agent.name);
	}
	if (unwritable.length > 0) {
		ctx.ui.notify(`Could not update agent frontmatter for: ${unwritable.join(", ")}.`, "warning");
	}

	// The per-role fan-out keys (proposers/synthesizer/implementer/verifier) are
	// intentionally left untouched: they remain load-bearing for resume,
	// verifier fallback, and picker seeding, and are only written by a run's
	// own confirmations.
	const current = loadMoaConfig();
	saveMoaConfig({
		...current,
		mode: "moa",
		agentDefaultsConfigured: true,
		autoResolveConflicts: finalDraft.autoResolveConflicts,
		useSummaryName: finalDraft.useSummaryName,
		cheap: finalDraft.selections[AGENT_SLOT_COUNT],
		rosters: finalDraft.rosters,
		thinkingOverrides: { ...current.thinkingOverrides, ...finalDraft.thinkingOverrides },
	});
	return true;
}
