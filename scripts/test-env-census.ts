#!/usr/bin/env bun
/**
 * Census of the environment variable names the product source reads: every
 * `packages/<name>/src` file (TypeScript, JavaScript and Python), tests and
 * fixtures left out. `scripts/test-env-names.json` holds its result, the names
 * grouped by the file that reads each first, which `scripts/test-env.ts` removes
 * from every test process. Grouped, no line pairs a name such as `*_API_KEY` with
 * a value, which the public leak check reads as a credential.
 *
 *   bun scripts/test-env-census.ts           check: exit 1 when the file is stale
 *   bun scripts/test-env-census.ts --write   rewrite the file
 *
 * It finds a name only where the source spells it: `process.env.X`, `Bun.env.X`,
 * `$env.X`, `env.X` and their `["X"]` forms, `$flag("X")`, `$envpos("X")`,
 * `getEnv*("X")`, `"X" in env`, destructuring (`const { X } = env`), a setting's
 * `env: { name: "X" }` override, and Python's `os.environ` / `os.getenv`. A name in a `//` or `/* *\/` comment (a JSDoc
 * example) is not a read and is left out. It cannot see a name built at run time
 * (`env[name]`, a prefix loop over `Object.keys(env)`), nor a read in Rust or
 * shell code; `scripts/test-env.ts` covers those with prefixes and a short list of
 * its own.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const outputPath = path.join(import.meta.dir, "test-env-names.json");
const NAME = "[A-Z_][A-Z0-9_]*";
/** The objects a read goes through, including an `env`/`environment` parameter that defaults to `process.env`. */
const ENV_OBJECT = "(?:process\\.env|Bun\\.env|\\$env|\\benv|\\benvironment)\\b";

const scriptPatterns: RegExp[] = [
	new RegExp(`${ENV_OBJECT}\\.(${NAME})`, "g"),
	new RegExp(`${ENV_OBJECT}\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g"),
	new RegExp(`\\$(?:flag|envpos)\\(\\s*["'\`](${NAME})["'\`]`, "g"),
	new RegExp(`getEnv\\w*\\(\\s*["'\`](${NAME})["'\`]`, "g"),
	new RegExp(`["'\`](${NAME})["'\`]\\s+in\\s+${ENV_OBJECT}`, "g"),
	// A setting's environment override, which the settings registry reads for it.
	new RegExp(`\\benv:\\s*\\{\\s*name:\\s*["'\`](${NAME})["'\`]`, "g"),
];
const destructuring = new RegExp(`(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*${ENV_OBJECT}`, "g");
const pythonPatterns: RegExp[] = [
	new RegExp(`(?:os\\.)?environ\\.get\\(\\s*["'](${NAME})["']`, "g"),
	new RegExp(`os\\.getenv\\(\\s*["'](${NAME})["']`, "g"),
	new RegExp(`(?:os\\.)?environ\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
];

/**
 * `text` with its `//` and `/* *\/` comments removed, string and template literal contents
 * kept as written, including the code of a template's `${…}`.
 */
function stripComments(text: string): string {
	let out = "";
	// What encloses the position: a quote that opened a string, `${` for a template's
	// expression, or `{` for a brace inside one. Empty at the top level of the code.
	const open: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		const enclosing = open.at(-1);
		if (enclosing === '"' || enclosing === "'" || enclosing === "`") {
			out += char;
			if (char === "\\") {
				out += text[i + 1] ?? "";
				i++;
			} else if (enclosing === "`" && char === "$" && text[i + 1] === "{") {
				out += "{";
				i++;
				open.push("${");
			} else if (char === enclosing) {
				open.pop();
			}
			continue;
		}
		if (char === "/" && text[i + 1] === "/") {
			const end = text.indexOf("\n", i);
			i = end === -1 ? text.length : end - 1;
			continue;
		}
		if (char === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
			out += " ";
			continue;
		}
		out += char;
		if (char === '"' || char === "'" || char === "`") open.push(char);
		else if (char === "{" && enclosing !== undefined) open.push("{");
		else if (char === "}" && enclosing !== undefined) open.pop();
	}
	return out;
}

/** Reading file of each name: the first one in path order, so the output is stable. */
function census(): Record<string, string> {
	const found = new Map<string, string>();
	const note = (name: string, file: string): void => {
		// Single letters and two-letter words are regex noise (`env.C`), not variables.
		if (name.length < 3) return;
		const previous = found.get(name);
		if (previous === undefined || file < previous) found.set(name, file);
	};
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (["test", "tests", "bench", "fixtures", "__tests__"].includes(entry.name)) continue;
				walk(full);
				continue;
			}
			const file = path.relative(repoRoot, full).split(path.sep).join("/");
			const isScript = /\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name);
			const isPython = entry.name.endsWith(".py") && !entry.name.startsWith("test_");
			if (!isScript && !isPython) continue;
			const source = fs.readFileSync(full, "utf8");
			const text = isScript ? stripComments(source) : source;
			for (const pattern of isScript ? scriptPatterns : pythonPatterns) {
				for (const match of text.matchAll(pattern)) note(match[1]!, file);
			}
			if (!isScript) continue;
			for (const match of text.matchAll(destructuring)) {
				for (const key of match[1]!.matchAll(/(?:^|,)\s*([A-Z_][A-Z0-9_]*)\s*(?=[,:=]|$)/g)) note(key[1]!, file);
			}
		}
	};
	for (const pkg of fs.readdirSync(path.join(repoRoot, "packages"))) {
		const src = path.join(repoRoot, "packages", pkg, "src");
		if (fs.existsSync(src)) walk(src);
	}
	return Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The names of {@link census} under the file that reads each, files and names in order. */
function byFile(names: Record<string, string>): Record<string, string[]> {
	const grouped: Record<string, string[]> = {};
	for (const [name, file] of Object.entries(names)) (grouped[file] ??= []).push(name);
	return Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const result = `${JSON.stringify(byFile(census()), null, "\t")}\n`;
if (process.argv.includes("--write")) {
	fs.writeFileSync(outputPath, result);
	console.log(`wrote ${path.relative(repoRoot, outputPath)}`);
} else {
	const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
	if (current !== result) {
		console.error(
			`${path.relative(repoRoot, outputPath)} is stale: the product reads a different set of environment variables. Run: bun scripts/test-env-census.ts --write`,
		);
		process.exit(1);
	}
	console.log(`${path.relative(repoRoot, outputPath)} is current`);
}
