/**
 * Fallback search implementations for environments without @ff-labs/pi-fff.
 * Pure Node fs-based; no shell, no external deps.
 */
import { readdirSync, readFileSync, statSync, lstatSync } from "fs";
import { join, resolve, relative } from "path";
import { Type } from "typebox";

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);
const MAX_FILES = 2000;
const MAX_VISITED = 5000; // total entries touched, bounds slow/odd trees
const MAX_FILE_BYTES = 1024 * 1024; // content search skips files larger than 1 MiB
const MAX_OUTPUT_BYTES = 50 * 1024;
const TRUNCATE_MARKER = "\n[output truncated]";

interface FileMatch {
	file: string;
	line: number;
	text: string;
}

/**
 * Collect regular files under dir (depth-limited, symlink-safe, bounded).
 * Only isFile() entries are collected — FIFOs, devices, sockets can block a
 * synchronous read. Synchronous by design (fallback tools, low frequency);
 * the walk is bounded by MAX_FILES/MAX_VISITED so it cannot hang forever.
 * Does NOT filter by size — path search must find large files too.
 */
function walk(dir: string, out: string[], state: { visited: number }, depth = 0): void {
	if (depth > 12 || state.visited >= MAX_VISITED) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_FILES || state.visited >= MAX_VISITED) return; // in-loop bound
		if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
		const p = join(dir, entry);
		state.visited++;
		try {
			const lst = lstatSync(p);
			if (lst.isSymbolicLink()) continue; // never follow symlinks
			if (lst.isDirectory()) walk(p, out, state, depth + 1);
			else if (lst.isFile()) out.push(p); // regular files only
		} catch {
			// unreadable entries are skipped
		}
	}
}

/** Truncate by BYTE length, keep complete lines, reserve space for the marker. */
function truncate(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
	const buf = Buffer.from(text, "utf8");
	const budget = maxBytes - Buffer.byteLength(TRUNCATE_MARKER);
	if (buf.length <= budget) return text;
	const cut = buf.subarray(0, budget).toString("utf8");
	const lastNewline = cut.lastIndexOf("\n");
	if (lastNewline <= 0) return TRUNCATE_MARKER.trim(); // nothing complete fits
	return `${cut.slice(0, lastNewline)}\n${TRUNCATE_MARKER}`;
}

export function grepFiles(opts: {
	pattern: string;
	path?: string;
	caseSensitive?: boolean;
	maxResults?: number;
	cwd: string;
}): string {
	const root = resolve(opts.cwd, opts.path || ".");
	const pattern = opts.caseSensitive ? opts.pattern : opts.pattern.toLowerCase();
	const limit = opts.maxResults ?? 100;
	const files: string[] = [];
	walk(root, files, { visited: 0 });
	const matches: FileMatch[] = [];
	for (const file of files) {
		if (matches.length >= limit) break;
		try {
			if (statSync(file).size > MAX_FILE_BYTES) continue; // cap only before reading content
		} catch {
			continue;
		}
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const haystack = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
			if (haystack.includes(pattern)) {
				matches.push({ file: relative(root, file), line: i + 1, text: lines[i].trim().slice(0, 200) });
				if (matches.length >= limit) break;
			}
		}
	}
	if (matches.length === 0) return "No matches found";
	let out = "";
	for (const m of matches) out += `${m.file}:${m.line}: ${m.text}\n`;
	return truncate(out);
}

export function findFiles(opts: { pattern?: string; path?: string; maxResults?: number; cwd: string }): string {
	const root = resolve(opts.cwd, opts.path || ".");
	const files: string[] = [];
	walk(root, files, { visited: 0 });
	const needle = opts.pattern?.toLowerCase();
	// Match against the RELATIVE path so a pattern matching an ancestor
	// directory does not hit every file, and rendered output stays relative.
	const rel = files.map((f) => relative(root, f));
	const hits = needle ? rel.filter((r) => r.toLowerCase().includes(needle)) : rel;
	if (hits.length === 0) return "No matching files found";
	return truncate(hits.slice(0, opts.maxResults ?? 100).join("\n"));
}

export function listDir(opts: { path?: string; cwd: string }): string {
	const dir = resolve(opts.cwd, opts.path || ".");
	try {
		return truncate(readdirSync(dir).join("\n"));
	} catch (error: any) {
		return `Error listing ${dir}: ${error.message}`;
	}
}

export const grepSchema = Type.Object({
	pattern: Type.String({ description: "Text to search for in file contents" }),
	path: Type.Optional(Type.String({ description: "Directory to search (defaults to cwd)" })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive match (default false)" })),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, description: "Max matches (default 100)" })),
});

export const findSchema = Type.Object({
	pattern: Type.Optional(Type.String({ description: "Substring to match in file path or name (empty lists all)" })),
	path: Type.Optional(Type.String({ description: "Directory to search (defaults to cwd)" })),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, description: "Max results (default 100)" })),
});

export const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (defaults to cwd)" })),
});
