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
 *   A. Registers working search tools named `grep` / `find` / `ls` (skipped
 *      when already registered). Their presence flips pi's hasGrep/hasFind/
 *      hasLs check, so the conflicting bash guideline is never generated.
 *      Each tool is always functional (fs-based, see search.ts); visibility
 *      is toggled via promptSnippet — hidden while its FFF counterpart
 *      (ffgrep / fffind) is active, visible as a fallback when it is not.
 *   B. On before_agent_start, appends the tool-discipline rules to the system
 *      prompt (idempotent) and strips the bash guideline text as a fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { grepFiles, findFiles, listDir, grepSchema, findSchema, lsSchema } from "./search.js";

const MARK = "<!-- pi-tool-discipline:v1 -->";

/** Tool names that flip pi's hasGrep/hasFind/hasLs checks. */
const PLACEHOLDER_NAMES = ["grep", "find", "ls"] as const;

/** FFF search tools that indicate pi-fff (or equivalent) is installed. */
const FFF_TOOLS = ["ffgrep", "fffind"];

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

Search tool priority:

1. ffgrep / fffind (from @ff-labs/pi-fff) — always preferred. They work with absolute paths outside the workspace and support regex / path / exclude filters.
2. Without pi-fff, use the grep / find / ls TOOLS (fallbacks provided by this extension). If a search seems to miss something, adjust its parameters (path, caseSensitive, maxResults) — never fall back to bash's grep or find.
3. Never run bash \`grep\` or \`find\`. Never use bash \`ls\`/\`cat\`/\`head\`/\`tail\`/\`sed\`/\`which\` directly for searching or reading — use ffgrep / fffind / read (or the grep/find/ls fallback tools) instead.
4. Read files with \`read\` (offset/limit for large files).
5. Bash stays allowed only when dedicated tools cannot do the job: pipelines, git, npm, running programs, network requests, file mutations.
6. If bash searching is truly unavoidable, use \`rg\` (never \`grep\`).`;

interface FallbackTool {
	label: string;
	description: string;
	snippet: string;
	parameters: ReturnType<typeof Type.Object>;
	execute: (params: any, cwd: string) => string;
}

const FALLBACK_TOOLS: Record<string, FallbackTool> = {
	grep: {
		label: "grep (fallback)",
		description:
			"Search file contents for a text pattern. Fallback for environments without ffgrep; prefer ffgrep when available.",
		snippet: "Search file contents (fallback when ffgrep is unavailable)",
		parameters: grepSchema,
		execute: (params, cwd) => grepFiles({ ...params, cwd }),
	},
	find: {
		label: "find (fallback)",
		description:
			"Find files by path/name substring. Fallback for environments without fffind; prefer fffind when available.",
		snippet: "Find files by path/name (fallback when fffind is unavailable)",
		parameters: findSchema,
		execute: (params, cwd) => findFiles({ ...params, cwd }),
	},
	ls: {
		label: "ls (fallback)",
		description:
			"List directory entries. Fallback for environments without fffind; prefer fffind when available.",
		snippet: "List directory entries (fallback when fffind is unavailable)",
		parameters: lsSchema,
		execute: (params, cwd) => listDir({ ...params, cwd }),
	},
};

function stripBashGuidelines(prompt: string): string {
	let out = prompt;
	for (const guideline of BASH_GUIDELINES) {
		out = out.replaceAll(guideline, "Use ffgrep/fffind for file operations like ls, rg, find");
	}
	return out;
}

export default function toolDiscipline(pi: ExtensionAPI) {
	// A. Register search-tool names so pi stops generating the bash guideline.
	// Done in session_start: action methods (getAllTools/registerTool) are not
	// available during extension loading, and tools registered here are
	// refreshed into the session (and system prompt) immediately.
	pi.on("session_start", (event, ctx) => {
		const all = new Set(pi.getAllTools().map((t) => t.name));
		// Use ACTIVE tools (respects --exclude-tools / allowed lists), not the
		// full registry: getAllTools() still reports excluded tools.
		const active = new Set(pi.getActiveTools());
		// Decide per capability so partial FFF availability (e.g. only ffgrep
		// active) still leaves a real fallback for the missing side.
		const hasFfgrep = active.has("ffgrep");
		const hasFffind = active.has("fffind");
		let registeredAny = false;
		// All three names always get a WORKING implementation (no inert
		// placeholders — a refreshed tool can be called by the model, so an
		// empty implementation would be a trap). Visibility toggles via
		// promptSnippet: hidden when the FFF counterpart is active, visible
		// (with a fallback hint) when it is not.
		const registerSearchTool = (name: string, fffActive: boolean) => {
			if (all.has(name)) return; // already registered by another extension
			const fallback = FALLBACK_TOOLS[name];
			pi.registerTool({
				name,
				label: fallback.label,
				description: fallback.description,
				promptSnippet: fffActive ? undefined : fallback.snippet,
				promptGuidelines: [
					"Use ffgrep/fffind when they are available; grep/find/ls are fallbacks only for environments without pi-fff.",
				],
				parameters: fallback.parameters,
				async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
					const text = fallback.execute(params ?? {}, execCtx.cwd);
					return {
						content: [{ type: "text", text }],
						details: { fallback: true },
					};
				},
			});
			registeredAny = true;
		};
		registerSearchTool("grep", hasFfgrep);
		registerSearchTool("find", hasFffind);
		registerSearchTool("ls", hasFffind);
		// Tools registered in session_start do not enter selectedTools until the
		// registry is refreshed. Without this, pi keeps injecting the bash
		// guideline (verified empirically on pi 0.84.4). refreshTools exists at
		// runtime (ExtensionActions) but is not declared on ExtensionAPI's type.
		// Known limitation: with peer version "*", other pi versions may differ.
		if (registeredAny) (pi as unknown as { refreshTools: () => void }).refreshTools();
	});

	// B. Inject the discipline into the system prompt (idempotent per turn).
	pi.on("before_agent_start", async (event) => {
		const { systemPrompt } = event;
		if (systemPrompt.includes(MARK)) return; // already injected
		const prompt = stripBashGuidelines(systemPrompt);
		return { systemPrompt: `${prompt}\n${MARK}\n${DISCIPLINE}` };
	});

	// Status command: /tool-discipline — verify tool registration and injection.
	pi.registerCommand("tool-discipline", {
		description: "Show pi-tool-discipline status (tools + injected guideline)",
		handler: async (_args, ctx) => {
			const all = new Set(pi.getAllTools().map((t) => t.name));
			const active = new Set(pi.getActiveTools());
			const fff = FFF_TOOLS.filter((name) => active.has(name));
			const registered = PLACEHOLDER_NAMES.filter((n) => all.has(n));
			const visible = PLACEHOLDER_NAMES.filter((n) => active.has(n));
			const injected = ctx.getSystemPrompt().includes(MARK);
			ctx.ui.notify(
				`pi-tool-discipline\n` +
					`fff active: ${fff.length > 0 ? fff.join(", ") : "(none)"}\n` +
					`grep/find/ls registered: ${registered.length > 0 ? registered.join(", ") : "(none)"}\n` +
					`visible to model: ${visible.length > 0 ? visible.join(", ") : "(none)"}\n` +
					`discipline injected: ${injected ? "yes" : "no"}`,
				"info",
			);
		},
	});
}
