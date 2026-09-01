/**
 * Automated tests for pi-tool-discipline fallback search + prompt stripping.
 * Run: npm test
 */
import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
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
		assert.equal(out.split("\n")[0], "a.txt:1: hello world");
		assert.ok(out.includes("sub/b.txt:1: nested hello"));
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

	await t("strip rewrites only whole guideline lines", () => {
		const g = "- Use bash for file operations like ls, rg, find";
		const quoted = `Some quoted text: "${g}"`;
		const out = stripBashGuidelines(`${g}\n${quoted}`);
		assert.ok(out.startsWith("- Use ffgrep/fffind for file operations like ls, rg, find"), "whole line rewritten");
		assert.ok(out.includes(quoted), "quoted reference untouched");
	});

	console.log(`\nAll ${passed} tests passed.`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
