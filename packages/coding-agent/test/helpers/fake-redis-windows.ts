/**
 * `RedisSessionStorage`'s Lua scripts as a Redis 7 server runs them, for the
 * hand-rolled Redis doubles: a small interpreter of the Lua those scripts use
 * runs the script an `EVAL` sends on the double's keyspace, one command at a
 * time, so a test sees what a server does with each script, down to what the
 * script leaves when one of its commands fails. A Lua string holds bytes: here
 * a JS string of one character per byte (latin1), turned to and from the
 * keyspace's text at each command and at the script's reply.
 */

/** The keyspace a Redis double holds: its string keys and its hashes. */
export interface FakeRedisKeyspace {
	readonly strings: Map<string, string>;
	readonly hashes: Map<string, Map<string, string>>;
}

/** A value of the scripts' Lua: nil is `undefined`, a string its bytes one per character, a table a Map. */
type LuaValue = undefined | boolean | number | string | LuaTable | LuaFunction | LuaPairs;
type LuaTable = Map<LuaValue, LuaValue>;
/** A function: its one result, or {@link LuaResults} when it has several. */
type LuaFunction = (...args: LuaValue[]) => LuaValue | LuaResults;

/** The results of a function that returns more than one value (`string.match`'s captures). */
class LuaResults {
	constructor(readonly values: LuaValue[]) {}
}

/** What `ipairs` gives a generic `for`: a table's entries from 1 up to its first nil. */
class LuaPairs {
	constructor(readonly entries: ReadonlyArray<[number, LuaValue]>) {}
}

/** A block's variables, then its enclosing block's, up to the globals (the scope without a parent). */
interface LuaScope {
	readonly vars: Map<string, LuaValue>;
	readonly parent: LuaScope | undefined;
}

type LuaExpr = (scope: LuaScope) => LuaValue;
/** The values of a list of expressions, with every result of the last one when it is a call. */
type LuaExprList = (scope: LuaScope) => LuaValue[];

const LUA_BREAK = Symbol("break");
/** Where a statement leaves its block: at a `return` (with its value), at a `break`, or at its end (`undefined`). */
type LuaFlow = { value: LuaValue } | typeof LUA_BREAK | undefined;
type LuaStatement = (scope: LuaScope) => LuaFlow;

/** An expression as a statement's target: its value, and how to set the variable or field it names (none for a call). */
interface LuaTarget {
	readonly get: LuaExpr;
	readonly assign?: (scope: LuaScope, value: LuaValue) => void;
	readonly call?: true;
}

interface LuaToken {
	kind: "name" | "number" | "string" | "symbol" | "eof";
	text: string;
}

const LUA_KEYWORDS = new Set([
	"and",
	"break",
	"do",
	"else",
	"elseif",
	"end",
	"false",
	"for",
	"function",
	"if",
	"in",
	"local",
	"nil",
	"not",
	"or",
	"repeat",
	"return",
	"then",
	"true",
	"until",
	"while",
]);

/** Each binary operator's precedence, lowest first; a unary operator binds tighter than every one. */
const LUA_BINARY = new Map<string, number>([
	["or", 1],
	["and", 2],
	["<", 3],
	[">", 3],
	["<=", 3],
	[">=", 3],
	["~=", 3],
	["==", 3],
	["..", 4],
	["+", 5],
	["-", 5],
	["*", 6],
	["/", 6],
	["%", 6],
]);

const LUA_ESCAPES: Partial<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };

function luaTokens(source: string): LuaToken[] {
	const pattern =
		/\s+|--[^\n]*|"((?:[^"\\\n]|\\.)*)"|(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(==|~=|<=|>=|\.\.|[-+*/%#<>=(){}[\],.;])/y;
	const tokens: LuaToken[] = [];
	while (pattern.lastIndex < source.length) {
		const at = pattern.lastIndex;
		const match = pattern.exec(source);
		if (!match || /^--\[=*\[/.test(match[0])) throw new Error(`Unsupported Lua at: ${source.slice(at, at + 24)}`);
		const [, string, number, name, symbol] = match;
		if (string !== undefined) {
			tokens.push({
				kind: "string",
				text: string.replace(/\\(.)/g, (_, escaped: string) => LUA_ESCAPES[escaped] ?? escaped),
			});
		} else if (number !== undefined) tokens.push({ kind: "number", text: number });
		else if (name !== undefined) tokens.push({ kind: "name", text: name });
		else if (symbol !== undefined) tokens.push({ kind: "symbol", text: symbol });
	}
	tokens.push({ kind: "eof", text: "<eof>" });
	return tokens;
}

function luaTruthy(value: LuaValue): boolean {
	return value !== undefined && value !== false;
}

/** An arithmetic operand: a number, or a string that reads as one. */
function luaNumber(value: LuaValue): number {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof number !== "number" || Number.isNaN(number))
		throw new Error(`attempt to perform arithmetic on ${typeof value}`);
	return number;
}

/** A string argument of a library function: a string, or a number as its text. */
function luaString(value: LuaValue): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	throw new Error(`bad argument (string expected, got ${typeof value})`);
}

function luaLess(a: LuaValue, b: LuaValue, orEqual: boolean): boolean {
	if (typeof a === "number" && typeof b === "number") return orEqual ? a <= b : a < b;
	if (typeof a === "string" && typeof b === "string") return orEqual ? a <= b : a < b;
	throw new Error(`attempt to compare ${typeof a} with ${typeof b}`);
}

/** `#value`: a string's byte count, or a table's entries from 1 up to its first nil. */
function luaLength(value: LuaValue): number {
	if (typeof value === "string") return value.length;
	if (!(value instanceof Map)) throw new Error(`attempt to get length of ${typeof value}`);
	let length = 0;
	while (value.get(length + 1) !== undefined) length++;
	return length;
}

function luaConcatenated(value: LuaValue): string {
	if (typeof value === "string" || typeof value === "number") return String(value);
	throw new Error(`attempt to concatenate ${typeof value}`);
}

function luaBinary(operator: string, left: LuaExpr, right: LuaExpr): LuaExpr {
	if (operator === "or" || operator === "and") {
		const or = operator === "or";
		return scope => {
			const value = left(scope);
			return luaTruthy(value) === or ? value : right(scope);
		};
	}
	const combine = ((): ((a: LuaValue, b: LuaValue) => LuaValue) => {
		switch (operator) {
			case "==":
				return (a, b) => a === b;
			case "~=":
				return (a, b) => a !== b;
			case "<":
				return (a, b) => luaLess(a, b, false);
			case "<=":
				return (a, b) => luaLess(a, b, true);
			case ">":
				return (a, b) => luaLess(b, a, false);
			case ">=":
				return (a, b) => luaLess(b, a, true);
			case "..":
				return (a, b) => luaConcatenated(a) + luaConcatenated(b);
			case "+":
				return (a, b) => luaNumber(a) + luaNumber(b);
			case "-":
				return (a, b) => luaNumber(a) - luaNumber(b);
			case "*":
				return (a, b) => luaNumber(a) * luaNumber(b);
			case "/":
				return (a, b) => luaNumber(a) / luaNumber(b);
			case "%":
				return (a, b) => luaNumber(a) - Math.floor(luaNumber(a) / luaNumber(b)) * luaNumber(b);
		}
		throw new Error(`Unsupported Lua operator ${operator}`);
	})();
	return scope => {
		const a = left(scope);
		return combine(a, right(scope));
	};
}

function luaIndex(table: LuaValue, key: LuaValue): LuaValue {
	if (!(table instanceof Map)) throw new Error(`attempt to index ${typeof table}`);
	return table.get(key);
}

function luaSetIndex(table: LuaValue, key: LuaValue, value: LuaValue): void {
	if (!(table instanceof Map)) throw new Error(`attempt to index ${typeof table}`);
	if (key === undefined) throw new Error("table index is nil");
	if (value === undefined) table.delete(key);
	else table.set(key, value);
}

function luaLookup(scope: LuaScope, name: string): LuaValue {
	for (let at: LuaScope | undefined = scope; at; at = at.parent) {
		if (at.vars.has(name)) return at.vars.get(name);
	}
	throw new Error(`Script attempted to access nonexistent global variable '${name}'`);
}

/** Assign a local `name` declared in `scope` or a block around it: a script may not set a global. */
function luaAssign(scope: LuaScope, name: string, value: LuaValue): void {
	for (let at: LuaScope | undefined = scope; at?.parent; at = at.parent) {
		if (at.vars.has(name)) {
			at.vars.set(name, value);
			return;
		}
	}
	throw new Error(`Script attempted to set global variable '${name}'`);
}

/** Run `statements` in `scope` up to the first that leaves the block. */
function luaRun(statements: readonly LuaStatement[], scope: LuaScope): LuaFlow {
	for (const statement of statements) {
		const flow = statement(scope);
		if (flow) return flow;
	}
	return undefined;
}

/**
 * The Lua the storage's scripts use, parsed into closures that run it: `local` (with several names, and `local
 * function`), assignment to a local or a table field, calls, `if`/`elseif`/`else`, `while`, `repeat`/`until`, numeric
 * `for`, `for ... in ipairs(...)`, `break`, `return`, table constructors, indexing, and the operators of
 * {@link LUA_BINARY} with `not`, `-` and `#`. Anything else fails to parse.
 */
class LuaParser {
	readonly #tokens: LuaToken[];
	#at = 0;
	/** Every result of each call expression {@link #suffixed} built, by its first-result expression. */
	readonly #calls = new WeakMap<LuaExpr, LuaExprList>();

	constructor(source: string) {
		this.#tokens = luaTokens(source);
	}

	/** The run of the whole script. */
	chunk(): LuaStatement {
		const block = this.#block();
		if (this.#peek().kind !== "eof") throw new Error(`Unexpected Lua ${this.#peek().text}`);
		return block;
	}

	#peek(offset = 0): LuaToken {
		return this.#tokens[Math.min(this.#at + offset, this.#tokens.length - 1)];
	}

	#is(text: string, offset = 0): boolean {
		const token = this.#peek(offset);
		return (token.kind === "name" || token.kind === "symbol") && token.text === text;
	}

	#accept(text: string): boolean {
		if (!this.#is(text)) return false;
		this.#at++;
		return true;
	}

	#expect(text: string): void {
		if (!this.#accept(text)) throw new Error(`Expected Lua ${text} at ${this.#peek().text}`);
	}

	#name(): string {
		const token = this.#peek();
		if (token.kind !== "name" || LUA_KEYWORDS.has(token.text))
			throw new Error(`Expected a Lua name at ${token.text}`);
		this.#at++;
		return token.text;
	}

	#atBlockEnd(): boolean {
		return (
			this.#peek().kind === "eof" || this.#is("end") || this.#is("else") || this.#is("elseif") || this.#is("until")
		);
	}

	/** A block's statements, up to its end or through its `return`. */
	#statements(): LuaStatement[] {
		const statements: LuaStatement[] = [];
		while (!this.#atBlockEnd()) {
			if (this.#accept("return")) {
				const value: LuaExpr = this.#atBlockEnd() || this.#is(";") ? () => undefined : this.#expr();
				this.#accept(";");
				statements.push(scope => ({ value: value(scope) }));
				break;
			}
			statements.push(this.#statement());
			this.#accept(";");
		}
		return statements;
	}

	/** A block, run in a scope of its own. */
	#block(): LuaStatement {
		const statements = this.#statements();
		return scope => luaRun(statements, { vars: new Map(), parent: scope });
	}

	#statement(): LuaStatement {
		if (this.#accept("local")) {
			if (this.#accept("function")) {
				const name = this.#name();
				const make = this.#functionBody();
				return scope => {
					// Declared before its body runs, so the function can call itself.
					scope.vars.set(name, make(scope));
					return undefined;
				};
			}
			const names = [this.#name()];
			while (this.#accept(",")) names.push(this.#name());
			const values: LuaExprList = this.#accept("=") ? this.#exprList() : () => [];
			return scope => {
				const results = values(scope);
				for (const [index, name] of names.entries()) scope.vars.set(name, results[index]);
				return undefined;
			};
		}
		if (this.#accept("if")) {
			const branches: Array<[LuaExpr, LuaStatement]> = [];
			do {
				const test = this.#expr();
				this.#expect("then");
				branches.push([test, this.#block()]);
			} while (this.#accept("elseif"));
			const otherwise = this.#accept("else") ? this.#block() : undefined;
			this.#expect("end");
			return scope => {
				for (const [test, body] of branches) {
					if (luaTruthy(test(scope))) return body(scope);
				}
				return otherwise?.(scope);
			};
		}
		if (this.#accept("while")) {
			const test = this.#expr();
			this.#expect("do");
			const body = this.#block();
			this.#expect("end");
			return scope => {
				while (luaTruthy(test(scope))) {
					const flow = body(scope);
					if (flow === LUA_BREAK) break;
					if (flow) return flow;
				}
				return undefined;
			};
		}
		if (this.#accept("repeat")) {
			const statements = this.#statements();
			this.#expect("until");
			const test = this.#expr();
			return scope => {
				for (;;) {
					// The test sees the locals of the body it follows.
					const inner: LuaScope = { vars: new Map(), parent: scope };
					const flow = luaRun(statements, inner);
					if (flow === LUA_BREAK) return undefined;
					if (flow) return flow;
					if (luaTruthy(test(inner))) return undefined;
				}
			};
		}
		if (this.#accept("for")) return this.#for();
		if (this.#accept("break")) return () => LUA_BREAK;
		const target = this.#suffixed();
		if (this.#accept("=")) {
			const { assign } = target;
			if (!assign) throw new Error(`Cannot assign to a Lua call at ${this.#peek().text}`);
			const value = this.#expr();
			return scope => {
				assign(scope, value(scope));
				return undefined;
			};
		}
		if (!target.call) throw new Error(`Expected a Lua statement at ${this.#peek().text}`);
		const { get } = target;
		return scope => {
			get(scope);
			return undefined;
		};
	}

	/** A numeric `for`, or a generic one over `ipairs(...)`, after its `for`. */
	#for(): LuaStatement {
		const first = this.#name();
		if (this.#accept("=")) {
			const start = this.#expr();
			this.#expect(",");
			const limit = this.#expr();
			const step: LuaExpr = this.#accept(",") ? this.#expr() : () => 1;
			this.#expect("do");
			const body = this.#block();
			this.#expect("end");
			return scope => {
				const from = luaNumber(start(scope));
				const to = luaNumber(limit(scope));
				const by = luaNumber(step(scope));
				if (by === 0) throw new Error("'for' step is zero");
				for (let index = from; by > 0 ? index <= to : index >= to; index += by) {
					const flow = body({ vars: new Map<string, LuaValue>([[first, index]]), parent: scope });
					if (flow === LUA_BREAK) break;
					if (flow) return flow;
				}
				return undefined;
			};
		}
		this.#expect(",");
		const item = this.#name();
		this.#expect("in");
		const pairs = this.#expr();
		this.#expect("do");
		const body = this.#block();
		this.#expect("end");
		return scope => {
			const iterated = pairs(scope);
			if (!(iterated instanceof LuaPairs)) throw new Error("A Lua for loop here takes ipairs()");
			for (const [index, value] of iterated.entries) {
				const vars = new Map<string, LuaValue>([
					[first, index],
					[item, value],
				]);
				const flow = body({ vars, parent: scope });
				if (flow === LUA_BREAK) break;
				if (flow) return flow;
			}
			return undefined;
		};
	}

	/** A function's parameters and body, through its `end`: what makes the function, closed over a scope. */
	#functionBody(): (scope: LuaScope) => LuaFunction {
		this.#expect("(");
		const params: string[] = [];
		if (!this.#accept(")")) {
			do params.push(this.#name());
			while (this.#accept(","));
			this.#expect(")");
		}
		const body = this.#block();
		this.#expect("end");
		return scope =>
			(...args) => {
				const vars = new Map(params.map((param, index): [string, LuaValue] => [param, args[index]]));
				const flow = body({ vars, parent: scope });
				return flow && flow !== LUA_BREAK ? flow.value : undefined;
			};
	}

	/** Expressions between commas. */
	#exprList(): LuaExprList {
		const items = [this.#expr()];
		while (this.#accept(",")) items.push(this.#expr());
		const leading = items.slice(0, -1);
		const last = items[items.length - 1];
		const lastResults = this.#calls.get(last) ?? ((scope: LuaScope) => [last(scope)]);
		return scope => [...leading.map(item => item(scope)), ...lastResults(scope)];
	}

	#expr(limit = 0): LuaExpr {
		let left = this.#unary();
		for (;;) {
			const token = this.#peek();
			const priority = token.kind === "name" || token.kind === "symbol" ? LUA_BINARY.get(token.text) : undefined;
			if (priority === undefined || priority <= limit) return left;
			this.#at++;
			// `..` groups to the right, every other operator to the left.
			left = luaBinary(token.text, left, this.#expr(token.text === ".." ? priority - 1 : priority));
		}
	}

	#unary(): LuaExpr {
		if (this.#accept("not")) {
			const operand = this.#unary();
			return scope => !luaTruthy(operand(scope));
		}
		if (this.#accept("-")) {
			const operand = this.#unary();
			return scope => -luaNumber(operand(scope));
		}
		if (this.#accept("#")) {
			const operand = this.#unary();
			return scope => luaLength(operand(scope));
		}
		return this.#suffixed().get;
	}

	#suffixed(): LuaTarget {
		let target = this.#primary();
		for (;;) {
			const of = target.get;
			if (this.#accept(".")) {
				const key = this.#name();
				target = {
					get: scope => luaIndex(of(scope), key),
					assign: (scope, value) => luaSetIndex(of(scope), key, value),
				};
			} else if (this.#accept("[")) {
				const key = this.#expr();
				this.#expect("]");
				target = {
					get: scope => luaIndex(of(scope), key(scope)),
					assign: (scope, value) => luaSetIndex(of(scope), key(scope), value),
				};
			} else if (this.#accept("(")) {
				let args: LuaExprList = () => [];
				if (!this.#accept(")")) {
					args = this.#exprList();
					this.#expect(")");
				}
				const results: LuaExprList = scope => {
					const called = of(scope);
					if (typeof called !== "function") throw new Error(`attempt to call ${typeof called}`);
					const result = called(...args(scope));
					return result instanceof LuaResults ? result.values : [result];
				};
				const get: LuaExpr = scope => results(scope)[0];
				this.#calls.set(get, results);
				target = { get, call: true };
			} else return target;
		}
	}

	#primary(): LuaTarget {
		const token = this.#peek();
		this.#at++;
		if (token.kind === "number") {
			const number = Number(token.text);
			return { get: () => number };
		}
		if (token.kind === "string") {
			const text = token.text;
			return { get: () => text };
		}
		if (token.kind === "name") {
			if (token.text === "nil") return { get: () => undefined };
			if (token.text === "true") return { get: () => true };
			if (token.text === "false") return { get: () => false };
			if (!LUA_KEYWORDS.has(token.text)) {
				const name = token.text;
				return { get: scope => luaLookup(scope, name), assign: (scope, value) => luaAssign(scope, name, value) };
			}
		}
		if (token.kind === "symbol" && token.text === "(") {
			const inner = this.#expr();
			this.#expect(")");
			// Parentheses keep one result of a call.
			return { get: scope => inner(scope) };
		}
		if (token.kind === "symbol" && token.text === "{") {
			const items: LuaExpr[] = [];
			while (!this.#accept("}")) {
				items.push(this.#expr());
				if (!this.#accept(",")) {
					this.#expect("}");
					break;
				}
			}
			return { get: scope => new Map(items.map((item, index): [LuaValue, LuaValue] => [index + 1, item(scope)])) };
		}
		throw new Error(`Unexpected Lua ${token.text}`);
	}
}

/** Each script's run, by its source: a script is parsed once. */
const parsedScripts = new Map<string, LuaStatement>();

function parsedScript(source: string): LuaStatement {
	let run = parsedScripts.get(source);
	if (!run) {
		run = new LuaParser(source).chunk();
		parsedScripts.set(source, run);
	}
	return run;
}

function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** Lua's character classes the scripts' patterns use, as RegExp classes (`%s` is C's `isspace`). */
const LUA_PATTERN_CLASSES: Partial<Record<string, string>> = {
	s: "[ \\t\\n\\v\\f\\r]",
	S: "[^ \\t\\n\\v\\f\\r]",
	d: "[0-9]",
	D: "[^0-9]",
};

/** Each Lua pattern `string.match` was given, as a RegExp. */
const luaPatterns = new Map<string, RegExp>();

/**
 * A Lua pattern as a RegExp: its anchors, captures, `.`, the classes of {@link LUA_PATTERN_CLASSES}, `%` escapes of
 * other characters and the quantifiers `*`, `+`, `-` and `?`. A set (`[...]`) or another class fails.
 */
function luaPatternRegExp(pattern: string): RegExp {
	const known = luaPatterns.get(pattern);
	if (known) return known;
	let source = "";
	for (let at = 0; at < pattern.length; at++) {
		const char = pattern[at];
		if ((char === "^" && at === 0) || (char === "$" && at === pattern.length - 1) || char === "(" || char === ")") {
			source += char;
			continue;
		}
		if (char === "[") throw new Error(`Unsupported Lua pattern ${pattern}`);
		let item: string;
		if (char === "%") {
			const escaped = pattern.charAt(++at);
			const named = LUA_PATTERN_CLASSES[escaped];
			if (named === undefined && !/^[^A-Za-z0-9]$/.test(escaped))
				throw new Error(`Unsupported Lua pattern ${pattern}`);
			item = named ?? escapeRegExp(escaped);
		} else item = char === "." ? "[\\s\\S]" : escapeRegExp(char);
		const quantifier = pattern.charAt(at + 1);
		if (quantifier === "*" || quantifier === "+" || quantifier === "?" || quantifier === "-") {
			item += quantifier === "-" ? "*?" : quantifier;
			at++;
		}
		source += item;
	}
	const regExp = new RegExp(source);
	luaPatterns.set(pattern, regExp);
	return regExp;
}

/** A Lua string position `at` of a string of `length` bytes, a negative one counted from the end (0 before the first). */
function luaPosition(at: number, length: number): number {
	const position = at < 0 ? length + at + 1 : at;
	return Math.max(position, 0);
}

/** `text`'s UTF-8 bytes as a Lua string. */
function luaBytes(text: string): string {
	return Buffer.from(text, "utf-8").toString("latin1");
}

/** The text a Lua string's bytes encode. */
function luaText(bytes: string): string {
	return Buffer.from(bytes, "latin1").toString("utf-8");
}

/**
 * The globals a script sees: its `KEYS` and `ARGV`, `redis.call` running each command through `call` (its name and
 * its arguments as the server gets them), `redis.acl_check_cmd` asking `aclCheck` whether the account may run one,
 * `redis.error_reply`, `redis.sha1hex`, and the library functions the scripts use.
 */
function luaGlobals(
	keys: string[],
	argv: string[],
	call: (command: string, args: string[]) => LuaValue,
	aclCheck: (command: string, args: string[]) => boolean,
): LuaScope {
	const commandArg = (arg: LuaValue): string => {
		if (typeof arg === "string") return arg;
		if (typeof arg === "number") return String(arg);
		throw new Error("Lua redis lib command arguments must be strings or integers");
	};
	const library = (functions: Record<string, LuaFunction>): LuaTable =>
		new Map<LuaValue, LuaValue>(Object.entries(functions));
	return {
		parent: undefined,
		vars: new Map<string, LuaValue>([
			["KEYS", new Map(keys.map((key, index): [LuaValue, LuaValue] => [index + 1, key]))],
			["ARGV", new Map(argv.map((arg, index): [LuaValue, LuaValue] => [index + 1, arg]))],
			[
				"redis",
				library({
					call: (command, ...args) => call(commandArg(command), args.map(commandArg)),
					acl_check_cmd: (command, ...args) => aclCheck(commandArg(command), args.map(commandArg)),
					error_reply: message => new Map<LuaValue, LuaValue>([["err", luaString(message)]]),
					sha1hex: value =>
						new Bun.CryptoHasher("sha1").update(Buffer.from(luaString(value), "latin1")).digest("hex"),
				}),
			],
			[
				"tonumber",
				value => {
					if (typeof value === "number") return value;
					if (typeof value !== "string" || value.trim() === "") return undefined;
					const number = Number(value);
					return Number.isNaN(number) ? undefined : number;
				},
			],
			[
				"string",
				library({
					len: value => luaString(value).length,
					sub: (value, from, to) => {
						const text = luaString(value);
						const start = Math.max(luaPosition(from === undefined ? 1 : luaNumber(from), text.length), 1);
						const end = Math.min(luaPosition(to === undefined ? -1 : luaNumber(to), text.length), text.length);
						return start > end ? "" : text.slice(start - 1, end);
					},
					byte: (value, from, to) => {
						const text = luaString(value);
						const start = Math.max(luaPosition(from === undefined ? 1 : luaNumber(from), text.length), 1);
						const end = Math.min(luaPosition(to === undefined ? start : luaNumber(to), text.length), text.length);
						const codes: LuaValue[] = [];
						for (let at = start; at <= end; at++) codes.push(text.charCodeAt(at - 1));
						return new LuaResults(codes);
					},
					match: (value, pattern) => {
						const found = luaPatternRegExp(luaString(pattern)).exec(luaString(value));
						if (!found) return undefined;
						return new LuaResults(found.length > 1 ? found.slice(1) : [found[0]]);
					},
				}),
			],
			[
				"math",
				library({
					max: (...values) => Math.max(...values.map(luaNumber)),
					min: (...values) => Math.min(...values.map(luaNumber)),
				}),
			],
			[
				"ipairs",
				table => {
					const entries: Array<[number, LuaValue]> = [];
					for (let index = 1; luaIndex(table, index) !== undefined; index++)
						entries.push([index, luaIndex(table, index)]);
					return new LuaPairs(entries);
				},
			],
			[
				"unpack",
				table => {
					const values: LuaValue[] = [];
					for (let index = 1; luaIndex(table, index) !== undefined; index++) values.push(luaIndex(table, index));
					return new LuaResults(values);
				},
			],
		]),
	};
}

/**
 * What a client gets for a script's return value: nil and false as null, a string as the text its bytes encode, a
 * table as the array of its entries from 1 (or the error or status it holds).
 */
function luaReply(value: LuaValue): unknown {
	if (value === undefined || value === false) return null;
	if (value === true) return 1;
	if (typeof value === "number") return Math.trunc(value);
	if (typeof value === "string") return luaText(value);
	if (!(value instanceof Map)) throw new Error("Unsupported Lua script reply");
	const error = value.get("err");
	if (typeof error === "string") throw new Error(luaText(error));
	const status = value.get("ok");
	if (typeof status === "string") return luaText(status);
	const items: unknown[] = [];
	for (let index = 1; value.get(index) !== undefined; index++) items.push(luaReply(value.get(index)));
	return items;
}

/** The bytes GETRANGE gives of `bytes` from `start` to `end`, both inclusive, a negative one counted from the end. */
function byteWindow(bytes: Buffer | undefined, start: number, end: number): Buffer {
	if (!bytes || bytes.length === 0) return Buffer.alloc(0);
	const from = Math.max(0, start < 0 ? bytes.length + start : start);
	const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
	return to < from ? Buffer.alloc(0) : bytes.subarray(from, to + 1);
}

/** What GETRANGE returns for `bytes` from `start` to `end`, both inclusive, a negative one counted from the end. */
export function byteRange(bytes: Buffer, start: number, end: number): string {
	return byteWindow(bytes, start, end).toString("utf-8");
}

/** A RegExp of a SCAN `MATCH` glob: its `*`, `?` and `\` escapes (a set, `[...]`, fails). */
function globRegExp(glob: string): RegExp {
	let source = "";
	for (let at = 0; at < glob.length; at++) {
		const char = glob[at];
		if (char === "*") source += "[\\s\\S]*";
		else if (char === "?") source += "[\\s\\S]";
		else if (char === "[") throw new Error(`Unsupported SCAN pattern ${glob}`);
		else source += escapeRegExp(char === "\\" && at + 1 < glob.length ? glob[++at] : char);
	}
	return new RegExp(`^${source}$`);
}

/** Fail a hash command on `key`, as Redis does, when `key` holds a string. */
export function assertHashKey({ strings }: FakeRedisKeyspace, key: string): void {
	if (strings.has(key)) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
}

/**
 * The commands the storage's scripts run, on `keyspace` as a server runs them: each takes and gives Lua strings, and
 * a missing value replies nil (false to Lua). A hash command on a string key fails as on a server. A hash a command
 * empties stays in the keyspace (a server drops it), so a test's handle on a hash stays the keyspace's; no script
 * tells the two apart.
 */
function keyspaceCommands(keyspace: FakeRedisKeyspace): Map<string, (args: string[]) => LuaValue> {
	const { strings, hashes } = keyspace;
	// The UTF-8 bytes of each string key the script read, until it writes the key.
	const encoded = new Map<string, Buffer>();
	const bytesOf = (key: string): Buffer | undefined => {
		let bytes = encoded.get(key);
		if (bytes === undefined) {
			const value = strings.get(key);
			if (value === undefined) return undefined;
			bytes = Buffer.from(value, "utf-8");
			encoded.set(key, bytes);
		}
		return bytes;
	};
	const setString = (key: string, value: string | undefined): void => {
		encoded.delete(key);
		if (value === undefined) strings.delete(key);
		else strings.set(key, value);
	};
	const hash = (key: string): Map<string, string> => {
		assertHashKey(keyspace, key);
		let held = hashes.get(key);
		if (!held) {
			held = new Map();
			hashes.set(key, held);
		}
		return held;
	};
	return new Map<string, (args: string[]) => LuaValue>([
		["EXISTS", keys => keys.map(luaText).filter(key => strings.has(key) || hashes.has(key)).length],
		["GET", ([key]) => bytesOf(luaText(key))?.toString("latin1") ?? false],
		["STRLEN", ([key]) => bytesOf(luaText(key))?.length ?? 0],
		[
			"GETRANGE",
			([key, start, end]) => byteWindow(bytesOf(luaText(key)), Number(start), Number(end)).toString("latin1"),
		],
		[
			"SET",
			([key, value]) => {
				setString(luaText(key), luaText(value));
				return new Map<LuaValue, LuaValue>([["ok", "OK"]]);
			},
		],
		[
			"APPEND",
			([key, value]) => {
				const name = luaText(key);
				const next = (strings.get(name) ?? "") + luaText(value);
				setString(name, next);
				return Buffer.byteLength(next, "utf-8");
			},
		],
		[
			"RENAME",
			([source, target]) => {
				const value = strings.get(luaText(source));
				if (value === undefined) throw new Error("ERR no such key");
				setString(luaText(source), undefined);
				setString(luaText(target), value);
				return new Map<LuaValue, LuaValue>([["ok", "OK"]]);
			},
		],
		[
			"DEL",
			keys => {
				let deleted = 0;
				for (const key of keys.map(luaText)) {
					if (strings.has(key)) setString(key, undefined);
					else if (!hashes.delete(key)) continue;
					deleted++;
				}
				return deleted;
			},
		],
		["PEXPIRE", ([key]) => (strings.has(luaText(key)) || hashes.has(luaText(key)) ? 1 : 0)],
		// No key of the double expires, so none has a time to live to remove.
		["PERSIST", () => 0],
		[
			"HGET",
			([key, field]) => {
				assertHashKey(keyspace, luaText(key));
				const value = hashes.get(luaText(key))?.get(luaText(field));
				return value === undefined ? false : luaBytes(value);
			},
		],
		[
			"HSET",
			([key, ...fieldsAndValues]) => {
				if (fieldsAndValues.length === 0 || fieldsAndValues.length % 2 !== 0)
					throw new Error("ERR wrong number of arguments for 'hset' command");
				const fields = hash(luaText(key));
				let added = 0;
				for (let at = 0; at < fieldsAndValues.length; at += 2) {
					const field = luaText(fieldsAndValues[at]);
					if (!fields.has(field)) added++;
					fields.set(field, luaText(fieldsAndValues[at + 1]));
				}
				return added;
			},
		],
		[
			"HDEL",
			([key, ...fields]) => {
				assertHashKey(keyspace, luaText(key));
				const held = hashes.get(luaText(key));
				return fields.filter(field => held?.delete(luaText(field))).length;
			},
		],
		[
			"SCAN",
			([, ...options]) => {
				// One pass over the whole keyspace: the cursor it returns is the last one.
				const match = options.findIndex(option => option.toUpperCase() === "MATCH");
				const pattern = match === -1 ? undefined : globRegExp(luaText(options[match + 1] ?? "*"));
				const keys = [...strings.keys(), ...hashes.keys()].filter(key => pattern?.test(key) ?? true);
				return new Map<LuaValue, LuaValue>([
					[1, "0"],
					[2, new Map(keys.map((key, index): [LuaValue, LuaValue] => [index + 1, luaBytes(key)]))],
				]);
			},
		],
	]);
}

/**
 * Run the script an `EVAL` sends (`args`: its source, its key count, its keys, then its arguments, as
 * `RedisSessionStorage` sends them) on `keyspace`, as Redis 7 runs it, and return its reply. Each command the script
 * runs first calls `checkFailure` with the command's name in lower case (`hget`, `rename`, `hset`, ...), so a double
 * can make that command fail: the script fails there, and what its commands before it wrote stays, as on a server.
 * `permits` is the account's ACL: given a command's name in lower case and its arguments, whether the account may run
 * it. A command it denies fails with NOPERM, and `redis.acl_check_cmd` answers with it.
 */
export function runSessionScript(
	keyspace: FakeRedisKeyspace,
	args: string[],
	checkFailure: (command: string) => void = () => undefined,
	permits: (command: string, args: string[]) => boolean = () => true,
): unknown {
	const [source = "", keyCount = "0"] = args;
	const values = args.slice(2).map(luaBytes);
	const commands = keyspaceCommands(keyspace);
	const known = (command: string): ((args: string[]) => LuaValue) => {
		const run = commands.get(command.toUpperCase());
		if (!run) throw new Error(`Unsupported Redis command in a script: ${command}`);
		return run;
	};
	const globals = luaGlobals(
		values.slice(0, Number(keyCount)),
		values.slice(Number(keyCount)),
		(command, commandArgs) => {
			const run = known(command);
			checkFailure(command.toLowerCase());
			if (!permits(command.toLowerCase(), commandArgs.map(luaText))) {
				throw new Error(`NOPERM User has no permissions to run the '${command.toLowerCase()}' command`);
			}
			return run(commandArgs);
		},
		(command, commandArgs) => {
			known(command);
			return permits(command.toLowerCase(), commandArgs.map(luaText));
		},
	);
	const flow = parsedScript(source)(globals);
	return luaReply(flow && flow !== LUA_BREAK ? flow.value : undefined);
}
