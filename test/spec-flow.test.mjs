import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// src/index.ts transitively loads overlays that use TypeScript parameter
// properties, so re-execute this file under Node's TypeScript transform.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], {
			stdio: "inherit",
		});
	} catch (error) {
		process.exit(error.status ?? 1);
	}
	process.exit(0);
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousAutoApprove = process.env.MOA_PLAN_AUTO_APPROVE;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-spec-flow-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
delete process.env.MOA_PLAN_AUTO_APPROVE;

const [{ createSpecRunner }, { default: mfPlanExtension }, { CONFIG_DIR_NAME, initTheme }] = await Promise.all([
	import("../src/spec/runSpec.ts"),
	import("../src/index.ts"),
	import("@earendil-works/pi-coding-agent"),
]);
initTheme(undefined, false);

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousAutoApprove === undefined) delete process.env.MOA_PLAN_AUTO_APPROVE;
	else process.env.MOA_PLAN_AUTO_APPROVE = previousAutoApprove;
	rmSync(tempRoot, { recursive: true, force: true });
});

const READY = "## Ready";
const QUESTION_SCOPE = [
	"## Question",
	"Should the toggle follow the operating-system preference by default?",
	"Affects: scope",
].join("\n");
const QUESTION_TESTING = [
	"## Question",
	"Which behavior must the automated tests verify?",
	"Affects: testing",
].join("\n");
const SPEC_SLUG = "add-dark-mode-toggle";

function scopedQuestion(number) {
	return `## Question\nClarifying question ${number}?\nAffects: scope`;
}

function validBrief(label = "dark mode") {
	return [
		"## Request summary",
		`Add ${label} to the application.`,
		"",
		"## User goal and motivation",
		"Users can choose a comfortable appearance.",
		"",
		"## In scope",
		"A persistent light/dark preference and visible toggle.",
		"",
		"## Out of scope",
		"No custom theme builder.",
		"",
		"## User scenarios",
		"A user changes the theme and sees the choice after restart.",
		"",
		"## Functional requirements",
		"Expose a toggle, apply the selected theme, and persist the selection.",
		"",
		"## Acceptance criteria",
		"The toggle updates the UI, survives restart, and automated tests cover both themes.",
		"",
		"## Constraints",
		"Reuse the existing settings mechanism.",
		"",
		"## Assumptions",
		"The application already has theme tokens.",
		"",
		"## Risks and unresolved questions",
		"Check contrast in both themes.",
		"",
		"## Planning prompt for /mf-plan",
		"```text",
		`Plan the implementation of ${label}, including persistence, UI behavior, and automated acceptance tests.`,
		"```",
	].join("\n");
}

function createRepo(name) {
	return mkdtempSync(path.join(tempRoot, `${name}-`));
}

function artifactDirectory(repo) {
	return path.join(repo, CONFIG_DIR_NAME, "mf-plan");
}

function artifactNames(repo) {
	const directory = artifactDirectory(repo);
	if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
	return readdirSync(directory).sort();
}

function modelResponse(text) {
	return {
		stopReason: "stop",
		content: [{ type: "text", text }],
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function createHarness(options = {}) {
	const repo = options.repo ?? createRepo("repo");
	const specReplies = [...(options.specReplies ?? [])];
	const namingReplies = [...(options.namingReplies ?? [])];
	const editorReplies = [...(options.editorReplies ?? [])];
	const selectReplies = [...(options.selectReplies ?? [])];
	const reviewDecisions = [...(options.reviewDecisions ?? [])];
	const promptReplies = [...(options.promptReplies ?? [])];
	const calls = [];
	const notifications = [];
	const editorCalls = [];
	const selectCalls = [];
	const customCalls = [];
	const insertedEditorText = [];
	let workingOverlayEscapes = options.workingOverlayEscapes ?? 0;
	const model = { provider: "fake", id: "spec-model" };
	const state = {
		questionnaireBusy: false,
		activeCancelSession: undefined,
		planMode: false,
		...(options.hostState ?? {}),
	};

	const modelRegistry = {
		find: () => undefined,
		streamSimple: (_model, context, streamOptions) => {
			const task = context.messages
				.flatMap((message) => message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			const kind = Object.hasOwn(context, "systemPrompt") ? "spec" : "naming";
			calls.push({ kind, task, context, options: streamOptions });
			const queue = kind === "spec" ? specReplies : namingReplies;
			if (queue.length === 0) throw new Error(`Unexpected ${kind} model call: ${task.slice(0, 120)}`);
			const queued = queue.shift();
			return {
				result: async () => {
					const value = typeof queued === "function" ? await queued({ task, context, options: streamOptions }) : queued;
					if (value instanceof Error) throw value;
					if (value && typeof value === "object" && "stopReason" in value) return value;
					return modelResponse(String(value));
				},
			};
		},
	};

	const theme = {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
	};
	const tui = { requestRender: () => {} };
	const ui = {
		notify: (message, level) => { notifications.push({ message, level }); },
		setStatus: () => {},
		theme,
		editor: async (title, prefill) => {
			editorCalls.push({ title, prefill });
			if (editorReplies.length === 0) throw new Error(`Unexpected editor: ${title}`);
			const queued = editorReplies.shift();
			return typeof queued === "function" ? queued({ title, prefill }) : queued;
		},
		select: async (title, choices) => {
			selectCalls.push({ title, choices });
			if (selectReplies.length === 0) throw new Error(`Unexpected select: ${title}`);
			const queued = selectReplies.shift();
			return typeof queued === "function" ? queued({ title, choices }) : queued;
		},
		custom: async (factory, customOptions) => new Promise((resolve, reject) => {
			let component;
			let finished = false;
			const done = (value) => {
				if (finished) return;
				finished = true;
				try {
					component?.dispose?.();
				} finally {
					resolve(value);
				}
			};
			try {
				component = factory(tui, theme, {}, done);
				const name = component?.constructor?.name ?? "UnknownComponent";
				customCalls.push({ name, component, options: customOptions });
				if (name === "PlanReviewOverlay") {
					if (reviewDecisions.length === 0) throw new Error("Unexpected planning brief review");
					const decision = reviewDecisions.shift();
					if (decision === "force-chat") {
						done("chat");
					} else {
						const key = { approve: "a", keep: "q", edit: "e", chat: "c" }[decision];
						if (!key) throw new Error(`Unknown review decision: ${decision}`);
						component.handleInput(key);
					}
				} else if (name === "PromptEditorComponent") {
					if (promptReplies.length === 0) throw new Error("Unexpected prompt editor");
					done(promptReplies.shift());
				} else if (name === "WorkingOverlayComponent" && workingOverlayEscapes > 0) {
					workingOverlayEscapes--;
					component.handleInput("\x1b");
				} else if (name !== "WorkingOverlayComponent") {
					throw new Error(`Unexpected custom component: ${name}`);
				}
			} catch (error) {
				reject(error);
			}
		}),
		getEditorText: () => options.existingEditorText ?? "",
		setEditorText: (text) => { insertedEditorText.push(text); },
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		cwd: repo,
		model,
		modelRegistry,
		ui,
	};
	const host = {
		currentThinkingLevel: () => options.thinking ?? "medium",
		getActiveCancelSession: () => state.activeCancelSession,
		isEnabled: () => state.planMode,
		questionnaireBusy: (guardCtx) => {
			if (!state.questionnaireBusy) return false;
			guardCtx.ui.notify("Answer or dismiss the ask_user_question questionnaire first.", "warning");
			return true;
		},
	};

	return {
		repo,
		ctx,
		host,
		state,
		calls,
		notifications,
		editorCalls,
		selectCalls,
		customCalls,
		insertedEditorText,
		remaining: { specReplies, namingReplies, editorReplies, selectReplies, reviewDecisions, promptReplies },
	};
}

function messages(harness) {
	return harness.notifications.map(({ message }) => message).join("\n");
}

async function run(harness, request = "Add dark mode toggle") {
	const runner = createSpecRunner(harness.host);
	await runner(harness.ctx, request);
	return runner;
}

test("normal flow asks adaptive questions, saves only the reviewed spec, and prefills /mf-plan", async () => {
	const harness = createHarness({
		specReplies: [QUESTION_SCOPE, QUESTION_TESTING, READY, validBrief()],
		namingReplies: ["add dark mode toggle"],
		editorReplies: ["Follow the operating system.", "Theme persistence and both visual states."],
		reviewDecisions: ["approve"],
	});

	await run(harness);

	const specCalls = harness.calls.filter(({ kind }) => kind === "spec");
	assert.equal(specCalls.length, 4, "two questions, Ready, and one brief should be requested");
	assert.equal(harness.calls.filter(({ kind }) => kind === "naming").length, 1);
	assert.match(specCalls[1].task, /Follow the operating system\./);
	assert.match(specCalls[2].task, /Theme persistence and both visual states\./);
	assert.match(specCalls[3].task, /Follow the operating system\./);
	assert.match(specCalls[3].task, /Theme persistence and both visual states\./);

	const review = harness.customCalls.find(({ name }) => name === "PlanReviewOverlay");
	assert.ok(review, "the planning brief review should open");
	const reviewedArtifact = review.component.planMarkdown;
	const specPath = path.join(artifactDirectory(harness.repo), `${SPEC_SLUG}__spec.md`);
	assert.equal(readFileSync(specPath, "utf8"), reviewedArtifact);
	assert.match(reviewedArtifact, /Follow the operating system\./);
	assert.match(reviewedArtifact, /Theme persistence and both visual states\./);
	assert.deepEqual(artifactNames(harness.repo), [`${SPEC_SLUG}__spec.md`]);
	assert.equal(artifactNames(harness.repo).some((name) => name.endsWith("__plan.md")), false);
	assert.equal(harness.insertedEditorText.length, 1);
	assert.match(harness.insertedEditorText[0], /^\/mf-plan /);
	assert.match(harness.insertedEditorText[0], new RegExp(`${SPEC_SLUG}__spec\\.md`));
	assert.match(messages(harness), new RegExp(`Planning brief saved to .*${SPEC_SLUG}__spec\\.md`));
	assert.deepEqual(harness.remaining, {
		specReplies: [], namingReplies: [], editorReplies: [], selectReplies: [], reviewDecisions: [], promptReplies: [],
	});
});

test("empty or cancelled request input ends before any model call", async () => {
	for (const input of [undefined, "   "]) {
		const harness = createHarness({ promptReplies: [input] });
		await createSpecRunner(harness.host)(harness.ctx, undefined);
		assert.equal(harness.calls.length, 0);
		assert.deepEqual(artifactNames(harness.repo), []);
		assert.match(messages(harness), /Spec cancelled\./);
	}
});

test("cancellation from a clarifying question and from review writes nothing", async () => {
	const interrupted = createHarness({
		specReplies: [QUESTION_SCOPE],
		editorReplies: [undefined],
		selectReplies: ["Cancel /mf-spec — nothing is saved"],
	});
	await run(interrupted);
	assert.equal(interrupted.calls.length, 1, "cancelling at a question must not draft or name a brief");
	assert.deepEqual(artifactNames(interrupted.repo), []);
	assert.match(messages(interrupted), /Spec cancelled\./);

	const discarded = createHarness({
		specReplies: [READY, validBrief()],
		reviewDecisions: ["keep"],
		selectReplies: ["Discard — nothing is saved"],
	});
	await run(discarded);
	assert.equal(discarded.calls.filter(({ kind }) => kind === "naming").length, 0);
	assert.deepEqual(artifactNames(discarded.repo), []);
	assert.match(messages(discarded), /Planning brief discarded — nothing saved\./);
});

test("Esc on a question can draft with earlier answers", async () => {
	const harness = createHarness({
		specReplies: [QUESTION_SCOPE, QUESTION_TESTING, validBrief()],
		editorReplies: ["Follow the operating system.", undefined],
		selectReplies: ["Draft the brief with the answers so far"],
		reviewDecisions: ["approve"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	const briefCall = harness.calls.filter(({ kind }) => kind === "spec").at(-1);
	assert.match(briefCall.task, /Follow the operating system\./);
	assert.doesNotMatch(briefCall.task, /Theme persistence and both visual states/);
	assert.ok(existsSync(path.join(artifactDirectory(harness.repo), `${SPEC_SLUG}__spec.md`)));
});

test("Esc during drafting can cancel or retry the draft", async () => {
	const abortOnSignal = ({ options }) => new Promise((resolve) => {
		options.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }), { once: true });
	});
	const cancelled = createHarness({
		specReplies: [READY, abortOnSignal],
		workingOverlayEscapes: 1,
		selectReplies: ["Cancel /mf-spec — nothing is saved"],
	});
	await run(cancelled);
	assert.deepEqual(artifactNames(cancelled.repo), []);
	assert.equal(cancelled.selectCalls[0].title, "The brief was not drafted");

	const retried = createHarness({
		specReplies: [READY, abortOnSignal, validBrief()],
		workingOverlayEscapes: 1,
		selectReplies: ["Try drafting again"],
		reviewDecisions: ["approve"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(retried);
	assert.equal(retried.calls.filter(({ kind, task }) => kind === "spec" && /Write the Markdown body/.test(task)).length, 2);
	assert.ok(existsSync(path.join(artifactDirectory(retried.repo), `${SPEC_SLUG}__spec.md`)));
});

test("an empty answer is recorded and counts toward the five-question cap", async () => {
	const harness = createHarness({
		specReplies: [scopedQuestion(1), scopedQuestion(2), scopedQuestion(3), scopedQuestion(4), scopedQuestion(5), validBrief()],
		editorReplies: ["", "two", "three", "four", "five"],
		reviewDecisions: ["approve"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	const questionCalls = harness.calls.filter(({ kind, task }) => kind === "spec" && /Choose the next clarification step/.test(task));
	assert.equal(questionCalls.length, 5);
	const draftTask = harness.calls.filter(({ kind, task }) => kind === "spec" && /Write the Markdown body/.test(task))[0].task;
	assert.match(draftTask, /\(no answer — use best judgment\)/);
	assert.match(draftTask, /Clarifying question 5\?/);
});

test("the interview stops after five questions without making a sixth question call", async () => {
	const harness = createHarness({
		specReplies: [scopedQuestion(1), scopedQuestion(2), scopedQuestion(3), scopedQuestion(4), scopedQuestion(5), validBrief()],
		editorReplies: ["one", "two", "three", "four", "five"],
		reviewDecisions: ["approve"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	const questionCalls = harness.calls.filter(({ kind, task }) => kind === "spec" && /Choose the next clarification step/.test(task));
	assert.equal(questionCalls.length, 5);
	const draftTask = harness.calls.filter(({ kind, task }) => kind === "spec" && /Write the Markdown body/.test(task))[0].task;
	for (let index = 1; index <= 5; index++) assert.match(draftTask, new RegExp(`Clarifying question ${index}\\?`));
});

test("a repeated identical question ends the interview", async () => {
	const harness = createHarness({
		specReplies: [QUESTION_SCOPE, QUESTION_SCOPE, validBrief()],
		editorReplies: ["Follow the operating system."],
		reviewDecisions: ["approve"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	assert.equal(harness.calls.filter(({ kind, task }) => kind === "spec" && /Choose the next clarification step/.test(task)).length, 2);
	assert.equal(harness.editorCalls.length, 1);
});

test("closing review can return to the brief and then approve", async () => {
	const harness = createHarness({
		specReplies: [READY, validBrief()],
		reviewDecisions: ["keep", "approve"],
		selectReplies: ["Back to the brief"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	assert.equal(harness.customCalls.filter(({ name }) => name === "PlanReviewOverlay").length, 2);
	assert.ok(existsSync(path.join(artifactDirectory(harness.repo), `${SPEC_SLUG}__spec.md`)));
});

test("editing the brief warns about missing sections and saves the exact edit", async () => {
	const edited = validBrief().replace(/## Constraints\nReuse the existing settings mechanism\.\n\n/, "");
	const harness = createHarness({
		specReplies: [READY, validBrief()],
		reviewDecisions: ["edit", "approve"],
		editorReplies: [edited],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	assert.match(messages(harness), /Brief is missing: ## Constraints/);
	assert.equal(readFileSync(path.join(artifactDirectory(harness.repo), `${SPEC_SLUG}__spec.md`), "utf8"), edited);
});

test("revision feedback includes the previous brief and stops after three rounds", async () => {
	const harness = createHarness({
		specReplies: [READY, validBrief("initial"), validBrief("revision one"), validBrief("revision two"), validBrief("revision three")],
		reviewDecisions: ["chat", "chat", "chat", "force-chat", "approve"],
		promptReplies: ["First feedback", "Second feedback", "Third feedback"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	const revisionCalls = harness.calls.filter(({ kind, task }) => kind === "spec" && /Revise the existing planning brief/.test(task));
	assert.equal(revisionCalls.length, 3);
	assert.match(revisionCalls[0].task, /First feedback/);
	assert.match(revisionCalls[0].task, /Add initial to the application/);
	const reviews = harness.customCalls.filter(({ name }) => name === "PlanReviewOverlay");
	assert.equal(reviews[3].component.allowChat, false);
	assert.match(messages(harness), /Maximum planning brief revision rounds reached/);
});

test("malformed question output retries once, warns, and drafts", async () => {
	const harness = createHarness({
		specReplies: ["plain prose", "still plain prose", validBrief()],
		reviewDecisions: ["approve"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	assert.equal(harness.calls.filter(({ kind, task }) => kind === "spec" && /Choose the next clarification step/.test(task)).length, 2);
	assert.match(messages(harness), /Could not get a clarifying question: malformed reply/);
});

test("a malformed brief retries once and can recover", async () => {
	const harness = createHarness({
		specReplies: [READY, "not a brief", validBrief()],
		reviewDecisions: ["approve"],
		namingReplies: ["add dark mode toggle"],
	});
	await run(harness);
	const draftCalls = harness.calls.filter(({ kind, task }) => kind === "spec" && /Write the Markdown body/.test(task));
	assert.equal(draftCalls.length, 2);
	assert.match(draftCalls[1].task, /Missing or empty section/);
	assert.doesNotMatch(messages(harness), /Brief is missing:/);
});

test("a brief malformed twice still opens review with a warning", async () => {
	const harness = createHarness({
		specReplies: [READY, "not a brief", "still not a brief"],
		reviewDecisions: ["keep"],
		selectReplies: ["Discard — nothing is saved"],
	});
	await run(harness);
	assert.ok(harness.customCalls.some(({ name }) => name === "PlanReviewOverlay"));
	assert.match(messages(harness), /Brief is missing: ## Request summary/);
});

test("a model throw during drafting enters the draft-failed menu", async () => {
	const harness = createHarness({
		specReplies: [READY, new Error("provider failed")],
		selectReplies: ["Cancel /mf-spec — nothing is saved"],
	});
	await run(harness);
	assert.match(messages(harness), /The brief could not be drafted: provider failed/);
	assert.equal(harness.selectCalls[0].title, "The brief was not drafted");
	assert.deepEqual(artifactNames(harness.repo), []);
});

test("headless mode refuses without a request or opt-in and saves a valid brief with explicit opt-in", async () => {
	delete process.env.MOA_PLAN_AUTO_APPROVE;
	const missingRequest = createHarness({ hasUI: false, mode: "rpc" });
	await createSpecRunner(missingRequest.host)(missingRequest.ctx, undefined);
	assert.equal(missingRequest.calls.length, 0);
	assert.deepEqual(artifactNames(missingRequest.repo), []);
	assert.match(messages(missingRequest), /needs a request argument in non-interactive mode/);

	const refused = createHarness({ hasUI: false, mode: "rpc" });
	await run(refused);
	assert.equal(refused.calls.length, 0);
	assert.deepEqual(artifactNames(refused.repo), []);
	assert.match(messages(refused), /cannot get approval in non-interactive mode/);

	process.env.MOA_PLAN_AUTO_APPROVE = "1";
	try {
		const approved = createHarness({
			hasUI: false,
			mode: "rpc",
			specReplies: [validBrief()],
		});
		await run(approved);
		assert.equal(approved.calls.length, 1, "headless naming must be deterministic and use no naming model call");
		assert.equal(approved.calls[0].kind, "spec");
		assert.deepEqual(artifactNames(approved.repo), [`${SPEC_SLUG}__spec.md`]);
		assert.match(messages(approved), /^Planning brief saved to /);
		assert.match(messages(approved), /\/mf-plan /);
	} finally {
		delete process.env.MOA_PLAN_AUTO_APPROVE;
	}
});

test("headless mode never saves a brief that remains malformed after retry", async () => {
	process.env.MOA_PLAN_AUTO_APPROVE = "1";
	try {
		const harness = createHarness({
			hasUI: false,
			mode: "rpc",
			specReplies: ["not a planning brief", "still malformed"],
		});
		await run(harness);
		assert.equal(harness.calls.length, 2);
		assert.deepEqual(artifactNames(harness.repo), []);
		assert.match(messages(harness), /The brief could not be generated .*nothing saved\./);
	} finally {
		delete process.env.MOA_PLAN_AUTO_APPROVE;
	}
});

test("entry guards stop before every model call", async () => {
	const cases = [
		{
			name: "questionnaire",
			state: { questionnaireBusy: true },
			expected: /questionnaire first/,
		},
		{
			name: "active MoA run",
			state: { activeCancelSession: { run: {} } },
			expected: /An MoA run is in progress\./,
		},
		{
			name: "plan mode",
			state: { planMode: true },
			expected: /Plan mode is active\./,
		},
	];
	for (const guard of cases) {
		const harness = createHarness({ hostState: guard.state });
		await run(harness);
		assert.equal(harness.calls.length, 0, `${guard.name} guard made a model call`);
		assert.deepEqual(artifactNames(harness.repo), []);
		assert.match(messages(harness), guard.expected);
	}
});

test("a second invocation is refused while the first /mf-spec session is awaiting an answer", async () => {
	const editorReached = deferred();
	const answer = deferred();
	const harness = createHarness({
		specReplies: [QUESTION_SCOPE],
		editorReplies: [() => {
			editorReached.resolve();
			return answer.promise;
		}],
		selectReplies: ["Cancel /mf-spec — nothing is saved"],
	});
	const runner = createSpecRunner(harness.host);
	const first = runner(harness.ctx, "First request");
	await editorReached.promise;
	await runner(harness.ctx, "Second request");
	assert.match(messages(harness), /A \/mf-spec session is already open\./);
	assert.equal(harness.calls.length, 1);
	answer.resolve(undefined);
	await first;
	assert.deepEqual(artifactNames(harness.repo), []);
});

test("an existing spec is preserved and the approved brief uses the next free slug", async () => {
	const repo = createRepo("collision");
	mkdirSync(artifactDirectory(repo), { recursive: true });
	const originalPath = path.join(artifactDirectory(repo), `${SPEC_SLUG}__spec.md`);
	writeFileSync(originalPath, "original bytes", "utf8");
	const harness = createHarness({
		repo,
		specReplies: [READY, validBrief()],
		namingReplies: ["add dark mode toggle"],
		reviewDecisions: ["approve"],
	});

	await run(harness);

	assert.equal(readFileSync(originalPath, "utf8"), "original bytes");
	const collisionPath = path.join(artifactDirectory(repo), "add-dark-mode-toggle-2__spec.md");
	assert.ok(existsSync(collisionPath));
	assert.match(readFileSync(collisionPath, "utf8"), /^# Planning Brief/);
	assert.deepEqual(artifactNames(repo), [`${SPEC_SLUG}-2__spec.md`, `${SPEC_SLUG}__spec.md`]);
	assert.match(harness.insertedEditorText[0], new RegExp(`${SPEC_SLUG}-2__spec\\.md`));
});

test("a non-empty TUI input box is never overwritten", async () => {
	const harness = createHarness({
		specReplies: [READY, validBrief()],
		namingReplies: ["add dark mode toggle"],
		reviewDecisions: ["approve"],
		existingEditorText: "draft command",
	});
	await run(harness);
	assert.deepEqual(harness.insertedEditorText, []);
	assert.ok(existsSync(path.join(artifactDirectory(harness.repo), `${SPEC_SLUG}__spec.md`)));
	assert.match(messages(harness), /input box isn't empty, so the \/mf-plan prompt wasn't inserted/);
});

test("RPC review requires explicit approval, saves the edit, and returns the handoff by notification", async () => {
	const rpcEdit = validBrief("an RPC-reviewed dark mode");
	const harness = createHarness({
		mode: "rpc",
		specReplies: [READY, validBrief()],
		namingReplies: ["add dark mode toggle"],
		editorReplies: [rpcEdit],
		selectReplies: ["Approve — save the brief"],
	});
	await run(harness);
	const saved = readFileSync(path.join(artifactDirectory(harness.repo), `${SPEC_SLUG}__spec.md`), "utf8");
	assert.equal(saved, rpcEdit, "the text submitted in RPC review must be the exact saved artifact");
	assert.deepEqual(harness.insertedEditorText, []);
	assert.equal(harness.customCalls.length, 0, "RPC mode must not open the TUI review overlay");
	assert.match(messages(harness), /\/mf-plan /);
	assert.match(messages(harness), new RegExp(`${SPEC_SLUG}__spec\\.md`));
});

test("save failure is reported and Discard exits without a false success", async () => {
	const repo = createRepo("save-failure");
	mkdirSync(path.join(repo, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(artifactDirectory(repo), "not a directory", "utf8");
	const harness = createHarness({
		repo,
		specReplies: [READY, validBrief()],
		namingReplies: ["add dark mode toggle"],
		reviewDecisions: ["approve"],
		selectReplies: ["Discard"],
	});

	await run(harness);

	assert.match(messages(harness), /Could not save the planning brief:/);
	assert.doesNotMatch(messages(harness), /Planning brief saved to/);
	assert.equal(harness.selectCalls.length, 1);
	assert.equal(harness.selectCalls[0].title, "The planning brief was not saved");
	assert.deepEqual(harness.selectCalls[0].choices, ["Retry saving", "Open the brief in an editor to copy it", "Discard"]);
	assert.equal(readFileSync(artifactDirectory(repo), "utf8"), "not a directory");
});

test("opening a failed save to copy it returns to the failure menu without reporting success", async () => {
	const repo = createRepo("copy-after-save-failure");
	mkdirSync(path.join(repo, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(artifactDirectory(repo), "not a directory", "utf8");
	const harness = createHarness({
		repo,
		specReplies: [READY, validBrief()],
		namingReplies: ["add dark mode toggle"],
		reviewDecisions: ["approve"],
		editorReplies: [undefined],
		selectReplies: ["Open the brief in an editor to copy it", "Discard"],
	});

	await run(harness);

	assert.equal(harness.selectCalls.length, 2);
	assert.deepEqual(harness.remaining.namingReplies, []);
	assert.deepEqual(harness.insertedEditorText, []);
	assert.doesNotMatch(messages(harness), /Planning brief saved to/);
});

test("the extension registers mf-spec with a callable handler", () => {
	const commands = new Map();
	const tools = new Map();
	let activeTools = ["read", "write"];
	const fakePi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "write" }],
		getActiveTools: () => activeTools,
		setActiveTools: (names) => { activeTools = names; },
		appendEntry: () => {},
		registerFlag: () => {},
		registerCommand: (name, command) => { commands.set(name, command); },
		registerShortcut: () => {},
		registerTool: (tool) => { tools.set(tool.name, tool); },
		on: () => {},
		getFlag: () => false,
		events: { on: () => () => {}, emit: () => {} },
	};

	mfPlanExtension(fakePi);

	assert.equal(typeof commands.get("mf-spec")?.handler, "function");
	assert.match(commands.get("mf-spec").description, /approved planning brief/);
});
