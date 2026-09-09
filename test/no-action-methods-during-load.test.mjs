import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/index.ts transitively loads overlay modules that use TypeScript parameter
// properties, so execute this assertion script under Node's TS transform.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], {
			stdio: "inherit",
		});
	} catch (err) {
		process.exit(err.status ?? 1);
	}
	process.exit(0);
}

const { default: mfPlanExtension } = await import("../src/index.ts");

const loadingError = "Extension runtime not initialized. Action methods cannot be called during extension loading.";
const actionDuringLoad = () => { throw new Error(loadingError); };

// Registration APIs are available to an extension factory, but action APIs are
// not bound until the factory returns. Keep this fake strict so a new eager
// runtime call fails the test instead of being hidden by a permissive harness.
const strictPi = {
	getActiveTools: actionDuringLoad,
	getAllTools: actionDuringLoad,
	getThinkingLevel: actionDuringLoad,
	getFlag: actionDuringLoad,
	getCommands: actionDuringLoad,
	getSessionName: actionDuringLoad,
	setActiveTools: actionDuringLoad,
	setThinkingLevel: actionDuringLoad,
	setModel: actionDuringLoad,
	setSessionName: actionDuringLoad,
	setLabel: actionDuringLoad,
	appendEntry: actionDuringLoad,
	sendMessage: actionDuringLoad,
	sendUserMessage: actionDuringLoad,
	exec: actionDuringLoad,
	registerFlag: () => {},
	registerCommand: () => {},
	registerShortcut: () => {},
	registerTool: () => {},
	on: () => {},
	events: { on: () => () => {}, emit: () => {} },
};

assert.doesNotThrow(
	() => mfPlanExtension(strictPi),
	"the extension factory must not call action methods before runtime binding",
);

console.log("Extension loading action-method guard passed.");
