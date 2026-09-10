import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId } from "@earendil-works/pi-tui";

type KittyFunctionKeyTerminator = "P" | "Q" | "R" | "S";

export const FUNCTION_KEY_KITTY_TERMINATORS: Partial<Record<KeyId, KittyFunctionKeyTerminator>> = {
	f1: "P",
	f2: "Q",
	f3: "R",
	f4: "S",
} as const;

const KITTY_FUNCTION_KEY_SEQUENCE = /^\x1b\[1(?:;(\d+))?(?::(\d+))?([PQRS])$/;

export function matchesFunctionKeyPress(data: string, key: KeyId): boolean {
	if (isKeyRelease(data) || isKeyRepeat(data)) return false;
	if (/:[23][PQRS]$/.test(data)) return false;
	if (matchesKey(data, key)) return true;

	// Compatibility shim for pi-tui's Kitty F1-F4 gap; remove once upstream supports these aliases.
	const terminator = FUNCTION_KEY_KITTY_TERMINATORS[key];
	if (terminator === undefined) return false;

	const match = KITTY_FUNCTION_KEY_SEQUENCE.exec(data);
	return (
		match !== null &&
		match[3] === terminator &&
		(match[1] === undefined || match[1] === "1") &&
		(match[2] === undefined || match[2] === "1")
	);
}
