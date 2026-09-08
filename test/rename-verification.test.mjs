import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const legacyForms = [
	["moa", "plan"].join("-"),
	["moa", "Plan"].join(""),
	["moa", "plan"].join("_"),
	["pi", "mf-plan"].join("-"),
	["pi-moa", "plan"].join("-"),
];
const ignoredRoots = new Set([".git", "node_modules", ".pi", ".rpiv"]);
const trackedFiles = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
	.split("\n")
	.filter(Boolean)
	.filter((file) => !ignoredRoots.has(file.split("/")[0]));
const sourceFiles = readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
	.map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
const scannedFiles = [...new Set([...trackedFiles, ...sourceFiles, "package-lock.json"])]
	.filter((file) => existsSync(path.join(root, file)));

const legacyReferences = scannedFiles.filter((file) => {
	const content = readFileSync(path.join(root, file), "utf8");
	return legacyForms.some((legacyForm) => content.includes(legacyForm));
});

assert.deepEqual(legacyReferences, [], `Legacy references found:\n${legacyReferences.join("\n")}`);

const read = (file) => readFileSync(path.join(root, file), "utf8");
const packageJson = JSON.parse(read("package.json"));
assert.equal(packageJson.name, "@underactive/pi-topping-moa-fusion");
const packageLockJson = JSON.parse(read("package-lock.json"));
assert.equal(packageLockJson.name, "@underactive/pi-topping-moa-fusion");
assert.equal(packageLockJson.packages[""].name, "@underactive/pi-topping-moa-fusion");

const index = ["src/index.ts", "src/planning/planMode.ts", "src/planning/tools/shared.ts", "src/planning/tools/mfPlanSubagent.ts"].map(read).join("\n");
for (const contract of [
	"mfPlanExtension",
	'"mf-plan"',
	'"mf_plan_subagent"',
	'"mf-plan-context"',
]) {
	assert.ok(index.includes(contract), `index.ts is missing ${contract}`);
}

assert.ok(read("src/planning/planFile.ts").includes('"mf-plan", "plans"'));
assert.ok(read("src/planning/planFile.ts").includes('"mf-plan"'));
assert.ok(read("src/runtime/runner.ts").includes('"pi-topping-moa-fusion-"'));
assert.ok(read("src/ui/moaProgressWidget.ts").includes('"mf-plan-moa-status"'));

console.log("Rename verification passed.");
