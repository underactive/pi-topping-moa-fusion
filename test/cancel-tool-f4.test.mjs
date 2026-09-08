import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
	path.join(path.resolve(import.meta.dirname, ".."), "src", "planning", "tools", "mfPlanSubagent.ts"),
	"utf8",
);

// pi's shortcut dispatcher is suspended while a tool executes. The tool path
// therefore needs its own low-level terminal-input listener for F4, just like
// the interactive MoA path uses one for ESC.
assert.match(source, /import \{ isKeyRelease, Key, matchesKey \} from "@earendil-works\/pi-tui";/);
assert.equal((source.match(/ctx\.ui\.onTerminalInput/g) ?? []).length, 2, "single and parallel tool paths must each listen for F4");
assert.equal((source.match(/matchesKey\(data, Key\.f4\)/g) ?? []).length, 2, "both tool paths must recognize F4");
assert.equal((source.match(/unsubscribeF4\?\.\(\)/g) ?? []).length, 2, "both tool listeners must be removed when the run settles");
assert.match(
	source,
	/if \(isKeyRelease\(data\) \|\| !matchesKey\(data, Key\.f4\)\) return undefined;/,
	"F4 release events must not reopen the overlay",
);
assert.match(source, /void showCancelOverlay\(ctx, toolSession\)\.finally/);

console.log("Tool-path F4 cancellation tests passed.");
