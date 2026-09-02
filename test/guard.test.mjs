import assert from "node:assert/strict";
import { checkDisciplineViolation } from "../extensions/guard.ts";

function test(name, fn) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}:`, e);
		process.exit(1);
	}
}

// 1. Basic prohibited commands
test("blocks simple ls", () => {
	const res = checkDisciplineViolation("ls -la ~/.pi/agent/");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks find in filesystem", () => {
	const res = checkDisciplineViolation("find ~ -maxdepth 3 -name '*pi-agent-desktop*'");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "find");
});

test("blocks cat reading file", () => {
	const res = checkDisciplineViolation("cat ~/.pi/agent/settings.json");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks grep", () => {
	const res = checkDisciplineViolation("grep -rn 'pattern' src/");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "grep");
});

test("blocks sed", () => {
	const res = checkDisciplineViolation("sed -i 's/foo/bar/g' test.txt");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "sed");
});

test("blocks which", () => {
	const res = checkDisciplineViolation("which gh");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "which");
});

test("blocks head on file", () => {
	const res = checkDisciplineViolation("head -n 20 src/index.ts");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "head");
});

test("blocks tail on file", () => {
	const res = checkDisciplineViolation("tail -50 /var/log/app.log");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "tail");
});

// 2. Escapes, Quotes & Redirects bypass prevention
test("blocks redirect attached to command: ls>/tmp/list", () => {
	const res = checkDisciplineViolation("ls>/tmp/list");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks redirect input: cat</etc/hosts", () => {
	const res = checkDisciplineViolation("cat</etc/hosts");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks normal input redirect even with output redirect: cat </etc/passwd >/tmp/copy", () => {
	const res = checkDisciplineViolation("cat </etc/passwd >/tmp/copy");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks here-doc with input redirect: cat <<EOF </etc/passwd >/tmp/copy", () => {
	const res = checkDisciplineViolation("cat <<EOF </etc/passwd >/tmp/copy\nignored\nEOF");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks leading output redirect: >/tmp/list ls", () => {
	const res = checkDisciplineViolation(">/tmp/list ls");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks quoted executable path: '/bin/ls'", () => {
	const res = checkDisciplineViolation('"/bin/ls" -la');
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks escaped command: \\ls", () => {
	const res = checkDisciplineViolation("\\ls -la");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

// 3. Subshells, Command Substitutions & Groupings
test("blocks command in $(cat file)", () => {
	const res = checkDisciplineViolation('echo "$(cat /etc/hosts)"');
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks command in files=$(find . -name '*.ts')", () => {
	const res = checkDisciplineViolation("files=$(find . -name '*.ts')");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "find");
});

test("blocks command in backticks: echo `ls`", () => {
	const res = checkDisciplineViolation("echo `ls`");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks parenthesized grouping: (ls)", () => {
	const res = checkDisciplineViolation("(ls -la)");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

// 4. Here-doc handling
test("allows legitimate here-doc write even with prohibited keywords in body", () => {
	const script = `cat <<'EOF' > script.sh
ls -la /tmp
cat /etc/passwd
find . -name "*.js"
EOF`;
	const res = checkDisciplineViolation(script);
	assert.equal(res.block, false);
});

test("allows here-doc write with numbered redirect: 1>/tmp/out", () => {
	const script = `cat <<'EOF' 1>/tmp/out
some text
EOF`;
	const res = checkDisciplineViolation(script);
	assert.equal(res.block, false);
});

test("blocks cat reading a file even with here-doc appended", () => {
	const res = checkDisciplineViolation("cat README.md <<EOF\nfoo\nEOF");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks commands following a here-doc", () => {
	const script = `python3 - <<'PY'
print("ok")
PY
ls`;
	const res = checkDisciplineViolation(script);
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks multiline command substitutions inside unquoted here-doc body", () => {
	const script = `cat <<EOF >out
$(
ls
)
EOF`;
	const res = checkDisciplineViolation(script);
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks multiline command substitutions with escaped parentheses inside unquoted here-doc", () => {
	const script = `cat <<EOF >out
$(echo \\)
ls
)
EOF`;
	const res = checkDisciplineViolation(script);
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("allows escaped substitutions in unquoted here-doc body", () => {
	const script = `cat <<EOF >out
\\$(ls)
\\\`cat file\\\`
EOF`;
	const res = checkDisciplineViolation(script);
	assert.equal(res.block, false);
});

// 5. Shell wrappers: sudo, env, xargs, command, builtin
test("blocks sudo with option arguments: sudo -u root ls", () => {
	const res = checkDisciplineViolation("sudo -u root ls -la");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks env with space option: env --unset FOO cat file", () => {
	const res = checkDisciplineViolation("env --unset FOO cat file");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks env with equals option: env --unset=FOO cat file", () => {
	const res = checkDisciplineViolation("env --unset=FOO cat file");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks xargs with long options: echo dir | xargs --max-args 1 ls", () => {
	const res = checkDisciplineViolation("echo dir | xargs --max-args 1 ls");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks command with -p option: command -p ls", () => {
	const res = checkDisciplineViolation("command -p ls");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "ls");
});

test("blocks nested wrappers: sudo env cat /etc/passwd", () => {
	const res = checkDisciplineViolation("sudo env cat /etc/passwd");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

test("blocks builtin wrapper: builtin cat file", () => {
	const res = checkDisciplineViolation("builtin cat file");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "cat");
});

// 6. PowerShell syntax
test("blocks PowerShell Get-ChildItem in assignment with spaces", () => {
	const res = checkDisciplineViolation("$x = Get-ChildItem", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-ChildItem");
});

test("blocks PowerShell Get-Content in assignment without spaces: $x=Get-Content secret.txt", () => {
	const res = checkDisciplineViolation("$x=Get-Content secret.txt", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-Content");
});

test("blocks PowerShell Get-Content in assignment with mixed spaces: $x =Get-Content secret.txt", () => {
	const res = checkDisciplineViolation("$x =Get-Content secret.txt", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-Content");
});

test("blocks PowerShell Get-Content in assignment with trailing space: $x= Get-Content secret.txt", () => {
	const res = checkDisciplineViolation("$x= Get-Content secret.txt", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-Content");
});

test("blocks PowerShell call operator & 'Get-ChildItem'", () => {
	const res = checkDisciplineViolation("& 'Get-ChildItem' -Path .", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-ChildItem");
});

test("blocks PowerShell Script Block: & { Get-Content secret.txt }", () => {
	const res = checkDisciplineViolation("& { Get-Content secret.txt }", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-Content");
});

test("blocks PowerShell Script Block with tight assignment: & { $x=Get-Content secret.txt }", () => {
	const res = checkDisciplineViolation("& { $x=Get-Content secret.txt }", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-Content");
});

test("blocks top-level PowerShell with backslash path inside double quotes", () => {
	const res = checkDisciplineViolation('Write-Output "\\"; Get-Content secret.txt', "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-Content");
});

test("blocks Windows where.exe path", () => {
	const res = checkDisciplineViolation("C:\\Windows\\System32\\where.exe foo", "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "where.exe");
});

test("blocks PowerShell subexpression Write-Output $(Get-Content file)", () => {
	const res = checkDisciplineViolation('Write-Output "$(Get-Content secret.txt)"', "powershell");
	assert.equal(res.block, true);
	assert.equal(res.prohibitedCommand, "Get-Content");
});

// 7. Legitimate commands that MUST NOT be blocked
test("allows npm test with pipe tail", () => {
	const res = checkDisciplineViolation("npm test 2>&1 | tail -20");
	assert.equal(res.block, false);
});

test("allows gh run view with pipe head", () => {
	const res = checkDisciplineViolation("gh run view 33488404300 | head -10");
	assert.equal(res.block, false);
});

test("allows git commit with message containing prohibited words", () => {
	const res = checkDisciplineViolation('git commit -m "fix: which grep cat ls was causing issues"');
	assert.equal(res.block, false);
});

test("allows gh pr create with body containing prohibited words", () => {
	const res = checkDisciplineViolation(
		'gh pr create --repo Chasen-Liao/pi-agent-desktop --title "fix" --body "which only discovers built-in providers"',
	);
	assert.equal(res.block, false);
});

test("allows node -e script execution", () => {
	const res = checkDisciplineViolation('node -e "const fs = require(\'fs\'); console.log(fs.readdirSync(\'.\'));"');
	assert.equal(res.block, false);
});

test("allows python script execution", () => {
	const res = checkDisciplineViolation("python3 - << 'EOF'\nimport sys\nprint(sys.version)\nEOF");
	assert.equal(res.block, false);
});

test("allows Bash tokens starting with dollar and equal without false positive", () => {
	const res = checkDisciplineViolation("echo $x=cat", "bash");
	assert.equal(res.block, false);
});

test("allows standard tools: git, npm, tsc, curl, rg", () => {
	assert.equal(checkDisciplineViolation("git status").block, false);
	assert.equal(checkDisciplineViolation("npm run build").block, false);
	assert.equal(checkDisciplineViolation("npx tsc --noEmit").block, false);
	assert.equal(checkDisciplineViolation("curl -i -s http://127.0.0.1:3000").block, false);
	assert.equal(checkDisciplineViolation("rg 'pattern' src/").block, false);
	assert.equal(checkDisciplineViolation("git log | rg 'fix'").block, false);
});

console.log("\nAll guard tests passed.");
