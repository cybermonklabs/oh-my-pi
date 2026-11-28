/**
 * Functional tests for {@link RedisSessionStorage}. Driven by a hand-rolled
 * fake Redis client so the suite runs without a live server. The fake runs the
 * Lua scripts the storage sends with a small interpreter of the Lua they use,
 * so a test sees what a server does with each script, down to what it leaves
 * when one of the script's commands fails.
 *
 * The harness mirrors only the surface the storage actually uses; it is *not*
 * a general-purpose mock. Each test exercises one contract:
 *
 * - the metadata index keeps `existsSync`/`statSync`/`listFilesSync`
 *   coherent with `writeText`/`writer.append`;
 * - `drain()` waits for fire-and-forget background writes;
 * - `deleteSessionWithArtifacts` removes both the JSONL key and any sidecar
 *   keys under the artifacts prefix;
 * - `refresh()` re-loads the keyspace, so a peer process's writes become
 *   visible after an explicit re-scan;
 * - every read takes a session's title metadata in the script that reads its
 *   bytes, so another store's rename or clear shows at once, and a move or a
 *   rewrite carries no earlier title onto the next body;
 * - every script that writes (a full write, an append, a title update, a move
 *   and a removal) writes nothing when a metadata hash it writes holds a
 *   string or the ACL denies one of its writes, on the fake and, when
 *   `OMP_TEST_REDIS_URL` names a server, on Redis itself (whose ACL rows
 *   need Redis 7 or later and an account that may make users, and fail
 *   naming what is missing otherwise);
 * - a removal the account may not finish leaves none of the keys it finds
 *   without the session's: on a server before Redis 7, which gives a script
 *   no ACL check, a refused HDEL comes after every key is deleted, and an
 *   artifact key the account may not touch fails the script before any
 *   write.
 *
 * Each case and hook has a timeout of its own (30 s: a few writes, reads and
 * scripts, on the fake or on a server), and the fake bounds every loop a
 * script runs, so a fault cannot hold the run.
 */

import { RedisClient } from "bun";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

/** A value of the scripts' Lua: nil is `undefined`, a table a Map. */
type LuaValue = undefined | boolean | number | string | LuaTable | LuaFunction | LuaPairs | LuaValues;
type LuaTable = Map<LuaValue, LuaValue>;
type LuaFunction = (...args: LuaValue[]) => LuaValue;

/** What `ipairs` gives a generic `for`: a table's entries from 1 up to its first nil. */
class LuaPairs {
	constructor(readonly entries: ReadonlyArray<[number, LuaValue]>) {}
}

/** What `unpack` gives: several values, which a call's last argument passes on as arguments of their own. */
class LuaValues {
	constructor(readonly values: readonly LuaValue[]) {}
}

/** `value` where Lua takes one value: the first of several. */
function luaSingle(value: LuaValue): LuaValue {
	return value instanceof LuaValues ? value.values[0] : value;
}

/** A block's variables, then its enclosing block's, up to the globals (the scope without a parent). */
interface LuaScope {
	readonly vars: Map<string, LuaValue>;
	readonly parent: LuaScope | undefined;
}

type LuaExpr = (scope: LuaScope) => LuaValue;
/** A statement's run: the value of the `return` it reached, or `undefined` when it ran to its end. */
type LuaStatement = (scope: LuaScope) => { value: LuaValue } | undefined;

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

/**
 * Most turns one loop of a script may take: a script whose loop never meets its end fails with a loop-bound error
 * instead of holding the test process, which a test's timeout cannot interrupt while the loop runs.
 */
const LUA_LOOP_LIMIT = 10_000;

function luaTokens(source: string): LuaToken[] {
	const pattern =
		/\s+|--[^\n]*|"((?:[^"\\]|\\.)*)"|(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(==|~=|<=|>=|\.\.|[-+*/%#<>=(){}[\],.;])/y;
	const tokens: LuaToken[] = [];
	while (pattern.lastIndex < source.length) {
		const at = pattern.lastIndex;
		const match = pattern.exec(source);
		if (!match) throw new Error(`Unsupported Lua at: ${source.slice(at, at + 24)}`);
		const [, string, number, name, symbol] = match;
		if (string !== undefined) {
			tokens.push({
				kind: "string",
				text: string.replace(/\\(.)/g, (_, escaped: string) => (escaped === "n" ? "\n" : escaped)),
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

function luaLess(a: LuaValue, b: LuaValue, orEqual: boolean): boolean {
	if (typeof a === "number" && typeof b === "number") return orEqual ? a <= b : a < b;
	if (typeof a === "string" && typeof b === "string") return orEqual ? a <= b : a < b;
	throw new Error(`attempt to compare ${typeof a} with ${typeof b}`);
}

/** `#value`: a string's byte count, or a table's entries from 1 up to its first nil. */
function luaLength(value: LuaValue): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf-8");
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

/**
 * The Lua the storage's scripts use, parsed into closures that run it: `local` (a value or a function), assignment
 * to a name or to a table's entry, calls (the last argument passing on every value `unpack` gives),
 * `if`/`elseif`/`else`, `for ... in ipairs(...)`, the numeric `for` (with or without a step), `repeat ... until`
 * (whose test reads no local of its body), `return`, table constructors, indexing, and the operators of
 * {@link LUA_BINARY} with `not`, `-` and `#`. Anything else fails to parse.
 */
class LuaParser {
	readonly #tokens: LuaToken[];
	#at = 0;

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
		return this.#tokens[Math.min(this.#at + offset, this.#tokens.length - 1)]!;
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

	#block(): LuaStatement {
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
		return scope => {
			const inner: LuaScope = { vars: new Map(), parent: scope };
			for (const statement of statements) {
				const returned = statement(inner);
				if (returned) return returned;
			}
			return undefined;
		};
	}

	#statement(): LuaStatement {
		if (this.#accept("local")) {
			if (this.#accept("function")) {
				const name = this.#name();
				this.#expect("(");
				const params: string[] = [];
				if (!this.#accept(")")) {
					do params.push(this.#name());
					while (this.#accept(","));
					this.#expect(")");
				}
				const body = this.#block();
				this.#expect("end");
				return scope => {
					const run: LuaFunction = (...args) =>
						body({ vars: new Map(params.map((param, index) => [param, args[index]])), parent: scope })?.value;
					scope.vars.set(name, run);
					return undefined;
				};
			}
			const name = this.#name();
			const value: LuaExpr = this.#accept("=") ? this.#expr() : () => undefined;
			return scope => {
				scope.vars.set(name, luaSingle(value(scope)));
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
		if (this.#accept("repeat")) {
			const body = this.#block();
			this.#expect("until");
			const test = this.#expr();
			return scope => {
				for (let turns = 1; ; turns++) {
					if (turns > LUA_LOOP_LIMIT) {
						throw new Error(`Lua loop bound: a 'repeat' ran past ${LUA_LOOP_LIMIT} turns`);
					}
					const returned = body(scope);
					if (returned) return returned;
					if (luaTruthy(test(scope))) return undefined;
				}
			};
		}
		if (this.#accept("for")) {
			const key = this.#name();
			if (this.#accept("=")) return this.#numericFor(key);
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
						[key, index],
						[item, value],
					]);
					const returned = body({ vars, parent: scope });
					if (returned) return returned;
				}
				return undefined;
			};
		}
		if (this.#peek().kind === "name" && this.#is("=", 1)) {
			const name = this.#name();
			this.#expect("=");
			const value = this.#expr();
			return scope => {
				luaAssign(scope, name, luaSingle(value(scope)));
				return undefined;
			};
		}
		if (this.#peek().kind === "name" && this.#is("[", 1)) {
			const name = this.#name();
			this.#expect("[");
			const key = this.#expr();
			this.#expect("]");
			this.#expect("=");
			const value = this.#expr();
			return scope => {
				const table = luaLookup(scope, name);
				if (!(table instanceof Map)) throw new Error(`attempt to index ${typeof table}`);
				table.set(luaSingle(key(scope)), luaSingle(value(scope)));
				return undefined;
			};
		}
		const call = this.#suffixed();
		return scope => {
			call(scope);
			return undefined;
		};
	}

	/** The rest of `for <key> = <first>, <limit>[, <step>] do ... end`, after its `=`. */
	#numericFor(key: string): LuaStatement {
		const first = this.#expr();
		this.#expect(",");
		const limit = this.#expr();
		const step: LuaExpr = this.#accept(",") ? this.#expr() : () => 1;
		this.#expect("do");
		const body = this.#block();
		this.#expect("end");
		return scope => {
			const from = luaNumber(luaSingle(first(scope)));
			const to = luaNumber(luaSingle(limit(scope)));
			const by = luaNumber(luaSingle(step(scope)));
			if (by === 0) throw new Error("'for' step is zero");
			let turns = 0;
			for (let index = from; by > 0 ? index <= to : index >= to; index += by) {
				if (++turns > LUA_LOOP_LIMIT) throw new Error(`Lua loop bound: a 'for' ran past ${LUA_LOOP_LIMIT} turns`);
				const returned = body({ vars: new Map<string, LuaValue>([[key, index]]), parent: scope });
				if (returned) return returned;
			}
			return undefined;
		};
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
		return this.#suffixed();
	}

	#suffixed(): LuaExpr {
		let value = this.#primary();
		for (;;) {
			const of = value;
			if (this.#accept(".")) {
				const key = this.#name();
				value = scope => luaIndex(of(scope), key);
			} else if (this.#accept("[")) {
				const key = this.#expr();
				this.#expect("]");
				value = scope => luaIndex(of(scope), key(scope));
			} else if (this.#accept("(")) {
				const args: LuaExpr[] = [];
				if (!this.#accept(")")) {
					do args.push(this.#expr());
					while (this.#accept(","));
					this.#expect(")");
				}
				value = scope => {
					const called = of(scope);
					if (typeof called !== "function") throw new Error(`attempt to call ${typeof called}`);
					const values = args.map(arg => arg(scope));
					const last = values.at(-1);
					if (last instanceof LuaValues) return called(...values.slice(0, -1).map(luaSingle), ...last.values);
					return called(...values.map(luaSingle));
				};
			} else return value;
		}
	}

	#primary(): LuaExpr {
		const token = this.#peek();
		this.#at++;
		if (token.kind === "number") {
			const number = Number(token.text);
			return () => number;
		}
		if (token.kind === "string") {
			const text = token.text;
			return () => text;
		}
		if (token.kind === "name") {
			if (token.text === "nil") return () => undefined;
			if (token.text === "true") return () => true;
			if (token.text === "false") return () => false;
			if (!LUA_KEYWORDS.has(token.text)) {
				const name = token.text;
				return scope => luaLookup(scope, name);
			}
		}
		if (token.kind === "symbol" && token.text === "(") {
			const inner = this.#expr();
			this.#expect(")");
			return inner;
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
			return scope => new Map(items.map((item, index): [LuaValue, LuaValue] => [index + 1, item(scope)]));
		}
		throw new Error(`Unexpected Lua ${token.text}`);
	}
}

/**
 * The globals a script sees: its `KEYS` and `ARGV`, `redis.call` running each command through `call` (its name and
 * its arguments as the server gets them), `redis.acl_check_cmd` asking `permits` whether the account may run one
 * without running it (none without `permits`, as on a server before Redis 7), `redis.error_reply`, and the library
 * functions the scripts use, `unpack` among them.
 */
function luaGlobals(
	keys: string[],
	argv: string[],
	call: (command: string, args: string[]) => LuaValue,
	permits: ((command: string, args: string[]) => boolean) | undefined,
): LuaScope {
	const list = (items: string[]): LuaTable =>
		new Map(items.map((item, index): [LuaValue, LuaValue] => [index + 1, item]));
	const commandArg = (arg: LuaValue): string => {
		if (typeof arg === "string") return arg;
		if (typeof arg === "number") return String(arg);
		throw new Error("Lua redis lib command arguments must be strings or integers");
	};
	const redis = new Map<LuaValue, LuaValue>([
		["call", (command, ...args) => call(commandArg(command), args.map(commandArg))],
		["error_reply", message => new Map<LuaValue, LuaValue>([["err", commandArg(message)]])],
	]);
	if (permits) {
		redis.set("acl_check_cmd", (command, ...args) => permits(commandArg(command), args.map(commandArg)));
	}
	return {
		parent: undefined,
		vars: new Map<string, LuaValue>([
			["KEYS", list(keys)],
			["ARGV", list(argv)],
			["redis", redis],
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
				new Map<LuaValue, LuaValue>([
					["len", value => luaLength(commandArg(value))],
					[
						"sub",
						(value, from, to) => {
							// Byte positions from 1, a negative one counted from the end, clamped to the string.
							const bytes = Buffer.from(commandArg(value), "utf-8");
							const position = (at: number): number => (at < 0 ? bytes.length + at + 1 : at);
							const start = Math.max(position(luaNumber(from)), 1);
							const end = Math.min(position(to === undefined ? -1 : luaNumber(to)), bytes.length);
							return start > end ? "" : bytes.subarray(start - 1, end).toString("utf-8");
						},
					],
				]),
			],
			[
				"unpack",
				table => {
					const values: LuaValue[] = [];
					for (let index = 1; luaIndex(table, index) !== undefined; index++) values.push(luaIndex(table, index));
					return new LuaValues(values);
				},
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
		]),
	};
}

/** What a client gets for a script's return value: nil and false as null, a table as the array of its entries from 1. */
function luaReply(value: LuaValue): unknown {
	if (value === undefined || value === false) return null;
	if (value === true) return 1;
	if (typeof value === "number") return Math.trunc(value);
	if (typeof value === "string") return value;
	if (!(value instanceof Map)) throw new Error("Unsupported Lua script reply");
	const error = value.get("err");
	if (typeof error === "string") throw new Error(error);
	const status = value.get("ok");
	if (typeof status === "string") return status;
	const items: unknown[] = [];
	for (let index = 1; value.get(index) !== undefined; index++) items.push(luaReply(value.get(index)));
	return items;
}

/**
 * What a `SCAN MATCH` glob matches: `*` any run, `?` one character, `\` the next character as itself, any other
 * character itself. No `[...]` set: the store escapes those.
 */
function globRegExp(pattern: string): RegExp {
	let source = "";
	for (let at = 0; at < pattern.length; at++) {
		let char = pattern[at];
		if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else {
			if (char === "\\" && at + 1 < pattern.length) char = pattern[++at];
			source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`, "s");
}

interface FakeRedisCall {
	method: string;
	args: unknown[];
}

interface FakeRedis extends RedisSessionStorageClient {
	calls: FakeRedisCall[];
	strings: Map<string, string>;
	hashes: Map<string, Map<string, string>>;
	/** Fail the next call to `method` (a client method, or a command a script runs, in lower case) with `error`. */
	failNext(method: string, error: Error): void;
	/**
	 * Deny `command` (in lower case) from now on, as an ACL does: each call of it, by the client or a script, fails
	 * with NOPERM, and a script's `redis.acl_check_cmd` for it returns false.
	 */
	denyCommand(command: string): void;
	/**
	 * Deny every write of `key` by a script from now on, as a Redis 7 ACL's write key pattern (`%W~`) does beside a
	 * selector that lets `EVAL` start: such a command fails with NOPERM, and a script's `redis.acl_check_cmd` for it
	 * returns false.
	 */
	denyWrites(key: string): void;
	/**
	 * Deny every command naming `key` from now on, as an ACL whose key patterns (`~`) match no such key does, on
	 * Redis 6 as on 7: an `EVAL` that declares it among its keys fails with NOPERM before its script runs, and a
	 * command naming it, by the client or a script, fails with NOPERM.
	 */
	denyKey(key: string): void;
}

/** The commands a script runs that write, each with the keys of its arguments it writes. */
const WRITTEN_KEYS: Record<string, (args: string[]) => string[]> = {
	SET: ([key]) => [key],
	APPEND: ([key]) => [key],
	RENAME: ([source, target]) => [source, target],
	DEL: keys => keys,
	HSET: ([key]) => [key],
	HDEL: ([key]) => [key],
};

/** The keys `command` names among `args`, for the commands the fake runs. */
function keysNamed(command: string, args: string[]): string[] {
	switch (command.toUpperCase()) {
		case "EXISTS":
		case "DEL":
			return args;
		case "RENAME":
			return args.slice(0, 2);
		case "SCAN":
			return [];
		default:
			return args.slice(0, 1);
	}
}

/**
 * A fake of a server of Redis 7 or later, or with `aclCheckCmd: false` of an older one, which gives a script no
 * `redis.acl_check_cmd`: a script there runs its writes unchecked, and a denied one fails it after the writes before.
 */
function createFakeRedis(options: { aclCheckCmd?: boolean } = {}): FakeRedis {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();
	const calls: FakeRedisCall[] = [];
	const failures = new Map<string, Error[]>();
	const denied = new Set<string>();
	const deniedWrites = new Set<string>();
	const deniedKeys = new Set<string>();
	/** Whether a script's `command` with `args` writes a key the account may not write. */
	const writesDenied = (command: string, args: string[]): boolean =>
		WRITTEN_KEYS[command.toUpperCase()]?.(args).some(key => deniedWrites.has(key)) ?? false;
	/** Fail, as the ACL does, a command naming one of `keys` when the account may not touch it. */
	const checkKeys = (keys: string[]): void => {
		if (keys.some(key => deniedKeys.has(key))) throw new Error("NOPERM No permissions to access a key");
	};

	const checkFailure = (method: string): void => {
		if (denied.has(method)) throw new Error(`NOPERM User has no permissions to run the '${method}' command`);
		const queue = failures.get(method);
		if (!queue || queue.length === 0) return;
		throw queue.shift() as Error;
	};

	const record = (method: string, args: unknown[]): void => {
		calls.push({ method, args });
	};

	/** Fail a hash command on `key`, as Redis does, when `key` holds a string. */
	const assertHash = (key: string): void => {
		if (strings.has(key)) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
	};

	/** Fail a string command on `key`, as Redis does, when `key` holds a hash. */
	const assertString = (key: string): void => {
		if (hashes.has(key)) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
	};

	const getHash = (key: string): Map<string, string> => {
		assertHash(key);
		let h = hashes.get(key);
		if (!h) {
			h = new Map();
			hashes.set(key, h);
		}
		return h;
	};

	/** GETRANGE's bytes of `key`, with its negative offsets counted from the end. */
	const byteRange = (key: string, start: number, end: number): string => {
		const bytes = Buffer.from(strings.get(key) ?? "", "utf-8");
		if (bytes.length === 0) return "";
		const from = Math.max(0, start < 0 ? bytes.length + start : start);
		const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
		if (to < from) return "";
		return bytes.subarray(from, to + 1).toString("utf-8");
	};

	/** The commands the storage's scripts run, as the server runs them; a missing value replies nil (false to Lua). */
	const commands = new Map<string, (args: string[]) => LuaValue>([
		["EXISTS", keys => keys.filter(key => strings.has(key) || hashes.has(key)).length],
		[
			"GET",
			([key]) => {
				assertString(key);
				return strings.get(key) ?? false;
			},
		],
		[
			"STRLEN",
			([key]) => {
				assertString(key);
				return Buffer.byteLength(strings.get(key) ?? "", "utf-8");
			},
		],
		[
			"GETRANGE",
			([key, start, end]) => {
				assertString(key);
				return byteRange(key, Number(start), Number(end));
			},
		],
		[
			"SET",
			([key, value]) => {
				hashes.delete(key);
				strings.set(key, value);
				return new Map<LuaValue, LuaValue>([["ok", "OK"]]);
			},
		],
		[
			"APPEND",
			([key, value]) => {
				assertString(key);
				const next = (strings.get(key) ?? "") + value;
				strings.set(key, next);
				return Buffer.byteLength(next, "utf-8");
			},
		],
		[
			"RENAME",
			([source, target]) => {
				const value = strings.get(source);
				if (value === undefined) throw new Error("ERR no such key");
				strings.delete(source);
				strings.set(target, value);
				return new Map<LuaValue, LuaValue>([["ok", "OK"]]);
			},
		],
		[
			"DEL",
			keys => {
				let deleted = 0;
				for (const key of keys) {
					if (strings.delete(key) || hashes.delete(key)) deleted += 1;
				}
				return deleted;
			},
		],
		[
			"HGET",
			([key, field]) => {
				assertHash(key);
				return hashes.get(key)?.get(field) ?? false;
			},
		],
		[
			"HSET",
			([key, ...fieldsAndValues]) => {
				const hash = getHash(key);
				let added = 0;
				for (let at = 0; at + 1 < fieldsAndValues.length; at += 2) {
					if (!hash.has(fieldsAndValues[at])) added += 1;
					hash.set(fieldsAndValues[at], fieldsAndValues[at + 1]);
				}
				return added;
			},
		],
		[
			"HDEL",
			([key, ...fields]) => {
				assertHash(key);
				const hash = hashes.get(key);
				let deleted = 0;
				for (const field of fields) {
					if (hash?.delete(field)) deleted += 1;
				}
				// Redis deletes a hash with its last field.
				if (hash?.size === 0) hashes.delete(key);
				return deleted;
			},
		],
		[
			"SCAN",
			([, ...options]) => {
				// One pass over every key: the cursor it replies is always "0".
				const at = options.findIndex(option => option.toUpperCase() === "MATCH");
				const match = globRegExp(at < 0 ? "*" : (options[at + 1] ?? "*"));
				const keys = [...strings.keys(), ...hashes.keys()].filter(key => match.test(key));
				return new Map<LuaValue, LuaValue>([
					[1, "0"],
					[2, new Map(keys.map((key, index): [LuaValue, LuaValue] => [index + 1, key]))],
				]);
			},
		],
	]);

	/**
	 * Run the script an `EVAL` sends (its source, its key count, its keys, then its arguments) as a server runs it,
	 * and return its reply. An `EVAL` that declares a key the account may not touch fails before its script runs, as
	 * the ACL checks the keys a command names before it dispatches it. Each command the script runs first meets the
	 * denial or the failure a test set for it, which fails the script there; what the commands before it wrote stays,
	 * as on a server.
	 */
	const evaluate = (args: string[]): unknown => {
		const [source = "", keyCount = "0"] = args;
		const keys = args.slice(2, 2 + Number(keyCount));
		const argv = args.slice(2 + Number(keyCount));
		if (keys.some(key => deniedKeys.has(key)))
			throw new Error("NOPERM this user has no permissions to access one of the keys used as arguments");
		const run = new LuaParser(source).chunk();
		const globals = luaGlobals(
			keys,
			argv,
			(command, commandArgs) => {
				const runCommand = commands.get(command.toUpperCase());
				if (!runCommand) throw new Error(`Unsupported Redis command in a script: ${command}`);
				checkFailure(command.toLowerCase());
				checkKeys(keysNamed(command, commandArgs));
				if (writesDenied(command, commandArgs)) throw new Error("NOPERM No permissions to access a key");
				return runCommand(commandArgs);
			},
			options.aclCheckCmd === false
				? undefined
				: (command, commandArgs) => {
						if (!commands.has(command.toUpperCase()))
							throw new Error("ERR Invalid command passed to redis.acl_check_cmd()");
						return (
							!denied.has(command.toLowerCase()) &&
							!writesDenied(command, commandArgs) &&
							!keysNamed(command, commandArgs).some(key => deniedKeys.has(key))
						);
					},
		);
		return luaReply(run(globals)?.value);
	};

	const client: FakeRedis = {
		calls,
		strings,
		hashes,
		failNext(method: string, error: Error): void {
			const queue = failures.get(method) ?? [];
			queue.push(error);
			failures.set(method, queue);
		},
		denyCommand(command: string): void {
			denied.add(command);
		},
		denyWrites(key: string): void {
			deniedWrites.add(key);
		},
		denyKey(key: string): void {
			deniedKeys.add(key);
		},
		async send(command, args) {
			record("send", [command, args]);
			checkFailure("send");
			if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
			return evaluate(args);
		},
		async get(key) {
			record("get", [key]);
			checkFailure("get");
			checkKeys([key]);
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async getrange(key, start, end) {
			record("getrange", [key, start, end]);
			checkFailure("getrange");
			checkKeys([key]);
			return byteRange(key, start, end);
		},
		async strlen(key) {
			record("strlen", [key]);
			checkFailure("strlen");
			checkKeys([key]);
			return Buffer.byteLength(strings.get(key) ?? "", "utf-8");
		},
		async set(key, value) {
			record("set", [key, value]);
			checkFailure("set");
			checkKeys([key]);
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			record("append", [key, value]);
			checkFailure("append");
			checkKeys([key]);
			const current = strings.get(key) ?? "";
			const next = current + value;
			strings.set(key, next);
			return Buffer.byteLength(next, "utf-8");
		},
		async scan(cursor, ...rest) {
			record("scan", [cursor, ...rest]);
			checkFailure("scan");
			const at = rest.findIndex(option => option.toUpperCase() === "MATCH");
			const match = globRegExp(at < 0 ? "*" : (rest[at + 1] ?? "*"));
			return ["0", Array.from(strings.keys()).filter(key => match.test(key))];
		},
		async hgetall(key) {
			record("hgetall", [key]);
			checkFailure("hgetall");
			checkKeys([key]);
			assertHash(key);
			const h = hashes.get(key);
			if (!h) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of h) out[k] = v;
			return out;
		},
	};

	return client;
}

const SESSION_HEADER = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;

/** The first line every reader of `storage` gives `path`: its text, its head slice, its head window and its line scan. */
async function headsOf(storage: RedisSessionStorage, path: string): Promise<Record<string, string>> {
	const firstLine = (text: string): string => text.split("\n")[0] ?? "";
	let scanned = "";
	await storage.scanLines(path, line => {
		scanned = line;
		return true;
	});
	return {
		readText: firstLine(await storage.readText(path)),
		readTextSlices: firstLine((await storage.readTextSlices(path, 4096, 0))[0]),
		readTextFrom: firstLine((await storage.readTextFrom(path, 0, 4096)).text),
		scanLines: scanned,
	};
}

/** `line` as the first line of every reader {@link headsOf} asks. */
function everywhere(line: string): Record<string, string> {
	return { readText: line, readTextSlices: line, readTextFrom: line, scanLines: line };
}

/** The title slot `update` makes, as a line. */
function slotLine(update: SessionTitleUpdate): string {
	return serializeTitleSlot(update).slice(0, -1);
}

describe("RedisSessionStorage", () => {
	let redis: FakeRedis;

	beforeEach(() => {
		redis = createFakeRedis();
	}, 30_000);

	it("indexes writeText metadata and reads content asynchronously", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
	}, 30_000);

	it("commits file content and metadata through one atomic Redis script", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/atomic.jsonl";
		await storage.writeText(sessionPath, "old\n");
		const oldMtime = redis.hashes.get("omp:sessions:meta")?.get(sessionPath);
		redis.failNext("send", new Error("EVAL transport failed"));

		await expect(storage.writeTextAtomic(sessionPath, "new\n")).rejects.toThrow("EVAL transport failed");

		expect(redis.strings.get(`omp:sessions:file:${sessionPath}`)).toBe("old\n");
		expect(redis.hashes.get("omp:sessions:meta")?.get(sessionPath)).toBe(oldMtime);
		expect(storage.statSync(sessionPath).size).toBe(4);
		expect(redis.calls.some(call => call.method === "send" && call.args[0] === "EVAL")).toBe(true);
	}, 30_000);

	it("create() warms the metadata index with STRLEN and never reads full content", async () => {
		redis.strings.set("omp:sessions:file:/sessions/p/huge.jsonl", "0123456789");
		redis.hashes.set("omp:sessions:meta", new Map([["/sessions/p/huge.jsonl", String(Date.now())]]));

		const storage = await RedisSessionStorage.create({ client: redis });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);
		// Every content read is a script (`send`), as `get` was before.
		expect(redis.calls.some(call => call.method === "get" || call.method === "send")).toBe(false);
		expect(redis.calls.some(call => call.method === "strlen")).toBe(true);
	}, 30_000);

	it("persists title updates as indexed fields across storage reloads", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await RedisSessionStorage.create({ client: redis });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
	}, 30_000);

	it("listFilesSync returns only direct children matching the glob", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		const jsonl = storage.listFilesSync("/dir", "*.jsonl").sort();
		expect(jsonl).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);

		const bak = storage.listFilesSync("/dir", "*.bak");
		expect(bak).toEqual(["/dir/note.bak"]);
	}, 30_000);

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");

		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	}, 30_000);

	it("writer.append appends to Redis after drain", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from Redis.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		// Redis has not necessarily caught up yet — drain to force.
		await storage.drain();
		expect(redis.strings.get("omp:sessions:file:/sessions/p/session.jsonl")).toBe(
			'{"type":"session"}\n{"type":"message"}\n',
		);

		await writer.close();
	}, 30_000);

	it("flags='w' truncates both index metadata and Redis", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/keep.jsonl")).toBe("fresh\n");
	}, 30_000);

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");
		redis.failNext("append", new Error("redis exploded"));
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow("redis exploded");
		expect(writer.getError()?.message).toBe("redis exploded");
	}, 30_000);

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1.jsonl")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1/draft.txt")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/other.jsonl")).toBe(true);
	}, 30_000);

	it("rename moves content and meta atomically inside the index", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);
		expect(redis.strings.get("omp:sessions:file:/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(redis.strings.has("omp:sessions:file:/sessions/p/orig.jsonl")).toBe(false);
	}, 30_000);

	it("rename rolls back the index when Redis RENAME fails", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "keep\n");
		redis.failNext("rename", new Error("ERR redis rejected rename"));

		await expect(storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl")).rejects.toThrow(
			"ERR redis rejected rename",
		);

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(storage.existsSync("/sessions/p/b.jsonl")).toBe(false);
	}, 30_000);

	it("renameNoReplace refuses a destination key another client set, leaving both keys", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		// Another process sets the destination after this store loaded its index.
		redis.strings.set("omp:sessions:file:/sessions/p/b.jsonl", "theirs\n");

		const error = await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl").then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toMatchObject({ code: "EEXIST", path: "/sessions/p/b.jsonl" });
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("ours\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/b.jsonl")).toBe("theirs\n");
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("ours\n");
	}, 30_000);

	it("renameNoReplace moves to a free key", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/c.jsonl");

		expect(redis.strings.has("omp:sessions:file:/sessions/p/a.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/c.jsonl")).toBe("ours\n");
	}, 30_000);

	it("moves a key with its mtime and title in one script, dropping a stale title at the destination", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		const titles = redis.hashes.get("omp:sessions:title") ?? new Map<string, string>();
		redis.hashes.set("omp:sessions:title", titles);
		titles.set("/sessions/p/a.jsonl", JSON.stringify({ title: "Ours", updatedAt: "t1" }));
		titles.set("/sessions/p/b.jsonl", JSON.stringify({ title: "Stale", updatedAt: "t0" }));
		redis.calls.length = 0;

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");

		// Nothing runs after the script, so no other client's write can land between the parts.
		expect(redis.calls.map(call => call.method)).toEqual(["send"]);
		expect(titles.get("/sessions/p/b.jsonl")).toBe(JSON.stringify({ title: "Ours", updatedAt: "t1" }));
		expect(titles.has("/sessions/p/a.jsonl")).toBe(false);
		expect(redis.hashes.get("omp:sessions:meta")?.has("/sessions/p/a.jsonl")).toBe(false);
		expect(redis.hashes.get("omp:sessions:meta")?.has("/sessions/p/b.jsonl")).toBe(true);
	}, 30_000);

	it("deleteSessionWithArtifacts removes a child key another client set after the refresh", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		const refresh = storage.refresh.bind(storage);
		let injected = false;
		storage.refresh = async () => {
			await refresh();
			// Another process commits a subagent transcript once this view is loaded.
			redis.strings.set("omp:sessions:file:/sessions/p/s1/Late.jsonl", "late\n");
			injected = true;
		};

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(injected).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1.jsonl")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1/Late.jsonl")).toBe(false);
	}, 30_000);

	it("refresh() reloads the metadata index from Redis after out-of-band writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		// Simulate a peer process writing directly to Redis.
		redis.strings.set("omp:sessions:file:/peer/x.jsonl", "from peer\n");
		const peerHash = redis.hashes.get("omp:sessions:meta") ?? new Map<string, string>();
		peerHash.set("/peer/x.jsonl", String(Date.now() + 5_000));
		redis.hashes.set("omp:sessions:meta", peerHash);

		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);
		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
	}, 30_000);

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
	}, 30_000);

	// If this regresses, a head read of a long Redis session fetches its whole value, or reads its windows without
	// the title metadata the store holds, showing the title its stored head carries. The red control for a title
	// read from another version than the bytes is the gated rewrite case in indexed-session-index-entry.test.ts.
	it("readTextSlices reads both windows and the title metadata in one script, never the whole value", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const path = "/sessions/p/big.jsonl";
		const stored = `${serializeTitleSlot({ title: "Stored title", source: "auto", updatedAt: "t1" })}${bodyOf("big")}`;
		await storage.writeText(path, stored);
		const renamed: SessionTitleUpdate = { title: "Renamed title", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const slot = Buffer.from(serializeTitleSlot(renamed), "utf-8");
		const text = Buffer.concat([slot, Buffer.from(stored, "utf-8").subarray(slot.length)]);

		redis.calls.length = 0;
		redis.denyCommand("get");
		expect({
			slices: await storage.readTextSlices(path, 300, 20),
			commands: redis.calls.map(call => (call.method === "send" ? call.args[0] : call.method)),
		}).toEqual({
			slices: [
				text.subarray(0, 300).toString("utf-8"),
				Buffer.from(stored, "utf-8").subarray(-20).toString("utf-8"),
			],
			commands: ["EVAL"],
		});
	}, 30_000);

	// If this regresses, a store that opened a session before another store renamed or cleared its title shows the
	// old title until it refreshes, a key an older build wrote shows a title it never had, a cleared title shows
	// the one the stored head carries, or a title hash value the decoder refuses is laid over the head anyway.
	it("reads another store's rename and clear without a refresh, a key without title metadata as stored, and malformed metadata as none", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const peer = await RedisSessionStorage.create({ client: redis });
		const path = "/s/peer.jsonl";
		const old: SessionTitleUpdate = { title: "Old", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(old)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = await headsOf(peer, path);
		const renamed: SessionTitleUpdate = { title: "New", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const afterRename = await headsOf(peer, path);
		const cleared: SessionTitleUpdate = { title: "", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, cleared);
		const afterClear = await headsOf(peer, path);

		// Keys as a build before title metadata wrote them: a value and an mtime, no title hash entry.
		const put = (key: string, body: string): void => {
			redis.strings.set(`omp:sessions:file:${key}`, body);
			const meta = redis.hashes.get("omp:sessions:meta") ?? new Map<string, string>();
			meta.set(key, "1");
			redis.hashes.set("omp:sessions:meta", meta);
		};
		const storedSlot = serializeTitleSlot({ title: "Stored", source: "auto", updatedAt: "t0" });
		put("/s/stored-slot.jsonl", `${storedSlot}${SESSION_HEADER}`);
		put("/s/legacy.jsonl", SESSION_HEADER);
		put("/s/malformed.jsonl", `${storedSlot}${SESSION_HEADER}`);
		redis.hashes.get("omp:sessions:title")?.set("/s/malformed.jsonl", '{"title":"Not decoded"');
		await peer.refresh();
		expect({
			before,
			afterRename,
			afterClear,
			storedSlot: await headsOf(peer, "/s/stored-slot.jsonl"),
			legacy: await peer.readText("/s/legacy.jsonl"),
			legacyHeads: await headsOf(peer, "/s/legacy.jsonl"),
			malformed: await headsOf(peer, "/s/malformed.jsonl"),
		}).toEqual({
			before: everywhere(slotLine(old)),
			afterRename: everywhere(slotLine(renamed)),
			afterClear: everywhere(slotLine(cleared)),
			storedSlot: everywhere(storedSlot.slice(0, -1)),
			legacy: SESSION_HEADER,
			legacyHeads: everywhere(SESSION_HEADER.slice(0, -1)),
			malformed: everywhere(storedSlot.slice(0, -1)),
		});
	}, 30_000);

	// If this regresses, the title of what a path held before shows over what it holds next: after a rewrite with
	// no title slot, after its writer empties it, or on the path a session was moved onto.
	it("carries no earlier title over a rewrite without one, a truncation, or a move onto a titled path", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const peer = await RedisSessionStorage.create({ client: redis });
		const titled = `${serializeTitleSlot({ title: "Before", source: "user", updatedAt: "t1" })}${SESSION_HEADER}`;
		for (const path of ["/s/rewritten.jsonl", "/s/truncated.jsonl", "/s/target.jsonl"]) {
			await storage.writeText(path, titled);
			await storage.updateSessionTitle(path, { title: "Renamed before", source: "user", updatedAt: "t2" });
		}
		await storage.writeText("/s/moved.jsonl", SESSION_HEADER);

		await storage.writeText("/s/rewritten.jsonl", SESSION_HEADER);
		await using cleanup = new AsyncDisposableStack();
		const writer = storage.openWriter("/s/truncated.jsonl", { flags: "w" });
		// Closed whatever the append does; a second close does nothing.
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();
		await storage.rename("/s/moved.jsonl", "/s/target.jsonl");
		await storage.drain();

		await peer.refresh();
		const header = everywhere(SESSION_HEADER.slice(0, -1));
		for (const view of [storage, peer]) {
			expect({
				rewritten: await headsOf(view, "/s/rewritten.jsonl"),
				truncated: await headsOf(view, "/s/truncated.jsonl"),
				target: await headsOf(view, "/s/target.jsonl"),
			}).toEqual({ rewritten: header, truncated: header, target: header });
		}
	}, 30_000);

	// If this regresses, a title update the server never stored shows on this store (or its time does) until a
	// refresh, or a later update after a failed one is lost on another store.
	it("keeps the durable title and time on this store and another when a title write fails before it runs, and a later one wins", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const peer = await RedisSessionStorage.create({ client: redis });
		const path = "/s/failed-title.jsonl";
		const durable: SessionTitleUpdate = { title: "Durable", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(durable)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = storage.statSync(path).mtimeMs;

		// The title script's first write; the fake fails it before the script changes anything.
		redis.failNext("hset", new Error("title write refused before it ran"));
		await expect(
			storage.updateSessionTitle(path, { title: "Lost", source: "user", updatedAt: "t2" }),
		).rejects.toThrow("title write refused before it ran");
		const afterFailure = {
			local: await headsOf(storage, path),
			peer: await headsOf(peer, path),
			time: storage.statSync(path).mtimeMs,
		};
		const later: SessionTitleUpdate = { title: "Later", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, later);
		expect({
			afterFailure,
			afterLater: { local: await headsOf(storage, path), peer: await headsOf(peer, path) },
		}).toEqual({
			afterFailure: { local: everywhere(slotLine(durable)), peer: everywhere(slotLine(durable)), time: before },
			afterLater: { local: everywhere(slotLine(later)), peer: everywhere(slotLine(later)) },
		});
	}, 30_000);

	// If this regresses, a stale store reading slices of a deleted session whose path still has a title hash entry
	// synthesizes that title into the head slice instead of returning empty slices.
	it("readTextSlices returns empty slices with no synthesized title when the body key is missing and a title hash entry survives", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const path = "/s/deleted-with-title.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		// Another store removed the body key while a stale update left a title hash entry behind.
		redis.strings.delete(`omp:sessions:file:${path}`);
		const titles = redis.hashes.get("omp:sessions:title") ?? new Map<string, string>();
		titles.set(path, JSON.stringify({ title: "Stale title", source: "user", updatedAt: "t2" }));
		redis.hashes.set("omp:sessions:title", titles);

		expect(await storage.readTextSlices(path, 256, 64)).toEqual(["", ""]);
	}, 30_000);

	// If this regresses, a store whose index still lists a session another store removed writes a title for a body
	// that is gone, and the session a third store starts at that path shows that title over its own header.
	it("refuses a title update for a session another store removed, and a session started at its path later shows no title", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const stale = await RedisSessionStorage.create({ client: redis });
		const path = "/s/removed.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		await stale.refresh();
		await storage.unlink(path);

		await expect(
			stale.updateSessionTitle(path, { title: "Too late", source: "user", updatedAt: "t2" }),
		).rejects.toMatchObject({ code: "ENOENT" });

		const starter = await RedisSessionStorage.create({ client: redis });
		const writer = starter.openWriter(path);
		await writer.append(SESSION_HEADER);
		await writer.close();
		expect(await headsOf(starter, path)).toEqual(everywhere(SESSION_HEADER.slice(0, -1)));
	}, 30_000);

	// If this regresses, a title left at a path with no body (by a build that did not refuse such an update) shows
	// over the header of the session an append then starts there.
	it("starts a session by append with its own header over a title left at a path with no body", async () => {
		const path = "/s/orphaned.jsonl";
		redis.hashes.set(
			"omp:sessions:title",
			new Map([[path, JSON.stringify({ title: "Orphan", source: "user", updatedAt: "t2" })]]),
		);
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter(path);
		await writer.append(SESSION_HEADER);
		await writer.close();

		expect(await headsOf(storage, path)).toEqual(everywhere(SESSION_HEADER.slice(0, -1)));
		// Redis deletes a hash with its last field, so the title hash may be gone with the orphan's entry.
		expect(redis.hashes.get("omp:sessions:title")?.has(path) ?? false).toBe(false);
	}, 30_000);

	// If this regresses, a title hash value with an empty time overlays a title on a transcript that never had
	// one (replacing a short header whole), or an empty title with a time stops clearing the stored one.
	it("ignores title metadata with an empty time and reads an empty title with a time as a clear", async () => {
		const cleared: SessionTitleUpdate = { title: "", updatedAt: "2026-01-01T00:00:00.000Z" };
		const entries: Array<[string, string]> = [
			["/s/untimed.jsonl", JSON.stringify({ title: "Ignored", updatedAt: "" })],
			["/s/cleared.jsonl", JSON.stringify(cleared)],
		];
		const meta = new Map<string, string>();
		for (const [path] of entries) {
			redis.strings.set(`omp:sessions:file:${path}`, SESSION_HEADER);
			meta.set(path, "1");
		}
		redis.hashes.set("omp:sessions:meta", meta);
		redis.hashes.set("omp:sessions:title", new Map(entries));
		const storage = await RedisSessionStorage.create({ client: redis });

		expect({
			untimed: await headsOf(storage, "/s/untimed.jsonl"),
			cleared: await headsOf(storage, "/s/cleared.jsonl"),
		}).toEqual({
			untimed: everywhere(SESSION_HEADER.slice(0, -1)),
			cleared: everywhere(slotLine(cleared)),
		});
	}, 30_000);

	it("custom prefix isolates keyspaces", async () => {
		const storage = await RedisSessionStorage.create({ client: redis, prefix: "proj-a:" });
		await storage.writeText("/sessions/x.jsonl", "hello\n");
		expect(redis.strings.has("proj-a:file:/sessions/x.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/x.jsonl")).toBe(false);
	}, 30_000);

	it("unlink on a missing key throws ENOENT", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);
});

// These run the move and remove scripts on a real server when `OMP_TEST_REDIS_URL` names a throwaway Redis 7 or
// later, beside the fake's runs of the same scripts above.
describe.skipIf(!process.env.OMP_TEST_REDIS_URL)("RedisSessionStorage on a Redis server", () => {
	const url = process.env.OMP_TEST_REDIS_URL ?? "";
	// Each case's clients and keys, released after it, each release tried whatever the others did.
	let cleanup = new AsyncDisposableStack();
	let prefix = "";
	const open = async (): Promise<{ client: RedisClient; storage: RedisSessionStorage }> => {
		const client = new RedisClient(url);
		cleanup.defer(() => client.close());
		return { client, storage: await RedisSessionStorage.create({ client, prefix }) };
	};
	const hget = async (client: RedisClient, hash: string, field: string) =>
		client.send("HGET", [`${prefix}${hash}`, field]);

	beforeEach(() => {
		const keys = `omp-test:${process.pid}:${Date.now().toString(36)}:`;
		prefix = keys;
		cleanup = new AsyncDisposableStack();
		// Registered first, so it runs after the case's clients close, on a client of its own.
		cleanup.defer(async () => {
			const cleaner = new RedisClient(url);
			try {
				const found = (await cleaner.send("KEYS", [`${keys}*`])) as string[];
				if (found.length > 0) await cleaner.send("DEL", found);
			} finally {
				cleaner.close();
			}
		});
	}, 30_000);
	afterEach(() => cleanup.disposeAsync(), 30_000);

	it("a refused move leaves both keys and both hashes as they were", async () => {
		const { client, storage } = await open();
		const other = await open();
		await storage.writeText("/s/a.jsonl", "ours\n");
		await other.storage.writeText("/s/b.jsonl", "theirs\n");
		const before = [await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)];

		await expect(storage.renameNoReplace("/s/a.jsonl", "/s/b.jsonl")).rejects.toMatchObject({
			code: "EEXIST",
			path: "/s/b.jsonl",
		});

		expect(await client.get(`${prefix}file:/s/a.jsonl`)).toBe("ours\n");
		expect(await client.get(`${prefix}file:/s/b.jsonl`)).toBe("theirs\n");
		expect([await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)]).toEqual(before);
	}, 30_000);

	it("a move carries the title metadata and drops a stale title at the destination", async () => {
		const { client, storage } = await open();
		await storage.writeText("/s/a.jsonl", "ours\n");
		await client.send("HSET", [`${prefix}title`, "/s/a.jsonl", '{"title":"Ours","updatedAt":"t1"}']);
		await client.send("HSET", [`${prefix}title`, "/s/c.jsonl", '{"title":"Stale","updatedAt":"t0"}']);

		await storage.renameNoReplace("/s/a.jsonl", "/s/c.jsonl");

		expect(await client.get(`${prefix}file:/s/c.jsonl`)).toBe("ours\n");
		expect(await hget(client, "title", "/s/c.jsonl")).toBe('{"title":"Ours","updatedAt":"t1"}');
		expect(await hget(client, "title", "/s/a.jsonl")).toBeNull();
		expect(await hget(client, "meta", "/s/a.jsonl")).toBeNull();
		expect(await hget(client, "meta", "/s/c.jsonl")).not.toBeNull();
	}, 30_000);

	it("deleting a session removes, in one command, every key and its metadata under the directory", async () => {
		const { client, storage } = await open();
		const other = await open();
		await storage.writeText("/s/p.jsonl", "parent\n");
		// Set by another client after this store loaded its view, and never refreshed into it.
		await other.storage.writeText("/s/p/Late*[x].jsonl", "late\n");
		await other.storage.writeText("/s/p-sibling.jsonl", "sibling\n");
		const send = client.send.bind(client);
		const commands: string[] = [];
		client.send = (command: string, args: string[]) => {
			commands.push(command);
			return send(command, args);
		};
		storage.refresh = async () => {};

		await storage.deleteSessionWithArtifacts("/s/p.jsonl");

		expect(commands).toEqual(["EVAL"]);
		expect(await client.exists(`${prefix}file:/s/p.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/s/p/Late*[x].jsonl`)).toBe(false);
		expect(await hget(client, "meta", "/s/p/Late*[x].jsonl")).toBeNull();
		expect(await client.get(`${prefix}file:/s/p-sibling.jsonl`)).toBe("sibling\n");
	}, 30_000);

	it("readTextSlices returns empty slices with no synthesized title when the body key is missing and a title hash entry survives", async () => {
		const { client, storage } = await open();
		const path = "/s/deleted-with-title.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		await client.send("DEL", [`${prefix}file:${path}`]);
		await client.send("HSET", [
			`${prefix}title`,
			path,
			JSON.stringify({ title: "Stale title", source: "user", updatedAt: "t2" }),
		]);

		expect(await storage.readTextSlices(path, 256, 64)).toEqual(["", ""]);
	}, 30_000);

	it("refuses a title update for a removed session and clears a title left at a path before an append starts a session there", async () => {
		const { client, storage } = await open();
		const stale = await open();
		const path = "/s/removed.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		await stale.storage.refresh();
		await storage.unlink(path);

		await expect(
			stale.storage.updateSessionTitle(path, { title: "Too late", source: "user", updatedAt: "t2" }),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await hget(client, "title", path)).toBeNull();

		// A title another build left at the path with no body.
		await client.send("HSET", [
			`${prefix}title`,
			path,
			JSON.stringify({ title: "Orphan", source: "user", updatedAt: "t2" }),
		]);
		const writer = storage.openWriter(path);
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();

		expect(await hget(client, "title", path)).toBeNull();
		expect((await storage.readText(path)).split("\n")[0]).toBe(SESSION_HEADER.slice(0, -1));
	}, 30_000);
});

/** A session's header and one entry naming it, so a read shows whose body it got. */
function bodyOf(name: string): string {
	return `${SESSION_HEADER}${JSON.stringify({ type: "custom", customType: "body", data: name })}\n`;
}

/** A Redis the store of one test runs on, with its keys under a prefix of the test's own. */
interface RedisUnderTest extends AsyncDisposable {
	readonly prefix: string;
	/** A client of the account the test runs as. */
	readonly client: RedisSessionStorageClient;
	/** A client of an account that may run every command the store runs but the writes `denial` names. */
	restricted(denial: WriteDenial): Promise<RedisSessionStorageClient>;
	/** Every key under the prefix with what it holds: a string's text, a hash's fields. */
	keys(): Promise<Record<string, string | Record<string, string>>>;
	/** Make `key` hold the string `value`, as another client's write of the wrong type would. */
	setString(key: string, value: string): Promise<void>;
}

/** Writes an account may not make: every run of a command, or every write of one metadata hash. */
interface WriteDenial {
	readonly command?: "hset" | "hdel";
	readonly hash?: "meta" | "title";
}

/** A store's operation, the script it runs, the metadata hashes that script writes, and a write it runs after its first. */
interface WriteOperation {
	readonly script: string;
	readonly name: string;
	readonly hashes: ReadonlyArray<"meta" | "title">;
	readonly denial: WriteDenial;
	/** The operation refreshes the store's index first, which reads the mtime hash, before its script. */
	readonly refreshesFirst?: true;
	run(storage: RedisSessionStorage): Promise<unknown>;
}

/** The sessions each operation starts from: a titled session with an artifact, and a titled one to move it onto. */
const CASE_SOURCE = "/s/source.jsonl";
const CASE_ARTIFACT = "/s/source/artifact.txt";
const CASE_TARGET = "/s/target.jsonl";

async function arrangeSessions(storage: RedisSessionStorage): Promise<void> {
	for (const [path, name] of [
		[CASE_SOURCE, "Source"],
		[CASE_TARGET, "Target"],
	]) {
		const written = serializeTitleSlot({ title: `${name} as written`, source: "auto", updatedAt: "t1" });
		await storage.writeText(path, `${written}${bodyOf(name)}`);
		await storage.updateSessionTitle(path, { title: `${name} renamed`, source: "user", updatedAt: "t2" });
	}
	await storage.writeText(CASE_ARTIFACT, "artifact\n");
}

/** Append `line` at `path` with a writer, closed whatever the append did: this rejects as the append failed. */
async function appendLine(storage: RedisSessionStorage, path: string, line: string): Promise<void> {
	const writer = storage.openWriter(path);
	try {
		await writer.append(line);
	} finally {
		// Rejects with the append's own error when it failed.
		await writer.close();
	}
}

const WRITE_OPERATIONS: readonly WriteOperation[] = [
	{
		script: "WRITE_FULL",
		name: "a full write",
		hashes: ["meta", "title"],
		denial: { command: "hset" },
		run: storage => storage.writeText(CASE_SOURCE, bodyOf("Rewritten")),
	},
	{
		script: "APPEND",
		name: "an append",
		hashes: ["meta"],
		denial: { command: "hset" },
		run: storage => appendLine(storage, CASE_SOURCE, "{}\n"),
	},
	{
		script: "APPEND",
		name: "an append that starts a session",
		hashes: ["meta", "title"],
		denial: { command: "hset" },
		run: storage => appendLine(storage, "/s/new.jsonl", SESSION_HEADER),
	},
	{
		script: "UPDATE_TITLE",
		name: "a title update",
		hashes: ["meta", "title"],
		denial: { hash: "title" },
		run: storage => storage.updateSessionTitle(CASE_SOURCE, { title: "Retitled", source: "user", updatedAt: "t3" }),
	},
	{
		script: "MOVE",
		name: "a move onto another session",
		hashes: ["meta", "title"],
		denial: { command: "hdel" },
		run: storage => storage.rename(CASE_SOURCE, CASE_TARGET),
	},
	{
		script: "REMOVE",
		name: "a removal of a session and its artifacts",
		hashes: ["meta", "title"],
		denial: { command: "hdel" },
		refreshesFirst: true,
		run: storage => storage.deleteSessionWithArtifacts(CASE_SOURCE),
	},
	{
		script: "REMOVE",
		name: "an unlink",
		hashes: ["meta", "title"],
		denial: { command: "hdel" },
		run: storage => storage.unlink(CASE_SOURCE),
	},
];

/**
 * One row per writing script and metadata hash it writes, and one per writing script whose account may not make a
 * write the script runs after its first: each operation rejects and leaves every key (bodies, both hashes'
 * fields, artifacts) as it was, so a failed removal can be retried and a failed move loses neither session. In the
 * first rows another client has made the hash a string (after the refresh of an operation that refreshes first, so
 * the script meets it), and the operation's own script must have run. The ACL rows fail, naming what is missing,
 * when `aclMissing` gives a reason the server cannot run them.
 */
function writeScriptCases(open: () => Promise<RedisUnderTest>, aclMissing: () => string | undefined): void {
	for (const operation of WRITE_OPERATIONS) {
		for (const hash of operation.hashes) {
			it(`${operation.script}: ${operation.name} writes nothing when the ${hash} hash holds a string`, async () => {
				await using redis = await open();
				const storage = await RedisSessionStorage.create({ client: redis.client, prefix: redis.prefix });
				await arrangeSessions(storage);
				let before: Record<string, string | Record<string, string>> = {};
				const corrupt = async (): Promise<void> => {
					await redis.setString(`${redis.prefix}${hash}`, "not a hash");
					before = await redis.keys();
				};
				if (operation.refreshesFirst) {
					const refresh = storage.refresh.bind(storage);
					storage.refresh = async () => {
						await refresh();
						await corrupt();
					};
				} else {
					await corrupt();
				}
				const scripts: string[] = [];
				const send = redis.client.send.bind(redis.client);
				redis.client.send = async (command, args) => {
					if (command === "EVAL") scripts.push(args[0]?.split("\n")[0] ?? "");
					return send(command, args);
				};

				await expect(operation.run(storage)).rejects.toThrow("WRONGTYPE");
				expect({ ran: scripts.includes(`-- OMP_${operation.script}`), keys: await redis.keys() }).toEqual({
					ran: true,
					keys: before,
				});
			}, 30_000);
		}
	}
	for (const operation of WRITE_OPERATIONS) {
		const denied = operation.denial.command ?? `write the ${operation.denial.hash} hash`;
		it(`${operation.script}: ${operation.name} writes nothing when the account may not ${denied}`, async () => {
			const missing = aclMissing();
			if (missing !== undefined) {
				throw new Error(`The ACL rows need Redis 7 or later and an account that may make users: ${missing}`);
			}
			await using redis = await open();
			await arrangeSessions(await RedisSessionStorage.create({ client: redis.client, prefix: redis.prefix }));
			const before = await redis.keys();
			const client = await redis.restricted(operation.denial);
			const storage = await RedisSessionStorage.create({ client, prefix: redis.prefix });

			await expect(operation.run(storage)).rejects.toThrow("NOPERM");
			expect(await redis.keys()).toEqual(before);
		}, 30_000);
	}
}

/** Every key `fake` holds under `prefix`, with what it holds: a string's text, a hash's fields. */
function fakeKeys(fake: FakeRedis, prefix: string): Record<string, string | Record<string, string>> {
	const keys: Record<string, string | Record<string, string>> = {};
	for (const [key, value] of fake.strings) if (key.startsWith(prefix)) keys[key] = value;
	for (const [key, fields] of fake.hashes) if (key.startsWith(prefix)) keys[key] = Object.fromEntries(fields);
	return keys;
}

/** The fake, which runs the scripts' Lua and models a key of the wrong type and an ACL's denials. */
async function fakeRedisUnderTest(): Promise<RedisUnderTest> {
	const fake = createFakeRedis();
	const prefix = "omp-test:";
	return {
		prefix,
		client: fake,
		async restricted(denial) {
			if (denial.command) fake.denyCommand(denial.command);
			if (denial.hash) fake.denyWrites(`${prefix}${denial.hash}`);
			return fake;
		},
		async keys() {
			return fakeKeys(fake, prefix);
		},
		async setString(key, value) {
			fake.hashes.delete(key);
			fake.strings.set(key, value);
		},
		async [Symbol.asyncDispose]() {},
	};
}

/**
 * The server `url` names: a key prefix of each test's own. At the end each client it made is closed, each user it
 * made deleted and its keys deleted, each release tried whatever the others did, and their errors thrown together.
 */
function serverRedisUnderTest(url: string): () => Promise<RedisUnderTest> {
	return async () => {
		const cleanup = new AsyncDisposableStack();
		const prefix = `omp-test:write-scripts:${crypto.randomUUID()}:`;
		// Registered first, so it runs last, on a client of its own: the test's may be closed or broken by then.
		cleanup.defer(async () => {
			const cleaner = new RedisClient(url);
			try {
				const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
				if (keys.length > 0) await cleaner.send("DEL", keys);
			} finally {
				cleaner.close();
			}
		});
		const connect = (target: string): RedisClient => {
			const client = new RedisClient(target);
			cleanup.defer(() => client.close());
			return client;
		};
		const admin = connect(url);
		return {
			prefix,
			client: admin,
			async restricted(denial) {
				const user = `omp-test-${crypto.randomUUID()}`;
				const password = crypto.randomUUID();
				// Registered before the user is made, so a half-made one goes too; deleting no user deletes nothing.
				cleanup.defer(async () => {
					await admin.send("ACL", ["DELUSER", user]);
				});
				// A denied hash: reads of every key, writes of every key but that hash. EVAL itself needs both on each key
				// it is given, so a selector lets it start the script, whose own writes the root rules still check. A
				// denied command: every key, every command but that one.
				const rules = denial.hash
					? [
							`%R~${prefix}*`,
							...["file:*", "meta", "title"].filter(key => key !== denial.hash).map(key => `%W~${prefix}${key}`),
							"+@all",
							`(~${prefix}* +eval)`,
						]
					: [`~${prefix}*`, "+@all", `-${denial.command}`];
				await admin.send("ACL", ["SETUSER", user, "reset", "on", `>${password}`, ...rules]);
				const target = new URL(url);
				target.username = user;
				target.password = password;
				return connect(target.toString());
			},
			async keys() {
				const keys: Record<string, string | Record<string, string>> = {};
				for (const key of (await admin.send("KEYS", [`${prefix}*`])) as string[]) {
					keys[key] =
						(await admin.send("TYPE", [key])) === "hash"
							? await admin.hgetall(key)
							: ((await admin.get(key)) ?? "");
				}
				return keys;
			},
			async setString(key, value) {
				await admin.send("DEL", [key]);
				await admin.send("SET", [key, value]);
			},
			[Symbol.asyncDispose]: () => cleanup.disposeAsync(),
		};
	};
}

const REDIS_URL = process.env.OMP_TEST_REDIS_URL;

/**
 * Why the ACL rows cannot run on the server `url` names, if they cannot: a server before Redis 7 gives a script no
 * `redis.acl_check_cmd` (the store skips the check there), and the rows need an account that may make users.
 */
async function whyNoAcl(url: string): Promise<string | undefined> {
	const client = new RedisClient(url);
	try {
		const info = String(await client.send("INFO", ["server"]));
		const major = Number(/redis_version:(\d+)/.exec(info)?.[1] ?? 0);
		if (major < 7) return `Redis ${major} gives a script no redis.acl_check_cmd`;
		const probe = `omp-test-probe-${crypto.randomUUID()}`;
		await client.send("ACL", ["SETUSER", probe, "reset"]);
		await client.send("ACL", ["DELUSER", probe]);
		return undefined;
	} catch (err) {
		return `the test account may not make ACL users: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		client.close();
	}
}

describe("RedisSessionStorage write scripts that cannot finish (fake)", () => {
	writeScriptCases(fakeRedisUnderTest, () => undefined);
});

describe("RedisSessionStorage removal an account may not finish (fake)", () => {
	const prefix = "omp:sessions:";
	const sessionKey = `${prefix}file:${CASE_SOURCE}`;
	const artifactKey = `${prefix}file:${CASE_ARTIFACT}`;

	// A server before Redis 7 gives a script no `redis.acl_check_cmd`, so a removal runs its writes unchecked, and one
	// the account may not make fails the script after the writes before it. If this regresses, an account that may
	// delete keys but not HDEL loses the session's key before the script fails at the session's metadata, short of
	// the artifact's key: a reopened store no longer lists the session, so no removal reaches the artifact it leaves
	// behind.
	it("deletes the keys of a session and its artifacts before it fails at a refused HDEL on a server before Redis 7, leaving only their metadata", async () => {
		const redis = createFakeRedis({ aclCheckCmd: false });
		const storage = await RedisSessionStorage.create({ client: redis });
		await arrangeSessions(storage);
		const before = fakeKeys(redis, prefix);

		redis.denyCommand("hdel");
		await expect(storage.deleteSessionWithArtifacts(CASE_SOURCE)).rejects.toThrow("NOPERM");
		const reopened = await RedisSessionStorage.create({ client: redis });
		expect({
			keys: fakeKeys(redis, prefix),
			listed: [CASE_SOURCE, CASE_ARTIFACT].filter(path => reopened.existsSync(path)),
		}).toEqual({
			keys: Object.fromEntries(Object.entries(before).filter(([key]) => key !== sessionKey && key !== artifactKey)),
			listed: [],
		});
	}, 30_000);

	// The removal finds its keys inside the script, so Redis checks each when a command of the script names it (Redis
	// 6.2 as 7), and the script reads every key it deletes before its first write. If this regresses, an account whose
	// key patterns leave out an artifact's key (here from after the removal's refresh) deletes keys before the script
	// fails at the artifact's.
	it("leaves every key as it was when its script fails at an artifact key the account may not touch, on a server before Redis 7", async () => {
		const redis = createFakeRedis({ aclCheckCmd: false });
		const storage = await RedisSessionStorage.create({ client: redis });
		await arrangeSessions(storage);
		const before = fakeKeys(redis, prefix);
		const refresh = storage.refresh.bind(storage);
		storage.refresh = async () => {
			await refresh();
			redis.denyKey(artifactKey);
		};

		await expect(storage.deleteSessionWithArtifacts(CASE_SOURCE)).rejects.toThrow(
			"NOPERM No permissions to access a key",
		);
		expect(fakeKeys(redis, prefix)).toEqual(before);
	}, 30_000);
});

describe.skipIf(!REDIS_URL)("RedisSessionStorage write scripts that cannot finish (Redis server)", () => {
	let aclMissing: string | undefined = "the ACL probe did not finish";
	beforeAll(async () => {
		aclMissing = await whyNoAcl(REDIS_URL ?? "");
	}, 30_000);

	writeScriptCases(serverRedisUnderTest(REDIS_URL ?? ""), () => aclMissing);
});
