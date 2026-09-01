/**
 * Fallback search implementations for environments without @ff-labs/pi-fff.
 * Pure Node fs-based (async, abort-aware); no shell, no external deps.
 */
import { readdir, readFile, stat, lstat } from "fs/promises";
import { join, resolve, relative } from "path";
import { Type } from "typebox";

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);
const MAX_FILES = 2000;
const MAX_VISITED = 5000; // total entries touched, bounds slow/odd trees
const MAX_FILE_BYTES = 1024 * 1024; // content search skips files larger than 1 MiB
const MAX_OUTPUT_BYTES = 50 * 1024;
const TRUNCATE_MARKER = "\n[output truncated]";
const CAPPED_MARKER = "\n[search capped — traversal stopped early]";

/** Cancellation error, matching pi built-in tools ("Operation aborted"). */
function abortError(): Error {
	return new Error("Operation aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

interface FileMatch {
	file: string;
	line: number;
	text: string;
}

interface WalkState {
	visited: number;
	capped: boolean;
	rootError?: string;
}

/**
 * Collect regular files under dir (depth-limited, symlink-safe, bounded,
 * abort-aware). Only isFile() entries are collected — FIFOs, devices, sockets
 * would block a read. Individual OS filesystem requests may still be
 * uninterruptible, but the signal is checked before/after every operation.
 * A failure to read the REQUESTED ROOT (depth 0) is recorded in rootError;
 * nested unreadable entries are skipped.
 */
async function walk(dir: string, out: string[], state: WalkState, signal?: AbortSignal, depth = 0): Promise<void> {
	throwIfAborted(signal);
	if (depth > 12 || state.visited >= MAX_VISITED) {
		state.capped = true;
		return;
	}
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error: any) {
		throwIfAborted(signal); // cancellation wins over the fs error
		if (depth === 0) state.rootError = error?.message ?? String(error);
		return;
	}
	throwIfAborted(signal);
	for (const entry of entries) {
		if (out.length >= MAX_FILES || state.visited >= MAX_VISITED) {
			state.capped = true;
			return; // in-loop bound
		}
		if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
		const p = join(dir, entry);
		state.visited++;
		try {
			const lst = await lstat(p);
			throwIfAborted(signal);
			if (lst.isSymbolicLink()) continue; // never follow symlinks
			if (lst.isDirectory()) {
				await walk(p, out, state, signal, depth + 1);
				throwIfAborted(signal);
			} else if (lst.isFile()) out.push(p); // regular files only
		} catch (error: any) {
			throwIfAborted(signal); // cancellation wins over the fs error
			// unreadable entries are skipped
		}
	}
	throwIfAborted(signal); // post-recursion check
}

/**
 * Truncate by BYTE length, keep complete lines, reserve space for all markers.
 * Returns the original text unchanged when it fits within maxBytes.
 */
function truncate(text: string, maxBytes = MAX_OUTPUT_BYTES, extraMarkerBytes = 0): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length + extraMarkerBytes <= maxBytes) return text;
	const budget = maxBytes - Buffer.byteLength(TRUNCATE_MARKER) - extraMarkerBytes;
	if (budget <= 0) return TRUNCATE_MARKER.trim();
	const cut = buf.subarray(0, budget).toString("utf8");
	const lastNewline = cut.lastIndexOf("\n");
	if (lastNewline <= 0) return TRUNCATE_MARKER.trim(); // nothing complete fits
	return `${cut.slice(0, lastNewline)}\n${TRUNCATE_MARKER}`;
}

async function resolveRoot(cwd: string, sub?: string, signal?: AbortSignal): Promise<string | null> {
	const root = resolve(cwd, sub || ".");
	try {
		const st = await stat(root);
		throwIfAborted(signal);
		return st.isDirectory() ? root : null;
	} catch (error: any) {
		throwIfAborted(signal);
		return null;
	}
}

function walkFiles(root: string, signal?: AbortSignal): Promise<{ files: string[]; state: WalkState }> {
	const files: string[] = [];
	const state: WalkState = { visited: 0, capped: false };
	return walk(root, files, state, signal).then(() => ({ files, state }));
}

export async function grepFiles(opts: {
	pattern: string;
	path?: string;
	caseSensitive?: boolean;
	maxResults?: number;
	cwd: string;
	signal?: AbortSignal;
}): Promise<string> {
	throwIfAborted(opts.signal);
	const root = await resolveRoot(opts.cwd, opts.path, opts.signal);
	if (!root) return `Error: search path not found: ${resolve(opts.cwd, opts.path || ".")}`;
	const pattern = opts.caseSensitive ? opts.pattern : opts.pattern.toLowerCase();
	const limit = opts.maxResults ?? 100;
	const { files, state } = await walkFiles(root, opts.signal);
	throwIfAborted(opts.signal);
	if (state.rootError) return `Error: cannot read search root ${root}: ${state.rootError}`;
	const matches: FileMatch[] = [];
	for (const file of files) {
		throwIfAborted(opts.signal);
		if (matches.length >= limit) break;
		try {
			const size = (await stat(file)).size;
			throwIfAborted(opts.signal);
			if (size > MAX_FILE_BYTES) continue; // cap only before reading content
		} catch (error: any) {
			throwIfAborted(opts.signal);
			continue;
		}
		throwIfAborted(opts.signal);
		let content: string;
		try {
			content = await readFile(file, "utf8");
		} catch (error: any) {
			throwIfAborted(opts.signal);
			continue;
		}
		throwIfAborted(opts.signal);
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			throwIfAborted(opts.signal);
			const haystack = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
			if (haystack.includes(pattern)) {
				matches.push({ file: relative(root, file), line: i + 1, text: lines[i].trim().slice(0, 200) });
				if (matches.length >= limit) break;
			}
		}
	}
	if (matches.length === 0) return state.capped ? `No matches found${CAPPED_MARKER}` : "No matches found";
	let out = "";
	for (const m of matches) out += `${m.file}:${m.line}: ${m.text}\n`;
	out = truncate(out, MAX_OUTPUT_BYTES, state.capped ? Buffer.byteLength(CAPPED_MARKER) : 0);
	if (state.capped) out += CAPPED_MARKER;
	return out;
}

export async function findFiles(opts: {
	pattern?: string;
	path?: string;
	maxResults?: number;
	cwd: string;
	signal?: AbortSignal;
}): Promise<string> {
	throwIfAborted(opts.signal);
	const root = await resolveRoot(opts.cwd, opts.path, opts.signal);
	if (!root) return `Error: search path not found: ${resolve(opts.cwd, opts.path || ".")}`;
	const { files, state } = await walkFiles(root, opts.signal);
	throwIfAborted(opts.signal);
	if (state.rootError) return `Error: cannot read search root ${root}: ${state.rootError}`;
	const needle = opts.pattern?.toLowerCase();
	// Match against the RELATIVE path so a pattern matching an ancestor
	// directory does not hit every file, and rendered output stays relative.
	const rel: string[] = [];
	for (const f of files) {
		throwIfAborted(opts.signal);
		rel.push(relative(root, f));
	}
	const hits: string[] = [];
	for (const r of rel) {
		throwIfAborted(opts.signal);
		if (!needle || r.toLowerCase().includes(needle)) hits.push(r);
		if (hits.length >= (opts.maxResults ?? 100)) break;
	}
	if (hits.length === 0) return state.capped ? `No matching files found${CAPPED_MARKER}` : "No matching files found";
	let out = truncate(hits.join("\n"), MAX_OUTPUT_BYTES, state.capped ? Buffer.byteLength(CAPPED_MARKER) : 0);
	if (state.capped) out += CAPPED_MARKER;
	return out;
}

export async function listDir(opts: { path?: string; cwd: string; signal?: AbortSignal }): Promise<string> {
	throwIfAborted(opts.signal);
	const root = await resolveRoot(opts.cwd, opts.path, opts.signal);
	if (!root) return `Error: directory not found: ${resolve(opts.cwd, opts.path || ".")}`;
	try {
		const entries = await readdir(root);
		throwIfAborted(opts.signal);
		if (entries.length === 0) return "(empty directory)";
		return truncate(entries.join("\n"));
	} catch (error: any) {
		throwIfAborted(opts.signal);
		return `Error listing ${root}: ${error.message}`;
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
