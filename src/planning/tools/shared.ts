export const PLAN_MODE_READ_ONLY_TOOLS = new Set<string>([
	"read",
	"grep",
	"find",
	"ls",
	"fetch_markdown",
	"lsp",
	"memory_read",
	"memory_search",
	"memory_list",
	"web_search",
	"web_fetch",
]);

export const PLAN_MODE_CUSTOM_TOOLS = ["write_plan", "exit_plan_mode", "mf_plan_subagent", "ask_user_question"];
export const PLAN_ONLY_REGISTERED_TOOLS = ["write_plan", "exit_plan_mode", "mf_plan_subagent"];
export const PLAN_SUBAGENT_NAMES = new Set(["moa-explore", "mf-plan"]);
export const PLAN_MODE_CONTEXT_TYPE = "mf-plan-context";
export const PLAN_EXIT_CONTEXT_TYPE = "mf-plan-exit";
export const VERIFICATION_PENDING_CONTEXT_TYPE = "mf-plan-verification-pending";
