/**
 * Bash & PowerShell command analyzer for tool discipline enforcement.
 * Blocks prohibited file operations (ls, cat, grep, find, sed, which, head/tail on files)
 * including when nested in subshells $(...), backticks, script blocks {...}, wrappers, or redirects,
 * while allowing legitimate pipelines, builds, test runs, here-doc writes, and scripts.
 */

export interface BlockResult {
	block: boolean;
	reason?: string;
	prohibitedCommand?: string;
}

export interface CommandSegment {
	command: string;
	args: string[];
	isPipeTarget: boolean;
	hasInputRedirect: boolean;
	hasOutputRedirect: boolean;
	hasHereDoc: boolean;
	raw: string;
}

/**
 * Remove shell quotes and backslash escapes from a command token.
 * e.g. '"/bin/ls"' -> '/bin/ls', '\ls' -> 'ls', "'Get-ChildItem'" -> 'Get-ChildItem'
 */
export function unquoteWord(word: string): string {
	if (!word) return "";
	let result = "";
	let i = 0;
	const len = word.length;

	while (i < len) {
		const c = word[i];
		if (c === "'") {
			i++;
			while (i < len && word[i] !== "'") {
				result += word[i];
				i++;
			}
			if (i < len) i++;
		} else if (c === '"') {
			i++;
			while (i < len && word[i] !== '"') {
				if (word[i] === "\\" && i + 1 < len) {
					result += word[i + 1];
					i += 2;
				} else {
					result += word[i];
					i++;
				}
			}
			if (i < len) i++;
		} else if (c === "\\") {
			if (i + 1 < len) {
				result += word[i + 1];
				i += 2;
			} else {
				i++;
			}
		} else {
			result += c;
			i++;
		}
	}
	return result;
}

/** Check if a word token has shell quotes around or inside it */
function isQuoted(word: string): boolean {
	return word.includes("'") || word.includes('"') || word.includes("\\");
}

/**
 * Extract embedded command substitutions $(...) and `...` from unquoted here-doc body.
 * Respects backslash escapes (\$, \`, \\, \)) so `\$(ls)` is treated as literal and `\)` does not close subshell.
 */
function extractSubshellsFromHereDocBody(body: string, subshellSnippets: string[]) {
	let i = 0;
	const len = body.length;
	while (i < len) {
		const ch = body[i];

		if (ch === "\\") {
			// Escape in unquoted here-doc: \$ -> literal $, \` -> literal `
			i += 2;
			continue;
		}

		if (ch === "`") {
			i++;
			let code = "";
			while (i < len && body[i] !== "`") {
				if (body[i] === "\\" && i + 1 < len) {
					code += body[i + 1];
					i += 2;
				} else {
					code += body[i];
					i++;
				}
			}
			if (i < len) i++;
			if (code) subshellSnippets.push(code);
			continue;
		}

		if (ch === "$" && body[i + 1] === "(") {
			i += 2;
			let depth = 1;
			let code = "";
			while (i < len && depth > 0) {
				if (body[i] === "\\" && i + 1 < len) {
					// Escape inside substitution (e.g. \) is literal, not subshell close)
					code += body.slice(i, i + 2);
					i += 2;
					continue;
				}
				if (body[i] === "(") {
					depth++;
					code += body[i];
					i++;
					continue;
				}
				if (body[i] === ")") {
					depth--;
					if (depth === 0) {
						i++;
						break;
					}
					code += body[i];
					i++;
					continue;
				}
				if (body[i] === "'" || body[i] === '"') {
					const q = body[i];
					code += q;
					i++;
					while (i < len && body[i] !== q) {
						if (q === '"' && body[i] === "\\" && i + 1 < len) {
							code += body.slice(i, i + 2);
							i += 2;
						} else {
							code += body[i];
							i++;
						}
					}
					if (i < len) {
						code += body[i];
						i++;
					}
					continue;
				}
				code += body[i];
				i++;
			}
			if (code) subshellSnippets.push(code);
			continue;
		}

		i++;
	}
}

/**
 * Tokenize a shell command input into individual pipeline segments.
 */
export function parseCommandSegments(
	input: string,
	dialect: "bash" | "powershell" = "bash",
): CommandSegment[] {
	if (!input || typeof input !== "string") return [];

	const segments: CommandSegment[] = [];
	const subshellSnippets: { code: string; dialect: "bash" | "powershell" }[] = [];

	const rawLines = input.split(/\r?\n/);
	let lineIdx = 0;

	let currentTokens: string[] = [];
	let currentRaw = "";
	let isPipeTarget = false;
	let hasInputRedirect = false;
	let hasOutputRedirect = false;
	let hasHereDoc = false;

	const flushSegment = () => {
		if (currentTokens.length > 0 || hasInputRedirect || hasOutputRedirect || hasHereDoc) {
			segments.push(
				createSegment(
					currentTokens,
					currentRaw,
					isPipeTarget,
					hasInputRedirect,
					hasOutputRedirect,
					hasHereDoc,
					dialect,
				),
			);
			currentTokens = [];
			currentRaw = "";
			hasInputRedirect = false;
			hasOutputRedirect = false;
			hasHereDoc = false;
		}
	};

	while (lineIdx < rawLines.length) {
		const line = rawLines[lineIdx];
		let i = 0;
		const len = line.length;
		const activeHereDocs: { delimiter: string; isQuoted: boolean; stripTabs: boolean }[] = [];

		while (i < len) {
			const ch = line[i];

			if (/\s/.test(ch)) {
				currentRaw += ch;
				i++;
				continue;
			}

			// Subshell / command substitution inside backticks `...` (in bash)
			if (dialect === "bash" && ch === "`") {
				const btStart = i;
				i++;
				let code = "";
				while (i < len && line[i] !== "`") {
					if (line[i] === "\\" && i + 1 < len) {
						code += line[i + 1];
						i += 2;
					} else {
						code += line[i];
						i++;
					}
				}
				if (i < len) i++;
				if (code) subshellSnippets.push({ code, dialect: "bash" });
				currentRaw += line.slice(btStart, i);
				currentTokens.push(`\`${code}\``);
				continue;
			}

			// Subshell $(...)
			if (ch === "$" && line[i + 1] === "(") {
				const ssStart = i;
				i += 2;
				let depth = 1;
				let code = "";
				while (i < len && depth > 0) {
					if (line[i] === "\\" && i + 1 < len) {
						code += line.slice(i, i + 2);
						i += 2;
						continue;
					}
					if (line[i] === "(") {
						depth++;
						code += line[i];
						i++;
						continue;
					}
					if (line[i] === ")") {
						depth--;
						if (depth === 0) {
							i++;
							break;
						}
						code += line[i];
						i++;
						continue;
					}
					if (line[i] === "'" || line[i] === '"') {
						const q = line[i];
						code += q;
						i++;
						while (i < len && line[i] !== q) {
							if (q === '"' && line[i] === "\\" && i + 1 < len) {
								code += line.slice(i, i + 2);
								i += 2;
							} else {
								code += line[i];
								i++;
							}
						}
						if (i < len) {
							code += line[i];
							i++;
						}
						continue;
					}
					code += line[i];
					i++;
				}
				if (code) subshellSnippets.push({ code, dialect });
				currentRaw += line.slice(ssStart, i);
				currentTokens.push(`$(${code})`);
				continue;
			}

			// Parenthesized group ( ... )
			if (ch === "(") {
				const pStart = i;
				i++;
				let depth = 1;
				let code = "";
				while (i < len && depth > 0) {
					if (line[i] === "\\" && i + 1 < len) {
						code += line.slice(i, i + 2);
						i += 2;
						continue;
					}
					if (line[i] === "(") {
						depth++;
						code += line[i];
						i++;
						continue;
					}
					if (line[i] === ")") {
						depth--;
						if (depth === 0) {
							i++;
							break;
						}
						code += line[i];
						i++;
						continue;
					}
					if (line[i] === "'" || line[i] === '"') {
						const q = line[i];
						code += q;
						i++;
						while (i < len && line[i] !== q) {
							if (q === '"' && line[i] === "\\" && i + 1 < len) {
								code += line.slice(i, i + 2);
								i += 2;
							} else {
								code += line[i];
								i++;
							}
						}
						if (i < len) {
							code += line[i];
							i++;
						}
						continue;
					}
					code += line[i];
					i++;
				}
				if (code) subshellSnippets.push({ code, dialect });
				currentRaw += line.slice(pStart, i);
				continue;
			}

			// PowerShell Script Block { ... }
			if (ch === "{") {
				const bStart = i;
				i++;
				let depth = 1;
				let code = "";
				while (i < len && depth > 0) {
					const cur = line[i];
					if (cur === "{") {
						depth++;
						code += cur;
						i++;
					} else if (cur === "}") {
						depth--;
						if (depth === 0) {
							i++;
							break;
						}
						code += cur;
						i++;
					} else if (cur === "'") {
						code += cur;
						i++;
						while (i < len) {
							if (line[i] === "'") {
								if (line[i + 1] === "'") {
									code += "''";
									i += 2;
								} else {
									code += "'";
									i++;
									break;
								}
							} else {
								code += line[i];
								i++;
							}
						}
					} else if (cur === '"') {
						code += cur;
						i++;
						while (i < len) {
							if (line[i] === "`" && i + 1 < len) {
								code += line.slice(i, i + 2);
								i += 2;
							} else if (line[i] === '"') {
								if (line[i + 1] === '"') {
									code += '""';
									i += 2;
								} else {
									code += '"';
									i++;
									break;
								}
							} else {
								code += line[i];
								i++;
							}
						}
					} else {
						code += cur;
						i++;
					}
				}
				if (code) subshellSnippets.push({ code, dialect: "powershell" });
				currentRaw += line.slice(bStart, i);
				continue;
			}

			// Control operators: ;, &&, ||, |, &
			if (ch === ";") {
				flushSegment();
				isPipeTarget = false;
				currentRaw += ";";
				i++;
				continue;
			}

			if (ch === "&") {
				if (line[i + 1] === "&") {
					flushSegment();
					isPipeTarget = false;
					currentRaw += "&&";
					i += 2;
				} else {
					flushSegment();
					isPipeTarget = false;
					currentRaw += "&";
					i++;
				}
				continue;
			}

			if (ch === "|") {
				if (line[i + 1] === "|") {
					flushSegment();
					isPipeTarget = false;
					currentRaw += "||";
					i += 2;
				} else {
					flushSegment();
					isPipeTarget = true;
					if (line[i + 1] === "&") {
						currentRaw += "|&";
						i += 2;
					} else {
						currentRaw += "|";
						i++;
					}
				}
				continue;
			}

			// Here-doc (Bash only): << or <<-
			if (dialect === "bash" && ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
				let hdIdx = i + 2;
				let stripTabs = false;
				if (line[hdIdx] === "-") {
					stripTabs = true;
					hdIdx++;
				}
				while (hdIdx < len && /\s/.test(line[hdIdx])) hdIdx++;
				let delimRaw = "";
				while (hdIdx < len && !/[\s;&|<>()]/.test(line[hdIdx])) {
					const c = line[hdIdx];
					if (c === "'" || c === '"') {
						const q = c;
						delimRaw += q;
						hdIdx++;
						while (hdIdx < len && line[hdIdx] !== q) {
							delimRaw += line[hdIdx];
							hdIdx++;
						}
						if (hdIdx < len) {
							delimRaw += line[hdIdx];
							hdIdx++;
						}
					} else if (c === "\\" && hdIdx + 1 < len) {
						delimRaw += line.slice(hdIdx, hdIdx + 2);
						hdIdx += 2;
					} else {
						delimRaw += c;
						hdIdx++;
					}
				}
				const cleanDelim = unquoteWord(delimRaw);
				const isDelimQuoted = isQuoted(delimRaw);
				if (cleanDelim) {
					activeHereDocs.push({ delimiter: cleanDelim, isQuoted: isDelimQuoted, stripTabs });
				}
				currentRaw += line.slice(i, hdIdx);
				hasHereDoc = true;
				i = hdIdx;
				continue;
			}

			// Here-string: <<<
			if (dialect === "bash" && ch === "<" && line[i + 1] === "<" && line[i + 2] === "<") {
				hasInputRedirect = true;
				currentRaw += "<<<";
				i += 3;
				continue;
			}

			// Redirects: <, >, >>, >&, 2>&1, etc.
			if (ch === "<") {
				hasInputRedirect = true;
				currentRaw += "<";
				i++;
				while (i < len && /\s/.test(line[i])) {
					currentRaw += line[i];
					i++;
				}
				let target = "";
				while (i < len && !/[\s;&|<>()]/.test(line[i])) {
					target += line[i];
					i++;
				}
				currentRaw += target;
				continue;
			}

			if (ch === ">") {
				hasOutputRedirect = true;
				currentRaw += ">";
				i++;
				if (i < len && (line[i] === ">" || line[i] === "&")) {
					currentRaw += line[i];
					i++;
				}
				while (i < len && /\s/.test(line[i])) {
					currentRaw += line[i];
					i++;
				}
				let target = "";
				while (i < len && !/[\s;&|<>()]/.test(line[i])) {
					target += line[i];
					i++;
				}
				currentRaw += target;
				continue;
			}

			// Numbered redirect like 2>&1, 1>out, 0<in
			if (/\d/.test(ch) && (line[i + 1] === ">" || line[i + 1] === "<")) {
				const isInput = line[i + 1] === "<";
				if (isInput) hasInputRedirect = true;
				else hasOutputRedirect = true;

				currentRaw += line.slice(i, i + 2);
				i += 2;
				if (i < len && (line[i] === ">" || line[i] === "&")) {
					currentRaw += line[i];
					i++;
				}
				while (i < len && /\s/.test(line[i])) {
					currentRaw += line[i];
					i++;
				}
				let target = "";
				while (i < len && !/[\s;&|<>()]/.test(line[i])) {
					target += line[i];
					i++;
				}
				currentRaw += target;
				continue;
			}

			// Regular command / argument token
			const tokenStart = i;
			let token = "";

			while (i < len && !/\s/.test(line[i]) && !/[;&|<>()]/.test(line[i])) {
				const c = line[i];
				if (c === "'") {
					const qStart = i;
					i++;
					if (dialect === "powershell") {
						while (i < len) {
							if (line[i] === "'") {
								if (line[i + 1] === "'") {
									i += 2;
								} else {
									i++;
									break;
								}
							} else {
								i++;
							}
						}
					} else {
						while (i < len && line[i] !== "'") i++;
						if (i < len) i++;
					}
					token += line.slice(qStart, i);
				} else if (c === '"') {
					const qStart = i;
					i++;
					if (dialect === "powershell") {
						while (i < len) {
							if (line[i] === "`" && i + 1 < len) {
								i += 2;
							} else if (line[i] === '"') {
								if (line[i + 1] === '"') {
									i += 2;
								} else {
									i++;
									break;
								}
							} else if (line[i] === "$" && line[i + 1] === "(") {
								const sStart = i;
								i += 2;
								let d = 1;
								let innerCode = "";
								while (i < len && d > 0) {
									if (line[i] === "(") d++;
									else if (line[i] === ")") {
										d--;
										if (d === 0) {
											i++;
											break;
										}
									}
									innerCode += line[i];
									i++;
								}
								if (innerCode) subshellSnippets.push({ code: innerCode, dialect: "powershell" });
							} else {
								i++;
							}
						}
					} else {
						while (i < len && line[i] !== '"') {
							if (line[i] === "\\" && i + 1 < len) {
								i += 2;
							} else if (line[i] === "$" && line[i + 1] === "(") {
								const sStart = i;
								i += 2;
								let d = 1;
								let innerCode = "";
								while (i < len && d > 0) {
									if (line[i] === "(") d++;
									else if (line[i] === ")") {
										d--;
										if (d === 0) {
											i++;
											break;
										}
									}
									innerCode += line[i];
									i++;
								}
								if (innerCode) subshellSnippets.push({ code: innerCode, dialect: "bash" });
								continue;
							} else if (line[i] === "`") {
								i++;
								let innerCode = "";
								while (i < len && line[i] !== "`") {
									if (line[i] === "\\" && i + 1 < len) {
										innerCode += line[i + 1];
										i += 2;
									} else {
										innerCode += line[i];
										i++;
									}
								}
								if (i < len) i++;
								if (innerCode) subshellSnippets.push({ code: innerCode, dialect: "bash" });
								continue;
							} else {
								i++;
							}
						}
						if (i < len) i++;
					}
					token += line.slice(qStart, i);
				} else if (dialect === "bash" && c === "\\" && i + 1 < len) {
					token += line.slice(i, i + 2);
					i += 2;
				} else {
					token += c;
					i++;
				}
			}

			currentRaw += line.slice(tokenStart, i);
			if (token.length > 0) {
				currentTokens.push(token);
			}
		}

		lineIdx++;

		// If this line initiated here-doc(s), consume the full body
		if (activeHereDocs.length > 0) {
			for (const hd of activeHereDocs) {
				const bodyLines: string[] = [];
				while (lineIdx < rawLines.length) {
					const bodyLine = rawLines[lineIdx];
					const matchLine = hd.stripTabs ? bodyLine.replace(/^\t+/, "") : bodyLine;
					lineIdx++;
					if (matchLine === hd.delimiter) {
						// Here-doc delimiter reached
						break;
					}
					bodyLines.push(bodyLine);
				}
				// If delimiter was NOT quoted, perform multiline command substitution extraction
				if (!hd.isQuoted && bodyLines.length > 0) {
					const fullBody = bodyLines.join("\n");
					const snippets: string[] = [];
					extractSubshellsFromHereDocBody(fullBody, snippets);
					for (const s of snippets) {
						subshellSnippets.push({ code: s, dialect: "bash" });
					}
				}
			}
			flushSegment();
			isPipeTarget = false;
		} else {
			flushSegment();
			isPipeTarget = false;
		}
	}

	flushSegment();

	// Recursively parse any collected subshell, backtick, or script block snippets
	for (const sub of subshellSnippets) {
		const subSegments = parseCommandSegments(sub.code, sub.dialect);
		segments.push(...subSegments);
	}

	return segments;
}

/**
 * Extract the base executable name from a command token.
 */
function extractBaseCommand(cmdToken: string): string {
	if (!cmdToken) return "";
	const rawParts = cmdToken.split(/[/\\]/);
	const lastRaw = rawParts.pop() || cmdToken;
	const unquoted = unquoteWord(lastRaw);
	if (unquoted) return unquoted;
	const clean = unquoteWord(cmdToken);
	const cleanParts = clean.split(/[/\\]/);
	return cleanParts.pop() || clean;
}

/**
 * Known wrapper options that take an argument.
 */
const WRAPPER_OPTION_ARITY: Record<string, Set<string>> = {
	sudo: new Set([
		"-u",
		"--user",
		"-g",
		"--group",
		"-p",
		"--prompt",
		"-C",
		"--close-from",
		"-r",
		"--role",
		"-t",
		"--type",
		"-T",
		"--command-timeout",
		"-U",
		"--other-user",
		"-h",
		"--host",
	]),
	env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"]),
	xargs: new Set([
		"-n",
		"--max-args",
		"-I",
		"-i",
		"-s",
		"--max-chars",
		"-a",
		"--arg-file",
		"-d",
		"--delimiter",
		"-E",
		"-e",
		"-L",
		"-l",
		"--max-lines",
		"-P",
		"--max-procs",
		"--process-slot-var",
	]),
	nohup: new Set(),
	time: new Set(["-o", "--output", "-f", "--format"]),
	command: new Set([]), // -p, -v, -V take no option arguments
	builtin: new Set(),
};

/**
 * Extract clean base command and arguments from a segment's tokens,
 * recursively unwrapping nested wrappers (e.g. sudo env cat).
 */
function createSegment(
	tokens: string[],
	raw: string,
	isPipeTarget: boolean,
	hasInputRedirect: boolean,
	hasOutputRedirect: boolean,
	hasHereDoc: boolean,
	dialect: "bash" | "powershell" = "bash",
): CommandSegment {
	let cmdIndex = 0;

	// 1. Skip environment variable assignments (Bash)
	// and handle PowerShell variable assignments ($var = val, $var=val, $var =val, $var= val)
	while (cmdIndex < tokens.length) {
		const t = tokens[cmdIndex];
		if (dialect === "bash" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			cmdIndex++;
		} else if (dialect === "powershell" && t.startsWith("$")) {
			if (t.includes("=")) {
				const eqIdx = t.indexOf("=");
				const rhs = t.slice(eqIdx + 1);
				if (rhs) {
					// e.g. $x=Get-Content -> replace token with RHS command
					tokens[cmdIndex] = rhs;
					break;
				} else {
					// e.g. $x= Get-Content -> skip $x= and proceed to next token
					cmdIndex++;
				}
			} else if (cmdIndex + 1 < tokens.length) {
				const next = tokens[cmdIndex + 1];
				if (next === "=") {
					// e.g. $x = Get-Content -> skip $x and =
					cmdIndex += 2;
				} else if (next.startsWith("=")) {
					// e.g. $x =Get-Content -> replace next token with RHS command and skip $x
					const rhs = next.slice(1);
					if (rhs) {
						tokens[cmdIndex + 1] = rhs;
						cmdIndex++;
						break;
					} else {
						cmdIndex += 2;
					}
				} else {
					break;
				}
			} else {
				break;
			}
		} else {
			break;
		}
	}

	// 2. Handle PowerShell invocation operator '&' or '.'
	if (cmdIndex < tokens.length && (tokens[cmdIndex] === "&" || tokens[cmdIndex] === ".")) {
		cmdIndex++;
	}

	const cmdToken = tokens[cmdIndex] || "";
	let baseCmd = extractBaseCommand(cmdToken);

	let currentArgs = tokens.slice(cmdIndex + 1);

	// 3. Recursively unwrap wrappers: sudo, env, xargs, nohup, time, command, builtin
	while (true) {
		const lowerBase = baseCmd.toLowerCase();
		if (WRAPPER_OPTION_ARITY[lowerBase] === undefined || currentArgs.length === 0) {
			break;
		}

		const aritySet = WRAPPER_OPTION_ARITY[lowerBase];
		let subIdx = 0;

		while (subIdx < currentArgs.length) {
			const arg = currentArgs[subIdx];
			const unquotedArg = unquoteWord(arg);

			if (unquotedArg === "--") {
				subIdx++;
				break;
			}

			// Check if arg is --option=value
			if (unquotedArg.startsWith("--") && unquotedArg.includes("=")) {
				subIdx++;
				continue;
			}

			// Check if option takes an argument
			if (aritySet.has(unquotedArg)) {
				subIdx += 2;
				continue;
			}

			// Generic single-dash options or env assignments (e.g. -p, FOO=BAR)
			if (unquotedArg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(unquotedArg)) {
				subIdx++;
				continue;
			}

			// Found target command
			break;
		}

		if (subIdx < currentArgs.length) {
			baseCmd = extractBaseCommand(currentArgs[subIdx]);
			currentArgs = currentArgs.slice(subIdx + 1);
		} else {
			break;
		}
	}

	return {
		command: baseCmd,
		args: currentArgs,
		isPipeTarget,
		hasInputRedirect,
		hasOutputRedirect,
		hasHereDoc,
		raw,
	};
}

/**
 * Check if a bash/powershell command violates the tool-discipline policy.
 */
export function checkDisciplineViolation(
	command: string,
	dialect: "bash" | "powershell" = "bash",
): BlockResult {
	if (!command || typeof command !== "string") {
		return { block: false };
	}

	const segments = parseCommandSegments(command, dialect);

	for (const seg of segments) {
		const rawCmd = seg.command;
		const cmd = rawCmd.toLowerCase();

		// 1. Prohibited: ls / dir / Get-ChildItem / gci
		if (cmd === "ls" || cmd === "dir" || cmd === "get-childitem" || cmd === "gci") {
			return {
				block: true,
				prohibitedCommand: rawCmd,
				reason: `Tool discipline violation: Prohibited bash command '${rawCmd}'. Please use the 'ls' tool (or 'fffind') to inspect directories instead of running ls in bash.`,
			};
		}

		// 2. Prohibited: find (file finding)
		if (cmd === "find") {
			return {
				block: true,
				prohibitedCommand: rawCmd,
				reason: `Tool discipline violation: Prohibited bash command 'find'. Please use 'fffind' (or the 'find' tool) to search for files instead of running find in bash.`,
			};
		}

		// 3. Prohibited: grep / egrep / fgrep / Select-String / sls
		if (["grep", "egrep", "fgrep", "select-string", "sls"].includes(cmd)) {
			return {
				block: true,
				prohibitedCommand: rawCmd,
				reason: `Tool discipline violation: Prohibited bash command '${rawCmd}'. Please use 'ffgrep' (or the 'grep' tool) for searching file contents. If searching command output in bash pipelines is unavoidable, use 'rg' instead of grep.`,
			};
		}

		// 4. Prohibited: cat / type / Get-Content / gc
		if (["cat", "type", "get-content", "gc"].includes(cmd)) {
			// A pure here-doc write has hasHereDoc AND hasOutputRedirect, and NO file input redirects, and NO file positional args.
			const positionalArgs = seg.args.filter((a) => {
				const unq = unquoteWord(a);
				return !unq.startsWith("-") && !unq.startsWith("<") && !unq.startsWith(">");
			});

			const isPureHereDocWrite =
				seg.hasHereDoc && !seg.hasInputRedirect && seg.hasOutputRedirect && positionalArgs.length === 0;

			if (!isPureHereDocWrite) {
				return {
					block: true,
					prohibitedCommand: rawCmd,
					reason: `Tool discipline violation: Prohibited bash command '${rawCmd}'. Please use the 'read' tool to inspect file contents instead of running cat in bash.`,
				};
			}
		}

		// 5. Prohibited: sed
		if (cmd === "sed") {
			return {
				block: true,
				prohibitedCommand: rawCmd,
				reason: `Tool discipline violation: Prohibited bash command 'sed'. Please use the 'edit' tool for precise file edits or the 'read' tool to inspect files instead of running sed in bash.`,
			};
		}

		// 6. Prohibited: which / where / where.exe
		if (cmd === "which" || cmd === "where" || cmd === "where.exe") {
			return {
				block: true,
				prohibitedCommand: rawCmd,
				reason: `Tool discipline violation: Prohibited bash command '${rawCmd}'. Please check tool availability using standard Node/API methods rather than running which in bash.`,
			};
		}

		// 7. Prohibited: head / tail when directly reading files (not in a pipeline target)
		if (["head", "tail"].includes(cmd)) {
			if (!seg.isPipeTarget) {
				return {
					block: true,
					prohibitedCommand: rawCmd,
					reason: `Tool discipline violation: Prohibited bash command '${rawCmd}' directly on files. Please use the 'read' tool with offset and limit parameters instead.`,
				};
			}
		}
	}

	return { block: false };
}
