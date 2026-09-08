import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fanout = readFileSync(path.join(root, "src/moa/fanout.ts"), "utf8");
const orchestration = readFileSync(path.join(root, "src/moa/orchestration.ts"), "utf8");

// The observer becomes globally visible inside runFanoutPhase. Its predecessor
// and ownership must therefore reach the outer run context before the first
// awaited fan-out operation can reject; runMoaPhases' finally then owns cleanup.
const predecessorAt = fanout.indexOf("runContext.previousObserveSession = previousObserveSession");
const observerAt = fanout.indexOf("runContext.observeSession = observe");
const installAt = fanout.indexOf("host.setActiveObserveSession(observe)");
const awaitAt = fanout.indexOf("const results = await runFanout(");
assert.ok(predecessorAt > 0, "fan-out publishes the predecessor to the outer run context");
assert.ok(observerAt > predecessorAt, "fan-out publishes observer ownership after its predecessor");
assert.ok(installAt > observerAt, "ownership is published before the observer becomes globally visible");
assert.ok(awaitAt > installAt, "observer ownership is published before fan-out can reject");

assert.match(
	orchestration,
	/runFanoutPhase\(\{\s*host,\s*runContext,\s*ctx,/,
	"the live MoA run context is passed into fan-out",
);
assert.match(
	orchestration,
	/finally \{[\s\S]*?if \(runContext\.observeSession && host\.getActiveObserveSession\(\) === runContext\.observeSession\) \{[\s\S]*?host\.setActiveObserveSession\(runContext\.previousObserveSession\);[\s\S]*?runContext\.observeSession\?\.closeOverlay\?\.\(\);/,
	"outer cleanup restores and closes a published observer even when fan-out throws",
);

console.log("Fan-out observer throw cleanup contract passed.");
