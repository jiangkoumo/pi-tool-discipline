/**
 * Whole-line stripping of pi's generated bash file-operation guidelines.
 * Kept dependency-free so it is testable outside the pi runtime.
 */

/**
 * Strip only the exact generated guideline bullets, line-anchored (whole-line,
 * global), so quoted references inside project instructions or custom prompts
 * are not rewritten. Activation normally prevents pi from generating these
 * anyway; this is a belt-and-suspenders fallback.
 */
export function stripBashGuidelines(prompt: string): string {
	return prompt
		.replace(/^- Use bash for file operations like ls, rg, find(?=\r?$)/gm, "- Use ffgrep/fffind for file operations like ls, rg, find")
		.replace(
			/^- Use bash or PowerShell for file operations like listing, searching, and finding files(?=\r?$)/gm,
			"- Use ffgrep/fffind for file operations like listing, searching, and finding files",
		)
		.replace(
			/^- Use PowerShell for file operations like listing, searching, and finding files(?=\r?$)/gm,
			"- Use ffgrep/fffind for file operations like listing, searching, and finding files",
		);
}
