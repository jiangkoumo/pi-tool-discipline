/**
 * pi-tool-discipline
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
 * How it works:
 *   A. Registers placeholder tools named `grep` / `find` / `ls` (skipped when
 *      already registered). They carry no promptSnippet, so they never appear
 *      in the model's tool list and are never actually callable in practice.
 *      Their presence flips pi's hasGrep/hasFind/hasLs check, so the
 *      conflicting bash guideline is never generated.
 *   B. On before_agent_start, appends the tool-discipline rules to the system
 *      prompt (idempotent) and strips the bash guideline text as a fallback
 *      for environments where the placeholder registration is disabled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MARK = "<!-- pi-tool-discipline:v1 -->";

/** Placeholder tool names that flip pi's hasGrep/hasFind/hasLs checks. */
const PLACEHOLDER_NAMES = ["grep", "find", "ls"] as const;

/**
 * The exact guidelines pi's builder injects when no search tool is active.
 * Stripped from the system prompt as a fallback (plan B).
 */
const BASH_GUIDELINES = [
	"Use bash for file operations like ls, rg, find",
	"Use bash or PowerShell for file operations like listing, searching, and finding files",
	"Use PowerShell for file operations like listing, searching, and finding files",
];

const DISCIPLINE = `
## Tool Discipline (pi-tool-discipline)

Tool priority for search (always use the highest available):

- Content search: ffgrep (tool) > rg (bash) > grep (bash)
- Path search: fffind (tool) > find (bash)

Rules:

- Search and read files ONLY with dedicated tools, never with bash commands.
- ffgrep/fffind work with absolute paths outside the workspace (separate index), and ffgrep supports regex, path and exclude filters. If a search seems to miss something, adjust its parameters (path, exclude, regex, caseSensitive) — do NOT fall back to bash \`grep\`/\`rg\`/\`find\`/\`ls\`.
- Read files with \`read\` (use \`offset\`/\`limit\` for large files); never use bash \`cat\`/\`head\`/\`tail\`/\`sed\` to read.
- Do NOT use the bash tool for \`grep\`/\`rg\`/\`find\`/\`ls\`/\`cat\`/\`sed\`/\`head\`/\`tail\`/\`which\` searches or file reads.
- Bash stays allowed only when dedicated tools cannot do the job: pipelines, git, npm, running programs, network requests, file mutations.
- If bash searching is truly unavoidable, prefer \`rg\` over \`grep\`.`;

function stripBashGuidelines(prompt: string): string {
	let out = prompt;
	for (const guideline of BASH_GUIDELINES) {
		out = out.replaceAll(guideline, "Use ffgrep/fffind for file operations like ls, rg, find");
	}
	return out;
}

export default function toolDiscipline(pi: ExtensionAPI) {
	// A. Register placeholder search tools so pi stops generating the bash guideline.
	// Done in session_start: action methods (getAllTools/registerTool) are not
	// available during extension loading, and tools registered here are
	// refreshed into the session (and system prompt) immediately.
	pi.on("session_start", () => {
		const existing = new Set(pi.getAllTools().map((t) => t.name));
		for (const name of PLACEHOLDER_NAMES) {
			if (existing.has(name)) continue; // already present — the check already passes
			pi.registerTool({
			name,
			label: `${name} (placeholder)`,
			description:
				`Placeholder tool registered by pi-tool-discipline so pi knows a ${name} tool exists ` +
				`and does not inject its default "use bash for file operations" guideline. ` +
				`Do not call this tool — use ffgrep for content search and fffind for path search instead.`,
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [
						{
							type: "text",
							text: "This placeholder tool has no implementation. Use ffgrep for content search and fffind for path search instead.",
						},
					],
					details: { placeholder: true },
				};
			},
		});
	}
	});

	// B. Inject the discipline into the system prompt (idempotent per turn).
	pi.on("before_agent_start", async (event) => {
		const { systemPrompt } = event;
		if (systemPrompt.includes(MARK)) return; // already injected
		const prompt = stripBashGuidelines(systemPrompt);
		return { systemPrompt: `${prompt}\n${MARK}\n${DISCIPLINE}` };
	});

	// Status command: /tool-discipline — verify placeholder tools and injection.
	pi.registerCommand("tool-discipline", {
		description: "Show pi-tool-discipline status (placeholder tools + injected guideline)",
		handler: async (_args, ctx) => {
			const tools = pi.getAllTools().map((t) => t.name);
			const placeholders = PLACEHOLDER_NAMES.filter((n) => tools.includes(n));
			const injected = ctx.getSystemPrompt().includes(MARK);
			ctx.ui.notify(
				`pi-tool-discipline\n` +
					`placeholder tools: ${placeholders.length > 0 ? placeholders.join(", ") : "(none)"}\n` +
					`discipline injected: ${injected ? "yes" : "no"}`,
				"info",
			);
		},
	});
}
