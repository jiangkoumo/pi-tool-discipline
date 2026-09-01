/**
 * Automated tests for pi-tool-discipline fallback search + prompt stripping.
 * Run: npm test
 */
import { strict as assert } from "assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { grepFiles, findFiles, listDir, walk } from "../extensions/search.ts";
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
	for (let i = 0; i < 2000; i++) long += `match line ${i} with padding text to fill the output past fifty kilobytes\n`;
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
		// chmod 000 makes readdir fail; aborting in a microtask (after the
		// call starts, before the fs error resolves) must make the catch
		// re-throw Operation aborted instead of surfacing the fs error.
		const locked = join(dir, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "x.txt"), "hello\n");
		try {
			chmodSync(locked, 0o000);
			const ac = new AbortController();
			const p = grepFiles({ pattern: "hello", cwd: dir, path: "locked", signal: ac.signal });
			Promise.resolve().then(() => ac.abort());
			await assert.rejects(p, /Operation aborted/);
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

	await t("walk fs-error catch aborts deterministically (injected fs)", async () => {
		// Inject fs ops whose readdir rejects AFTER aborting the signal, so
		// walk's catch runs with the signal already aborted and must reject
		// rather than surface the fs error.
		const out = [];
		const state = { visited: 0, capped: false };
		const ac = new AbortController();
		await assert.rejects(
			walk("/injected", out, state, ac.signal, 0, {
				readdir: async () => {
					ac.abort();
					throw new Error("EACCES: permission denied");
				},
				lstat: async () => {
					throw new Error("should not be called");
				},
			}),
			/Operation aborted/,
		);
		assert.equal(state.rootError, undefined, "fs error not surfaced");
	});

	await t("oversized path error stays within byte ceiling", async () => {
		const huge = "/" + "x".repeat(200 * 1024); // ~200KB path
		const out = await grepFiles({ pattern: "hello", path: huge, cwd: dir });
		assert.ok(out.startsWith("Error: search path not found"), out.slice(0, 60));
		assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024, "byte ceiling");
	});

	await t("maxResults is hard-capped internally", async () => {
		// Short lines so 1000 results fit under the output ceiling — then the
		// result count itself proves the cap (no post-truncation hiding).
		const capDir = join(dir, "cap");
		mkdirSync(capDir);
		let short = "";
		for (let i = 0; i < 2000; i++) short += `cap${i}\n`;
		writeFileSync(join(capDir, "c.txt"), short);
		const out = await grepFiles({ pattern: "cap", maxResults: 1e9, cwd: capDir });
		const lines = out.trim().split("\n");
		assert.equal(lines.length, 1000, "exactly 1000 grep results");
		assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024, "byte ceiling");
		// findFiles ceiling: more than 1000 files, short names → exact count.
		const manyDir = join(dir, "many");
		mkdirSync(manyDir);
		for (let i = 0; i < 1200; i++) writeFileSync(join(manyDir, `f${String(i).padStart(4, "0")}.txt`), "x\n");
		const fout = await findFiles({ maxResults: 1e9, cwd: manyDir });
		assert.equal(fout.trim().split("\n").length, 1000, "exactly 1000 find results");
	});

	await t("NaN maxResults falls back to default (100)", async () => {
		const out = await grepFiles({ pattern: "cap", maxResults: Number.NaN, cwd: join(dir, "cap") });
		assert.equal(out.trim().split("\n").length, 100, "grep NaN → 100 results");
		const fout = await findFiles({ maxResults: Number.NaN, cwd: join(dir, "many") });
		assert.equal(fout.trim().split("\n").length, 100, "find NaN → 100 results");
	});

	await t("multibyte truncation stays within byte ceiling", async () => {
		// Lines are ASCII-prefixed then CJK; the 50KB cut lands inside the CJK
		// run, exercising the split-codepoint trim-back path. No U+FFFD may
		// appear and the byte ceiling must hold.
		const mbDir = join(dir, "mb");
		mkdirSync(mbDir);
		let mb = "";
		for (let i = 0; i < 250; i++) mb += `${"x".repeat(100)}${"中".repeat(45)}\n`;
		writeFileSync(join(mbDir, "m.txt"), mb);
		const out = await grepFiles({ pattern: "x", maxResults: 1e9, cwd: mbDir });
		assert.ok(out.includes("[output truncated]"), "truncated marker");
		assert.ok(!out.includes("\uFFFD"), "no replacement character");
		assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024, "byte ceiling with multibyte");
	});

	await t("depth-capped output stays within byte ceiling", async () => {
		// 13 levels triggers the depth cap; a large matching file at level 12
		// pushes output near the ceiling so truncation + capped markers both
		// run and the final output must still fit 50KB.
		mkdirSync(join(dir, "d"), { recursive: true });
		let deep = join(dir, "d");
		for (let i = 0; i < 11; i++) deep = join(deep, "d"); // level 12
		mkdirSync(deep, { recursive: true });
		let big = "";
		for (let i = 0; i < 2000; i++) big += `capped hello line ${i} with padding text to fill output\n`;
		writeFileSync(join(deep, "deep.txt"), big);
		mkdirSync(join(deep, "d13"), { recursive: true }); // level 13 → caps traversal
		const out = await grepFiles({ pattern: "capped hello", maxResults: 5000, cwd: dir });
		assert.ok(out.includes("[search capped — traversal stopped early]"), "capped marker");
		assert.ok(out.includes("[output truncated]"), "truncated marker");
		assert.ok(out.includes("deep.txt"), "deep match found");
		assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024, "byte ceiling with both markers");
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
