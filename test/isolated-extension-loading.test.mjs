import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const runner = read("src/runtime/runner.ts");
const orchestration = ["src/planning/planMode.ts", "src/planning/tools/mfPlanSubagent.ts"].map(read).join("\n");
const modelRuntime = read("src/moa/modelRuntime.ts");
const verification = read("src/moa/verification.ts");
const moaOrchestration = ["src/moa/fanout.ts", "src/moa/synthesis.ts", "src/opinion/opinionFanout.ts", "src/debate/debateFanout.ts"].map(read).join("\n");

assert.match(runner, /if \(options\.extensionPath\) \{\s*args\.push\("--no-extensions", "-e", options\.extensionPath\)/);
assert.match(runner, /else if \(!options\.loadExtensions\) \{\s*args\.push\("--no-extensions"\)/);
assert.match(runner, /extensionPath\?: string/);
assert.match(modelRuntime, /function cursorBridgeExtensionPath\(\): string \| undefined/);
assert.match(modelRuntime, /path\.join\(getAgentDir\(\), "extensions", "cursor-bridge"\)/);
assert.match(modelRuntime, /if \(ref\.provider === "cursor-bridge"\)/);
assert.match(modelRuntime, /return \{ extensionPath \}/);
assert.match(moaOrchestration, /\.\.\.modelExtensionOptions\(ctx, ref\)/);
assert.match(moaOrchestration, /\.\.\.modelExtensionOptions\(ctx, runContext\.synthesizer\)/);
// Both verifier subprocess launches go through the injectable `runVerifier`
// seam (defaulting to runSingleAgent) and still load the verifier's extension.
assert.match(verification, /runVerifierPreflight[\s\S]*?runVerifier\([\s\S]*?\.\.\.modelExtensionOptions\(ctx, verifier\)/);
assert.match(verification, /runVerifierOnce[\s\S]*?runVerifier\([\s\S]*?\.\.\.modelExtensionOptions\(ctx, verifier\)/);
assert.match(verification, /const runVerifier = options\.runSingleAgent \?\? runSingleAgent/, "the verifier launcher is injectable, defaulting to the real subprocess");

// Extension-registered providers (e.g. claude-bridge) must be detected via pi's
// real ModelRegistry API. The old `registeredProviders` Map access never existed
// on ModelRegistry, so it silently matched nothing and only cursor-bridge — the
// hardcoded fallback — ever loaded its extension in the verification subprocess.
assert.match(modelRuntime, /getRegisteredProviderIds\(\)\.includes\(ref\.provider\)/);
assert.doesNotMatch(modelRuntime, /registeredProviders/);

// The mf_plan_subagent tool path must opt in too. moa-explore/mf-plan take
// their model from frontmatter, which the settings overlay can point at an
// extension-registered provider — those spawned with a plain --no-extensions
// child fail with 'Model "claude-bridge/..." not found'.
assert.match(orchestration, /const agentExtensionOptions = \(agentName: string\)/);
assert.match(orchestration, /modelExtensionOptions\(ctx, parseModelRefLabel\(model\)\)/);
assert.match(orchestration, /\.\.\.agentExtensionOptions\(t\.agent\)/);
assert.match(orchestration, /\.\.\.agentExtensionOptions\(params\.agent!\), resolveOnAbort: true/);
// runParallelAgents must be able to carry them per task, like its sibling.
assert.match(runner, /export interface ParallelAgentTask \{[\s\S]*?agent: string;[\s\S]*?task: string;[\s\S]*?model\?: string;[\s\S]*?thinking\?: ThinkingLevel;[\s\S]*?loadExtensions\?: boolean;[\s\S]*?extensionPath\?: string;/);
assert.match(runner, /loadExtensions: t\.loadExtensions,\s*\n\s*extensionPath: t\.extensionPath,\s*\n\s*resolveOnAbort: true,\s*\n\s*onProgress/);

console.log("Isolated extension loading contract passed.");
