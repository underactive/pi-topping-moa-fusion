import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const {
	MAX_SPEC_QUESTIONS,
	MAX_SPEC_REVISIONS,
	SPEC_BRIEF_SECTIONS,
	SPEC_QUESTION_AREAS,
	SPEC_SYSTEM_PROMPT,
	buildBriefRetryTask,
	buildBriefTask,
	buildPlanHandoff,
	buildQuestionRetryTask,
	buildQuestionTask,
	buildSpecArtifact,
	extractPlanningPrompt,
	missingSpecSections,
	normalizeBrief,
	parseNextStep,
} = await import("../src/spec/specContract.ts");

assert.equal(MAX_SPEC_QUESTIONS, 5);
assert.equal(MAX_SPEC_REVISIONS, 3);
assert.deepEqual(SPEC_QUESTION_AREAS, ["scope", "UX", "architecture", "acceptance criteria", "testing"]);
assert.deepEqual(SPEC_BRIEF_SECTIONS, [
	"Request summary",
	"User goal and motivation",
	"In scope",
	"Out of scope",
	"User scenarios",
	"Functional requirements",
	"Acceptance criteria",
	"Constraints",
	"Assumptions",
	"Risks and unresolved questions",
	"Planning prompt for /mf-plan",
]);
assert.match(SPEC_SYSTEM_PROMPT, /no tools and no repository access/i);
assert.match(SPEC_SYSTEM_PROMPT, /Do not invent file names, symbols, APIs/i);
assert.match(SPEC_SYSTEM_PROMPT, /<request>.*<answer>/i);

// parseNextStep: ready, valid questions, malformed replies, fences, and length cap.
assert.deepEqual(parseNextStep("\n## Ready\n"), { kind: "ready" });
assert.deepEqual(
	parseNextStep("## Question\nWhich outcomes must be observable?\nAffects: Acceptance Criteria"),
	{ kind: "question", question: "Which outcomes must be observable?", area: "acceptance criteria" },
);
assert.deepEqual(
	parseNextStep("```markdown\n## Question\nShould the control be visible on mobile?\nAffects: ux\n```"),
	{ kind: "question", question: "Should the control be visible on mobile?", area: "UX" },
);
assert.deepEqual(parseNextStep("## Question\nWhich behavior?"), { kind: "malformed" });
assert.deepEqual(parseNextStep("## Question\nWhich behavior?\nAffects: documentation"), { kind: "malformed" });
assert.deepEqual(parseNextStep("## Question\n\nAffects: scope"), { kind: "malformed" });
assert.deepEqual(parseNextStep("I think the request is ready."), { kind: "malformed" });
const longQuestion = "x".repeat(700);
const parsedLongQuestion = parseNextStep(`## Question\n${longQuestion}\nAffects: testing`);
assert.equal(parsedLongQuestion.kind, "question");
assert.equal(parsedLongQuestion.question.length, 600);

// buildQuestionTask includes request boundaries, remaining count, prior Q/A, and the complete protocol.
const noAnswerQuestionTask = buildQuestionTask({ request: "Add dark mode", repoName: "sample", answers: [] });
assert.match(noAnswerQuestionTask, /<request>\nAdd dark mode\n<\/request>/);
assert.match(noAnswerQuestionTask, /Remaining question allowance: 5 of 5/);
assert.match(noAnswerQuestionTask, /## Ready/);
for (const area of SPEC_QUESTION_AREAS) assert.ok(noAnswerQuestionTask.includes(area), `question task names ${area}`);

const fourAnswers = [
	{ question: "Which users?", area: "scope", answer: "All signed-in users." },
	{ question: "Where?", area: "UX", answer: "Settings and the header." },
	{ question: "Persist it?", area: "architecture", answer: "Use the existing preference store." },
	{ question: "How verified?", area: "testing", answer: "Unit and browser tests." },
];
const almostDoneQuestionTask = buildQuestionTask({ request: "Add dark mode", repoName: "sample", answers: fourAnswers });
assert.match(almostDoneQuestionTask, /Remaining question allowance: 1 of 5/);
for (const item of fourAnswers) {
	assert.ok(almostDoneQuestionTask.includes(item.question));
	assert.ok(almostDoneQuestionTask.includes(item.answer));
}

// buildBriefTask lists the required contract and carries ordinary, revision, and headless context.
const briefTask = buildBriefTask({
	request: "Add dark mode",
	repoName: "sample",
	answers: [
		{ question: "Which users?", area: "scope", answer: "Everyone." },
		{ question: "Which fallback?", area: "UX", answer: "" },
	],
});
let priorHeadingIndex = -1;
for (const heading of SPEC_BRIEF_SECTIONS) {
	const headingIndex = briefTask.indexOf(`\`## ${heading}\``);
	assert.ok(headingIndex > priorHeadingIndex, `${heading} appears in contract order`);
	priorHeadingIndex = headingIndex;
}
assert.match(briefTask, /Which users\?/);
assert.match(briefTask, /Everyone\./);
assert.match(briefTask, /\(no answer — use best judgment\)/);
assert.match(briefTask, /exactly one fenced block/i);
assert.match(briefTask, /testing expectations/i);

const revisionTask = buildBriefTask({
	request: "Add dark mode",
	repoName: "sample",
	answers: [],
	revision: { previousBrief: "## Request summary\nOld summary", feedback: "Make keyboard behavior explicit." },
});
assert.match(revisionTask, /## Request summary\nOld summary/);
assert.match(revisionTask, /Make keyboard behavior explicit\./);
assert.match(revisionTask, /instead of starting over/i);
const headlessTask = buildBriefTask({ request: "Add dark mode", repoName: "sample", answers: [], headless: true });
assert.match(headlessTask, /headless/i);
assert.match(headlessTask, /record every open point under `## Assumptions`/i);

function completeBrief(bodyFor = () => "Complete section body.") {
	return SPEC_BRIEF_SECTIONS.map((heading) => {
		const body = heading === "Planning prompt for /mf-plan"
			? "```text\nPlan the requested change with its scope, constraints, and tests.\n```"
			: bodyFor(heading);
		return `## ${heading}\n\n${body}`;
	}).join("\n\n");
}

const validBrief = completeBrief();
assert.equal(
	normalizeBrief(`~~~markdown\nIntroductory prose that must be removed.\n\n${validBrief}\n~~~`),
	validBrief,
);
assert.equal(normalizeBrief("Malformed prose only."), "Malformed prose only.");

assert.deepEqual(missingSpecSections(validBrief), []);
const withoutTwoSections = SPEC_BRIEF_SECTIONS
	.filter((heading) => heading !== "Out of scope" && heading !== "Constraints")
	.map((heading) => `## ${heading}\n\nBody for ${heading}.`)
	.join("\n\n");
assert.deepEqual(missingSpecSections(withoutTwoSections), ["## Out of scope", "## Constraints"]);
const withEmptyConstraints = completeBrief((heading) => heading === "Constraints" ? "" : "Complete section body.");
assert.deepEqual(missingSpecSections(withEmptyConstraints), ["## Constraints (empty)"]);
const inScopeOnlyInsideFence = [
	"## Request summary",
	"Summary.",
	"```markdown",
	"## In scope",
	"This is an example, not a real section.",
	"```",
	...SPEC_BRIEF_SECTIONS.slice(1)
		.filter((heading) => heading !== "In scope")
		.flatMap((heading) => [`## ${heading}`, `Body for ${heading}.`]),
].join("\n\n");
assert.deepEqual(missingSpecSections(inScopeOnlyInsideFence), ["## In scope"]);

// extractPlanningPrompt handles fenced and plain bodies, command prefixes, absence, and duplicate sections.
assert.equal(
	extractPlanningPrompt("## Planning prompt for /mf-plan\n\n```text\n/mf-plan Plan the dark-mode implementation and tests.\n```"),
	"Plan the dark-mode implementation and tests.",
);
assert.equal(
	extractPlanningPrompt("## Planning prompt for /mf-plan\n\nPlan the implementation.\n\n## Extra\nIgnored."),
	"Plan the implementation.",
);
assert.equal(extractPlanningPrompt("## Request summary\nNothing else."), undefined);
assert.equal(
	extractPlanningPrompt([
		"## Planning prompt for /mf-plan",
		"Use the old prompt.",
		"## Notes",
		"Not part of either prompt.",
		"## Planning prompt for /mf-plan",
		"```text",
		"Use the new prompt.",
		"## This heading is inside the fence",
		"```",
		"## Trailing section",
		"Ignored.",
	].join("\n")),
	"Use the new prompt.\n## This heading is inside the fence",
);
assert.equal(extractPlanningPrompt("## Planning prompt for /mf-plan\n\n/mf-plan"), undefined);

// buildSpecArtifact adds only code-generated metadata around the reviewed brief.
const artifact = buildSpecArtifact({
	request: "Add dark mode\nKeep the current light theme",
	answers: [
		{ question: "Who can choose it?", area: "scope", answer: "All users." },
		{ question: "What if unanswered?", area: "UX", answer: "" },
	],
	brief: validBrief,
	createdAt: new Date("2026-04-02T23:59:00.000Z"),
});
assert.ok(artifact.startsWith("# Planning Brief\n"));
assert.match(artifact, /Generated by \/mf-spec on 2026-04-02/);
assert.match(artifact, /> Add dark mode\n> Keep the current light theme/);
assert.match(artifact, /1\. \*\*Q \(scope\):\*\* Who can choose it\?/);
assert.match(artifact, /\*\*A:\*\*\n   > All users\./);
assert.match(artifact, /   > \(no answer — use best judgment\)/);
assert.match(artifact, /`__spec\.md`/);
assert.ok(artifact.endsWith(validBrief));
const noQuestionsArtifact = buildSpecArtifact({
	request: "Add dark mode",
	answers: [],
	brief: validBrief,
	createdAt: new Date("2026-04-02T00:00:00.000Z"),
});
assert.match(noQuestionsArtifact, /_No clarifying questions were asked\._/);

const handoff = buildPlanHandoff("## Planning prompt for /mf-plan\n\nPlan the implementation and tests.", ".pi/mf-plan/dark-mode__spec.md");
assert.ok(handoff.startsWith("/mf-plan Plan the implementation and tests."));
assert.match(handoff, /Full approved planning brief: \.pi\/mf-plan\/dark-mode__spec\.md/);
assert.ok(
	buildPlanHandoff("## Request summary\nNothing else.", ".pi/mf-plan/x__spec.md").startsWith(
		"/mf-plan Plan the implementation described in the approved planning brief at .pi/mf-plan/x__spec.md.",
	),
);

// Retry tasks retain the original task, quote prior output safely, and explain the correction.
const questionRetry = buildQuestionRetryTask("original question task", 'bad """ question output');
assert.ok(questionRetry.startsWith("original question task\n\n---"));
assert.match(questionRetry, /bad '' question output/);
assert.match(questionRetry, /clarification protocol/i);
assert.match(buildQuestionRetryTask("task", "   "), /\(no output\)/);
const briefRetry = buildBriefRetryTask("original brief task", 'bad """ brief output', ["## Constraints", "## Assumptions (empty)"]);
assert.ok(briefRetry.startsWith("original brief task\n\n---"));
assert.match(briefRetry, /bad '' brief output/);
assert.match(briefRetry, /`## Constraints`/);
assert.match(briefRetry, /`## Assumptions \(empty\)`/);

console.log("spec contract tests passed.");
