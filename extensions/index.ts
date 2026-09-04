/**
 * pi-tool-discipline (slim)
 *
 * Enforces a "search tools first" file-search discipline in pi sessions and
 * neutralizes the built-in "Use bash for file operations like ls, rg, find"
 * guideline that conflicts with project instructions (e.g. AGENTS.md).
 *
 * Why it exists:
 *   pi only injects the bash file-operation guideline when NO tool named
 *   `grep` / `find` / `ls` is active (dist/core/system-prompt.js). FFF-style
 *   search tools are named `ffgrep` / `fffind`, so pi mistakenly thinks no
 *   search tool exists and tells the model to use bash — fighting AGENTS.md
 *   rules that say to use the grep tool instead.
 *
 * How it works (prompt-level only — no bash interception):
 *   A. Ensures pi's built-in `grep` / `find` / `ls` tools are ACTIVE in the
 *      session (pi 0.84+ ships real definitions via createAllToolDefinitions
 *      but only activates read/bash/edit/write by default). Activating them
 *      flips pi's hasGrep/hasFind/hasLs check, so the conflicting bash
 *      guideline is never generated and the model always has search tools.
 *   B. On before_agent_start, appends the tool-discipline rules to the system
 *      prompt (idempotent) and strips the bash guideline text as a fallback.
 *
 * No runtime tool_call interception: behavior is guided at the prompt level,
 * which means no shell-command parsing and no risk of parser hangs. Requires
 * pi >= 0.84 for the built-in grep/find/ls definitions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripBashGuidelines } from "./strip.js";

const MARK = "<!-- pi-tool-discipline:v1 -->";

/** Tool names that flip pi's hasGrep/hasFind/hasLs checks. */
const SEARCH_TOOLS = ["grep", "find", "ls"] as const;

/** FFF search tools that indicate pi-fff (or equivalent) is installed. */
const FFF_TOOLS = ["ffgrep", "fffind"];

const DISCIPLINE = `
## Tool Discipline (pi-tool-discipline)

Search tool priority:

1. ffgrep / fffind (from @ff-labs/pi-fff) — always preferred. They work with absolute paths outside the workspace and support regex / path / exclude filters.
2. Without pi-fff, use the grep / find / ls TOOLS (Pi built-ins on pi 0.84+). Fill their parameters according to each tool's declared schema — built-in grep uses ignoreCase/limit, built-in find uses a glob pattern. Never fall back to bash's grep or find.
3. Never run bash \`grep\` or \`find\`. Never use bash \`ls\`/\`cat\`/\`head\`/\`tail\`/\`sed\`/\`which\` directly for searching or reading — use ffgrep / fffind / read (or the grep/find/ls tools) instead.
4. Read files with \`read\` (offset/limit for large files).
5. Bash stays allowed only when dedicated tools cannot do the job: pipelines, git, npm, running programs, network requests, file mutations.
6. If bash searching is truly unavoidable, use \`rg\` (never \`grep\`).`;

export default function toolDiscipline(pi: ExtensionAPI) {
	// A. Activate pi's built-in search tools so pi stops generating the bash
	// guideline. Done in session_start: action methods (setActiveTools) are
	// not available during extension loading, and tools activated here are
	// refreshed into the session (and system prompt) immediately.
	pi.on("session_start", () => {
		const all = new Set(pi.getAllTools().map((t) => t.name));
		const active = new Set(pi.getActiveTools());
		const toActivate = SEARCH_TOOLS.filter((name) => all.has(name) && !active.has(name));
		if (toActivate.length > 0) {
			// setActiveTools rebuilds the system prompt immediately.
			pi.setActiveTools([...active, ...toActivate]);
		}
	});

	// B. Inject the discipline into the system prompt (idempotent per turn).
	pi.on("before_agent_start", async (event) => {
		const { systemPrompt } = event;
		if (systemPrompt.includes(MARK)) return; // already injected
		const prompt = stripBashGuidelines(systemPrompt);
		return { systemPrompt: `${prompt}\n${MARK}\n${DISCIPLINE}` };
	});

	// Status command: /tool-discipline — verify tool activation and injection.
	pi.registerCommand("tool-discipline", {
		description: "Show pi-tool-discipline status (tools + injected guideline)",
		handler: async (_args, ctx) => {
			const all = new Set(pi.getAllTools().map((t) => t.name));
			const active = new Set(pi.getActiveTools());
			const fff = FFF_TOOLS.filter((name) => active.has(name));
			const registered = SEARCH_TOOLS.filter((n) => all.has(n));
			const activeTools = SEARCH_TOOLS.filter((n) => active.has(n));
			const injected = ctx.getSystemPrompt().includes(MARK);
			ctx.ui.notify(
				`pi-tool-discipline\n` +
					`fff active: ${fff.length > 0 ? fff.join(", ") : "(none)"}\n` +
					`grep/find/ls defined: ${registered.length > 0 ? registered.join(", ") : "(none)"}\n` +
					`grep/find/ls active: ${activeTools.length > 0 ? activeTools.join(", ") : "(none)"}\n` +
					`discipline injected: ${injected ? "yes" : "no"}`,
				"info",
			);
		},
	});
}
