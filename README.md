# pi-tool-discipline

pi extension that enforces a **search-tools-first discipline** and removes the
conflicting "use bash for file operations" guidance pi injects by default.
**Prompt-level only: it activates the right tools and edits the system prompt;
it does not intercept or parse bash commands.**

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

1. **Activate search tools (root fix).** pi >= 0.84 ships real `grep` / `find` /
   `ls` built-in tool definitions but only activates `read`/`bash`/`edit`/
   `write` by default. This extension activates the built-ins, so pi's
   `hasGrep`/`hasFind`/`hasLs` check passes and the conflicting
   `Use bash for file operations like ls, rg, find` guideline is **never
   generated** — the model is never told to use bash for searching.
2. **System-prompt injection (rules).** On every agent start, appends an
   idempotent "Tool Discipline" section to the system prompt: content search
   with `ffgrep`, path search with `fffind`, file reads with `read`
   (offset/limit), no bash `grep`/`find`/`ls`/`cat`/`sed`/`head`/`tail`/
   `which` for searching or reading, bash reserved for pipelines/git/npm/network, `rg`
   (never `grep`) as the last resort in pipelines. Also strips the bash guideline text as
   a belt-and-suspenders fallback.

## Why no bash interception?

Earlier versions (<= 0.1.x) added a runtime guard: a hand-written
bash/PowerShell command parser that blocked prohibited file operations at
`tool_call` time. Maintaining a parser that precisely recognizes nested
subshells, here-docs, wrappers and redirects — without misjudging legitimate
pipelines — grew to ~1000 lines and became a hang/freeze risk (a stray `)` in
a command could spin the event loop at 100% CPU, freezing the whole session).

Behavior guidance at the prompt level is probabilistic but safe; code-level
enforcement would require near-complete shell parsing — impractical and
hazardous. The activation + injection mechanisms above already remove the
root cause (pi no longer tells the model to use bash), so interception added
little value. This version drops it entirely: no command parsing, no
interception, no hang surface.

## Install

```bash
pi install npm:pi-tool-discipline
# or try without installing:
pi -e npm:pi-tool-discipline
```

Requires **pi >= 0.84** (built-in `grep`/`find`/`ls` definitions). With
`@ff-labs/pi-fff` installed, the model prefers `ffgrep`/`fffind`; without it,
Pi's built-in `grep`/`find`/`ls` tools (activated by this extension) are used.

## Verify

Run `/tool-discipline` in a pi session — it reports whether the search tools
are registered/active and whether the discipline section is injected.

You can also inspect the system prompt: the string
`Use bash for file operations like ls, rg, find` should no longer appear, and
`## Tool Discipline (pi-tool-discipline)` should be present.

## Security

This extension runs with full system access like any pi extension. What it does:
- Activates pi's built-in `grep`/`find`/`ls` tools (read-only file search).
- Injects text into the system prompt (discipline rules).

It executes no commands, writes no files, and touches no network.

## License

MIT
