# pi-tool-discipline

<p align="center">
  <img src="assets/banner.png" alt="pi-tool-discipline" width="600">
</p>

pi extension that enforces a **search-tools-first discipline** and removes the
conflicting "use bash for file operations" guidance pi injects by default.

## Why

Pi's system-prompt builder only injects
`Use bash for file operations like ls, rg, find` when **no tool named
`grep` / `find` / `ls` is active** ([dist/core/system-prompt.js]). FFF-style
search tools are named `ffgrep` / `fffind`, so pi mistakes them for "no search
tool available" and tells the model to use bash for everything — directly
fighting project instructions (like an `AGENTS.md` that says "use the grep
tool, not bash").

## How it works

Two mechanisms, applied automatically in every session:

1. **Activate search tools (root fix).** pi 0.84+ ships real `grep` / `find` /
   `ls` built-in tool definitions but only activates `read`/`bash`/`edit`/
   `write` by default. This extension activates the built-ins, so pi's
   `hasGrep`/`hasFind`/`hasLs` check passes and the conflicting
   `Use bash for file operations like ls, rg, find` guideline is **never
   generated** — the model is never told to use bash for searching. On older
   pi versions without these built-ins, fs-based fallbacks
   (`extensions/search.ts`) are registered instead, with their text snippet
   suppressed while `ffgrep`/`fffind` from pi-fff are active (the registered
   tool schema remains present either way).
2. **System-prompt injection (rules).** On every agent start, appends an
   idempotent "Tool Discipline" section to the system prompt: content search
   with `ffgrep`, path search with `fffind`, file reads with `read`
   (offset/limit), no bash `grep`/`rg`/`find`/`ls`/`cat`/`sed`/`head`/`tail`/
   `which` for searching, bash reserved for pipelines/git/npm/network, `rg`
   (never `grep`) as the last resort. Also strips the bash guideline text as
   a belt-and-suspenders fallback.

## Install

```bash
pi install npm:pi-tool-discipline
# or try without installing:
pi -e npm:pi-tool-discipline
```

Requires nothing extra. With `@ff-labs/pi-fff` installed, the model prefers
`ffgrep`/`fffind`; without it, Pi's built-in `grep`/`find`/`ls` tools (activated
by this extension, or fs-based fallbacks on older pi versions) are used.

## Verify

Run `/tool-discipline` in a pi session — it reports whether the placeholder
tools are registered and whether the discipline section is injected.

You can also inspect the system prompt: the string
`Use bash for file operations like ls, rg, find` should no longer appear, and
`## Tool Discipline (pi-tool-discipline)` should be present.

## Security

This extension runs with full system access like any pi extension. What it does:
- Activates pi's built-in `grep`/`find`/`ls` tools (read-only file search).
- Injects text into the system prompt (discipline rules).
- On pi versions without built-in search tools, registers read-only fs-based
  fallback implementations that read file contents under the searched path.

**Disclosure:** pi's built-in `grep`/`find` tools execute the `rg`/`fd`
binaries, and pi may auto-download those binaries from GitHub on first use
(`ensureTool`). This extension itself does not execute commands, write files,
or touch the network — that claim covers only its own fs-based fallback
implementations, not the pi built-ins it activates.

The fallback search tools only read. Note that any installed tool, including
this one, can be invoked by the model. Review the source in `extensions/`
before installing.

## License

MIT
