import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// the bytes GNU sed 4.9 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C.UTF-8. The outputs are Latin-1 strings, one
// character to a byte: `"\xc3\x9f"` is the two bytes of `ß`. stderr is
// dropped, unless a command sends it to stdout itself (`2>&1`).

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-r10-"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell with stdout sent to a file, whose bytes
 * are returned: the shell streams its output to the callback as text.
 */
async function run(command: string): Promise<{ output: Buffer; exitCode: number | undefined }> {
	const result = await executeShell({ command: `{ ${command}\n} >out 2>/dev/null`, cwd: dir }, () => {});
	return { output: await fs.readFile(path.join(dir, "out")), exitCode: result.exitCode };
}

type Case = [command: string, output: string, exitCode: number];

function cases(list: Case[]) {
	it.each(list)("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output: Buffer.from(output, "latin1"), exitCode });
	});
}

/** Writes `f1` (`a`) and `f2` (`b`, `c`), runs `sed -i SCRIPT f1 f2`, and prints both files. */
const inPlace = (script: string) => `printf 'a\\n' >f1; printf 'b\\nc\\n' >f2; sed -i '${script}' f1 f2; cat f1 f2`;

describe("builtin sed: -i over several files edits each on its own", () => {
	cases([
		// Regressed: `n` on the last line of `f1` runs the rest of the script on the first line of `f2`, which `d` deletes; GNU keeps `b`.
		[inPlace("n;d"), "a\nb\n", 0],
		// Regressed: `N` joins the last line of `f1` to the first of `f2`, and `f1` is left empty.
		[inPlace("N;s/\\n/+/"), "a\nb+c\n", 0],
		// Regressed: `$` is the last line of `f2` alone, so `f1` keeps its last line unmarked.
		[inPlace("$s/$/!/"), "a!\nb\nc!\n", 0],
		// Regressed: line numbers run on across the files, so `f2` has no line 1.
		[inPlace("1s/^/>/"), ">a\n>b\nc\n", 0],
		// Regressed: the same for line 2, which is `b` in the count across the files.
		[inPlace("2d"), "a\nb\n", 0],
		// Regressed: `$d` keeps the last line of `f1`.
		[inPlace("$d"), "b\n", 0],
	]);
});

describe("builtin sed: \\U, \\L, \\u and \\l map one character to one", () => {
	cases([
		// Regressed: `ß` becomes `SS`; GNU leaves it as it is.
		[String.raw`printf 'stra\303\237e\n' | sed 's/.*/\U&/'`, "STRA\xc3\x9fE\n", 0],
		// Regressed: the ligature `ﬁ` becomes `FI`; GNU leaves it as it is.
		[String.raw`printf '\357\254\201\n' | sed 's/.*/\U&/'`, "\xef\xac\x81\n", 0],
		// Regressed: `İ` becomes `i` and a combining dot; GNU writes `i`.
		[String.raw`printf '\304\260\n' | sed 's/.*/\L&/'`, "i\n", 0],
		// Regressed: the same for `\l`.
		[String.raw`printf '\304\260X\n' | sed 's/.*/\l&/'`, "iX\n", 0],
		// Regressed: `ᾳ` becomes `ΑΙ`; GNU writes the capital with prosgegrammeni, `ᾼ`.
		[String.raw`printf '\341\276\263\n' | sed 's/.*/\U&/'`, "\xe1\xbe\xbc\n", 0],
		// Regressed: the same for `\u`.
		[String.raw`printf '\341\276\263x\n' | sed 's/.*/\u&/'`, "\xe1\xbe\xbcx\n", 0],
	]);
});

describe("builtin sed: s///e strips the record delimiter", () => {
	cases([
		// Regressed: under -z the newline `echo` ends with is stripped; GNU strips a NUL and keeps it.
		[String.raw`printf 'x\0' | sed -z 's/x/echo y/e'`, "y\n\0", 0],
		// Regressed: the NUL the command ends with is kept, and the record gains a second one.
		[String.raw`printf 'x\0' | sed -z 's/x/printf "y\\0"/e'`, "y\0", 0],
		// Regressed: a `\r` before the newline is stripped too, where GNU strips the newline alone.
		[String.raw`printf 'x\n' | sed 's/x/printf "y\\r\\n"/e'`, "y\r\n", 0],
	]);
});

describe("builtin sed: errors as GNU reports them", () => {
	cases([
		// Regressed: a class name without its outer brackets is reported (exit 4) before the backwards range after it; GNU reports "Invalid range end" and exits 1.
		[String.raw`echo x | sed 's/[:alpha:][z-a]/x/'`, "", 1],
		// Alone it is the class-syntax error, exit 4.
		[String.raw`echo x | sed 's/[:alpha:]/x/'`, "", 4],
		// Regressed: a jump to a label no `:` defines is "undefined label", with a script position.
		[String.raw`echo a | sed -n 'ba' 2>&1`, "sed: can't find label for jump to `a'\n", 4],
	]);
});

describe("builtin sed: the pattern dialect shared with grep", () => {
	cases([
		// Regressed: `^` after `\<` anchors, so `a` is replaced; GNU reads the caret as text and changes nothing.
		[String.raw`printf 'a\n' | sed 's/\<^a/X/'`, "a\n", 0],
		// Regressed: after `` \` `` the caret is text, found in the line `^a`.
		[String.raw`printf 'a\n^a\n' | sed 's/\`^a/X/'`, "a\nX\n", 0],
		// Regressed: under `I` the range `[a-Z]` is refused; GNU's runs from `A` to `Z`.
		[String.raw`printf 'b\n' | sed 's/[a-Z]/x/I'`, "x\n", 0],
		// Regressed: under `I` the range `[A-z]` holds `_`; GNU's does not.
		[String.raw`printf '_\n' | sed 's/[A-z]/x/I'`, "_\n", 0],
		// Regressed: under `I` `[[:lower:]]` is `[[:alpha:]]` to GNU, which `中` is.
		[String.raw`printf '\344\270\255\n' | sed 's/[[:lower:]]/X/I'`, "X\n", 0],
	]);
});

describe("builtin sed: a pattern of groups nested past the engine's limit", () => {
	// GNU sed 4.9 itself crashes on this pattern (exit 139), so the
	// expectation is the builtin's own refusal: an invalid regex, exit 1, and
	// no output. The shell runs in a child process, which a crash ends alone.
	it("is refused with exit 1, and the process lives on", async () => {
		// Regressed: splitting the pattern into its branches recurses once a group, so 100,000 nested groups with a `|` overflow the stack, which aborts the whole process, the bash tool's host with it.
		const depth = 100_000;
		await fs.writeFile(path.join(dir, "deep.sed"), `s/${"(".repeat(depth)}a|b${")".repeat(depth)}/X/\n`);
		const addon = path.join(import.meta.dir, "../native/index.js");
		const child = path.join(dir, "deep.mjs");
		await fs.writeFile(
			child,
			[
				`import { executeShell } from ${JSON.stringify(addon)};`,
				`const command = "echo a | sed -E -f deep.sed >out 2>/dev/null";`,
				`const result = await executeShell({ command, cwd: ${JSON.stringify(dir)} }, () => {});`,
				"console.log(result.exitCode);",
			].join("\n"),
		);
		await fs.rm(path.join(dir, "out"), { force: true });
		const shell = Bun.spawn([process.execPath, child], { stdout: "pipe", stderr: "ignore" });
		const [stdout, exitCode] = await Promise.all([new Response(shell.stdout).text(), shell.exited]);
		expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "1\n" });
		expect(await fs.readFile(path.join(dir, "out"))).toEqual(Buffer.alloc(0));
	}, 60_000);
});
