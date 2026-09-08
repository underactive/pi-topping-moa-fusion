import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ExtensionEditorComponent, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Container, Editor, Text, type Focusable, type TUI } from "@earendil-works/pi-tui";

type KeybindingsManager = ConstructorParameters<typeof ExtensionEditorComponent>[1];

let fdPath: string | null | undefined;

/** Find pi's bundled fd binary, then a compatible binary available on PATH. */
export function resolveFdPath(): string | null {
	if (fdPath !== undefined) return fdPath;

	try {
		const bundledPath = join(getAgentDir(), "bin", process.platform === "win32" ? "fd.exe" : "fd");
		if (existsSync(bundledPath)) return fdPath = bundledPath;

		for (const command of ["fd", "fdfind"]) {
			if (spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0) return fdPath = command;
		}
	} catch {
		// Path lookup is an optional enhancement; regular path completion still works.
	}

	return fdPath = null;
}

export class PromptEditorComponent extends Container implements Focusable {
	private readonly editor: Editor;
	private readonly inner: ExtensionEditorComponent;

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		done: (value: string | undefined) => void,
		cwd: string,
	) {
		super();
		this.inner = new ExtensionEditorComponent(tui, keybindings, title, prefill, done, () => done(undefined));
		this.addChild(this.inner);

		// pi-coding-agent may resolve a nested pi-tui copy, so retain a structural
		// fallback when the primary instanceof guard has a different class identity.
		const editor = this.inner.children.find((child): child is Editor => (
			child instanceof Editor
			|| (
				typeof (child as Editor).setAutocompleteProvider === "function"
				&& typeof (child as Editor).isShowingAutocomplete === "function"
				&& typeof (child as Editor).getText === "function"
			)
		));
		if (!editor) throw new Error("ExtensionEditorComponent did not contain an Editor");
		this.editor = editor;
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], cwd, resolveFdPath()));

		this.addChild(new Text("Tab completes file paths · @name searches the repo", 1, 0));
	}

	get focused(): boolean {
		return this.inner.focused;
	}

	set focused(value: boolean) {
		this.inner.focused = value;
	}

	handleInput(data: string): void {
		if (this.editor.isShowingAutocomplete()) {
			this.editor.handleInput(data);
			return;
		}
		this.inner.handleInput(data);
	}

	dispose(): void {}
}

export function showPromptEditor(ctx: ExtensionContext, title: string, prefill?: string): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.editor(title, prefill);
	return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => (
		new PromptEditorComponent(tui, keybindings, title, prefill, done, ctx.cwd)
	));
}
