import assert from "node:assert/strict";
import { stripBashGuidelines } from "../extensions/strip.ts";

function test(name, fn) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}:`, e);
		process.exit(1);
	}
}

const G_BASH = "- Use bash for file operations like ls, rg, find";
const G_BASH_PS = "- Use bash or PowerShell for file operations like listing, searching, and finding files";
const G_PS = "- Use PowerShell for file operations like listing, searching, and finding files";

test("rewrites the plain bash guideline (whole line)", () => {
	const out = stripBashGuidelines(G_BASH + "\n");
	assert.equal(out, "- Use ffgrep/fffind for file operations like ls, rg, find\n");
});

test("rewrites the bash-or-PowerShell guideline", () => {
	const out = stripBashGuidelines(G_BASH_PS + "\n");
	assert.ok(out.includes("- Use ffgrep/fffind for file operations like listing, searching, and finding files"));
	assert.ok(!out.includes(G_BASH_PS));
});

test("rewrites the PowerShell-only guideline", () => {
	const out = stripBashGuidelines(G_PS + "\n");
	assert.ok(!out.includes(G_PS));
});

test("leaves unrelated lines untouched", () => {
	const out = stripBashGuidelines("- Do something else entirely\n" + G_BASH + "\n");
	assert.ok(out.includes("- Do something else entirely"));
	assert.ok(!out.includes(G_BASH));
});

test("does not rewrite quoted references (not whole-line matches)", () => {
	// Inline/indented references must survive so project docs are not altered.
	const out = stripBashGuidelines('Some prompt says "Use bash for file operations like ls, rg, find" is bad.\n');
	assert.ok(out.includes('Use bash for file operations like ls, rg, find'));
});

test("does not rewrite lines with trailing whitespace", () => {
	const out = stripBashGuidelines(G_BASH + "  \n");
	assert.ok(out.includes(G_BASH + "  "));
});

test("handles empty and whitespace-only input", () => {
	assert.equal(stripBashGuidelines(""), "");
	assert.equal(stripBashGuidelines("   \n  \n"), "   \n  \n");
});
