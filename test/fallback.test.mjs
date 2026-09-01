/**
 * Automated tests for pi-tool-discipline fallback search + prompt stripping.
 * Run: npm test
 */
import { strict as assert } from "assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { grepFiles, findFiles, listDir } from "../extensions/search.ts";
import { stripBashGuidelines } from "../extensions/strip.ts";

let passed = 0;
async function t(name, fn) {
	await fn();
	passed++;
	console.log(`PASS ${name}`);
}

const dir = mkdtempSync(join(tmpdir(), "td-test-"));
try {
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "a.txt"), "hello world\nfoo bar\nHello Again\n");
	writeFileSync(join(dir, "sub", "b.txt"), "nested hello\n");
	writeFileSync(join(dir, "c.log"), "no match here\n");
	mkdirSync(join(dir, "empty"));
	mkdirSync(join(dir, "wide"), { recursive: true });
	let long = "";
	for (let i = 0; i < 2000; i++) long += `match line ${i} with padding text\n`;
	writeFileSync(join(dir, "wide", "long.txt"), long);

	await t("grep basic (case-insensitive)", async () => {
		const out = await grepFiles({ pattern: "hello", cwd: dir });
		assert.ok(out.includes("a.txt:1: hello world"), out);
		assert.ok(out.includes("a.txt:3: Hello Again"), out);
		assert.ok(out.includes("sub/b.txt:1: nested hello"), out);
	});

	await t("grep case-sensitive no match", async () => {
		const out = await grepFiles({ pattern: "HELLO", caseSensitive: true, cwd: dir });
		assert.equal(out, "No matches found");
	});

	await t("grep missing root error", async () => {
		const out = await grepFiles({ pattern: "x", path: "/definitely-not-here-12345", cwd: dir });
		assert.ok(out.startsWith("Error: search path not found"), out);
	});

	await t("find by name", async () => {
		const out = await findFiles({ pattern: "b.txt", cwd: dir });
		assert.equal(out, "sub/b.txt");
	});

	await t("find missing root error", async () => {
		const out = await findFiles({ path: "/definitely-not-here-12345", cwd: dir });
		assert.ok(out.startsWith("Error: search path not found"), out);
	});

	await t("ls empty directory", async () => {
		const out = await listDir({ path: "empty", cwd: dir });
		assert.equal(out, "(empty directory)");
	});

	await t("ls missing root error", async () => {
		const out = await listDir({ path: "/definitely-not-here-12345", cwd: dir });
		assert.ok(out.startsWith("Error: directory not found"), out);
	});

	await t("abort rejects with Operation aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(grepFiles({ pattern: "hello", cwd: dir, signal: ac.signal }), /Operation aborted/);
		await assert.rejects(findFiles({ cwd: dir, signal: ac.signal }), /Operation aborted/);
		await assert.rejects(listDir({ cwd: dir, signal: ac.signal }), /Operation aborted/);
	});

	await t("truncate keeps byte ceiling + marker", async () => {
		const out = await grepFiles({ pattern: "match line", maxResults: 2000, cwd: join(dir, "wide") });
		assert.ok(out.includes("[output truncated]"), "marker present");
		assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024, "byte ceiling");
	});

	await t("catch-path abort wins over fs error", async () => {
		// chmod 000 makes readdir fail; with a pre-aborted signal the catch
		// must re-throw Operation aborted instead of surfacing the fs error.
		const locked = join(dir, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "x.txt"), "hello\n");
		try {
			chmodSync(locked, 0o000);
			const ac = new AbortController();
			ac.abort();
			await assert.rejects(grepFiles({ pattern: "hello", cwd: dir, path: "locked", signal: ac.signal }), /Operation aborted/);
			await assert.rejects(listDir({ path: "locked", cwd: dir, signal: ac.signal }), /Operation aborted/);
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	await t("root readdir error surfaces", async () => {
		const locked = join(dir, "locked2");
		mkdirSync(locked);
		try {
			chmodSync(locked, 0o000);
			const out = await grepFiles({ pattern: "hello", cwd: dir, path: "locked2" });
			assert.ok(out.startsWith("Error: cannot read search root"), out);
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	await t("depth-capped output stays within byte ceiling", async () => {
		// 13 levels triggers the depth cap; the match at depth 12 is collected.
		mkdirSync(join(dir, "d"), { recursive: true });
		let deep = join(dir, "d");
		for (let i = 0; i < 11; i++) deep = join(deep, "d"); // level 12
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(deep, "deep.txt"), "capped hello\n");
		mkdirSync(join(deep, "d13"), { recursive: true }); // level 13 → caps traversal
		const out = await grepFiles({ pattern: "hello", cwd: dir });
		assert.ok(out.includes("[search capped — traversal stopped early]"), "capped marker");
		assert.ok(out.includes("deep.txt"), "deep match found");
		assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024, "byte ceiling with capped marker");
	});

	await t("strip handles CRLF and all guideline variants", () => {
		const out = stripBashGuidelines(
			"- Use bash for file operations like ls, rg, find\r\n" +
				"- Use bash or PowerShell for file operations like listing, searching, and finding files\n" +
				"- Use PowerShell for file operations like listing, searching, and finding files\n",
		);
		assert.ok(out.includes("- Use ffgrep/fffind for file operations like ls, rg, find"), "grep variant");
		assert.ok(
			out.includes("- Use ffgrep/fffind for file operations like listing, searching, and finding files"),
			"both+PS variant",
		);
		assert.ok(!out.includes("Use bash for file operations"), "no bash guideline remains");
		assert.ok(!out.includes("Use PowerShell for file operations"), "no PS guideline remains");
		const quoted = 'Some quoted text: "- Use bash for file operations like ls, rg, find"';
		const quotedOut = stripBashGuidelines(`${quoted}\n`);
		assert.ok(quotedOut.includes(quoted), "quoted reference untouched");
	});

	console.log(`\nAll ${passed} tests passed.`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
