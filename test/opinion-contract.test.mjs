import assert from "node:assert/strict";

import {
	OPINION_TASK_PREAMBLE,
	buildOpinionRetryTask,
	buildOpinionTask,
	looksLikeOpinion,
} from "../src/opinion/opinionContract.ts";
import {
	collectOpinionOutcomes,
	demoteHeadings,
	formatOpinionsMarkdown,
} from "../src/opinion/opinionResults.ts";

assert.equal(looksLikeOpinion("## Opinion\nUse the existing path."), true);
assert.equal(looksLikeOpinion("# Answer\nNo."), true);
assert.equal(looksLikeOpinion("Is this safe?"), false);
assert.equal(looksLikeOpinion("## Open Questions\n- which flag?"), false);
assert.equal(looksLikeOpinion("I cannot proceed with read-only tools."), false);
assert.equal(looksLikeOpinion(OPINION_TASK_PREAMBLE), false);
assert.equal(looksLikeOpinion(buildOpinionRetryTask("", "refusal")), false);

const task = buildOpinionTask("Is X safe?");
assert.ok(task.startsWith(OPINION_TASK_PREAMBLE));
assert.ok(task.endsWith("Question:\nIs X safe?"));

assert.equal(
	demoteHeadings("## Opinion\ntext\n```ts\n# comment\n```\n# Verdict"),
	"### Opinion\ntext\n```ts\n# comment\n```\n## Verdict",
);

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0, toolCalls: 0 };
const result = (overrides) => ({
	agent: "moa-opinion",
	agentSource: "user",
	task: "question",
	exitCode: 0,
	messages: [],
	stderr: "",
	usage,
	...overrides,
});
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const models = [
	{ provider: "one", id: "model-a" },
	{ provider: "two", id: "model-b" },
	{ provider: "three", id: "model-c" },
];
const outcomes = collectOpinionOutcomes(models, ["high", undefined, "low"], [
	result({ messages: [assistant("## Opinion\nChoose A.")] }),
	result({ exitCode: 1, errorMessage: "quota exhausted\nmore detail" }),
	result({ exitCode: 130, stopReason: "aborted", cancelled: true, errorMessage: "Cancelled by user" }),
]);
assert.deepEqual(outcomes.map((item) => item.status), ["done", "error", "cancelled"]);
assert.equal(outcomes[0].text, "## Opinion\nChoose A.");
assert.equal(outcomes[1].text, "quota exhausted\nmore detail");

const markdown = formatOpinionsMarkdown("Which path?", outcomes, "choose-safe-path");
assert.match(markdown, /^# MoA Opinions — choose-safe-path/);
assert.match(markdown, /\*\*Question:\*\* Which path\?/);
assert.match(markdown, /## Opinion 1 — one\/model-a \(thinking: high\)/);
assert.match(markdown, /### Opinion\nChoose A\./, "agent headings nest beneath the slot heading");
assert.match(markdown, /_Failed: quota exhausted_/);
assert.match(markdown, /_Cancelled by user\._/);
assert.match(markdown, /## Opinion 2 — two\/model-b \(thinking: default\)/);

console.log("Opinion contract and formatting tests passed.");
