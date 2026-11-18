import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	EVENT_LOOP_SLICE_MS,
	mapInSlices,
	nextSlice,
	readJsonInSlices,
	runInSlices,
	sliceExpired,
} from "@oh-my-pi/pi-utils/event-loop-slice";

const UNIT_MS = 4;
/** Units one slice runs: the check before a unit ends the slice once the budget is used. */
const UNITS_PER_SLICE = Math.ceil(EVENT_LOOP_SLICE_MS / UNIT_MS);

/** A clock that advances only when a unit of work says it ran. */
function mockWorkClock(): { spend: (ms: number) => void } {
	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	return { spend: ms => (now += ms) };
}

/** Numbers the event loop's turns, so a test can see which units ran in the same turn. */
function countTurns(): { turn: () => number; stop: () => void } {
	let turn = 0;
	let running = true;
	const tick = () => {
		turn++;
		if (running) setImmediate(tick);
	};
	setImmediate(tick);
	return { turn: () => turn, stop: () => (running = false) };
}

function sliceSizes(unitTurns: number[]): number[] {
	return [...Map.groupBy(unitTurns, turn => turn).values()].map(units => units.length);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("mapInSlices", () => {
	it("returns to the event loop once a slice has used its budget, so timers and sockets are not held for the whole pass", async () => {
		const clock = mockWorkClock();
		const turns = countTurns();
		const unitTurns: number[] = [];
		const items = Array.from({ length: UNITS_PER_SLICE * 3 }, (_, index) => index);
		const out = await mapInSlices(items, value => {
			unitTurns.push(turns.turn());
			clock.spend(UNIT_MS);
			return value * 2;
		});
		turns.stop();
		expect(out).toEqual(items.map(value => value * 2));
		expect(sliceSizes(unitTurns)).toEqual([UNITS_PER_SLICE, UNITS_PER_SLICE, UNITS_PER_SLICE]);
	});

	it("shares one slice between concurrent passes instead of giving each pass a full budget", async () => {
		const clock = mockWorkClock();
		const turns = countTurns();
		const unitTurns: number[] = [];
		const unit = () => {
			unitTurns.push(turns.turn());
			clock.spend(UNIT_MS);
		};
		const items = Array.from({ length: UNITS_PER_SLICE * 2 }, (_, index) => index);
		await Promise.all([mapInSlices(items, unit), mapInSlices(items, unit)]);
		turns.stop();
		expect(unitTurns).toHaveLength(items.length * 2);
		expect(Math.max(...sliceSizes(unitTurns))).toBe(UNITS_PER_SLICE);
	});

	it("lets a short pass run while a long one is still going, so concurrent passes take the budget in turn", async () => {
		const clock = mockWorkClock();
		const turns = countTurns();
		const longUnits: number[] = [];
		const shortUnits: number[] = [];
		const unit = (into: number[]) => () => {
			into.push(turns.turn());
			clock.spend(UNIT_MS);
		};
		const long = Array.from({ length: UNITS_PER_SLICE * 10 }, (_, index) => index);
		const short = Array.from({ length: UNITS_PER_SLICE }, (_, index) => index);
		await Promise.all([mapInSlices(long, unit(longUnits)), mapInSlices(short, unit(shortUnits))]);
		turns.stop();
		expect(longUnits).toHaveLength(long.length);
		expect(shortUnits).toHaveLength(short.length);
		// The short pass finishes within a few turns, long before the long pass's last unit.
		expect(Math.max(...shortUnits)).toBeLessThan(Math.max(...longUnits) - UNITS_PER_SLICE);
		expect(Math.max(...sliceSizes([...longUnits, ...shortUnits]))).toBe(UNITS_PER_SLICE);
	});

	it("admits a unit at the first check after a turn, however long other work in that turn took", async () => {
		const clock = mockWorkClock();
		// Open a slice, then wait for the turn that closes it.
		expect(sliceExpired()).toBe(false);
		await nextSlice();
		// Other work holds the new turn for several slice budgets before the pass resumes.
		clock.spend(EVENT_LOOP_SLICE_MS * 5);
		// Counting that work against the pass would make it yield on every turn and never finish.
		expect(sliceExpired()).toBe(false);
		clock.spend(EVENT_LOOP_SLICE_MS);
		expect(sliceExpired()).toBe(true);
	});

	it("opens no second slice in one pass through the event loop, so other work and a slice together cannot hold off due timers", async () => {
		// Real time: the timers' 1 ms clamp must pass while the slice works.
		const busy = (ms: number) => {
			const start = performance.now();
			while (performance.now() - start < ms) {}
		};
		let timerTurns = 0;
		let counting = true;
		const countTimers = () => {
			if (!counting) return;
			timerTurns++;
			setTimeout(countTimers, 0);
		};
		setTimeout(countTimers, 0);
		await new Promise(resolve => setTimeout(resolve, 5));
		const unitTimerTurns: Record<string, number> = {};
		// The first pass runs one unit longer than a slice's budget, in this pass through the event loop.
		const first = mapInSlices(["first"], name => {
			unitTimerTurns[name] = timerTurns;
			busy(EVENT_LOOP_SLICE_MS + 2);
		});
		// Other work later in the same pass resumes a second pass before the timers run again.
		const second = new Promise<void>(resolve => {
			setImmediate(() => {
				void mapInSlices(["second"], name => {
					unitTimerTurns[name] = timerTurns;
				}).then(() => resolve());
			});
		});
		await Promise.all([first, second]);
		counting = false;
		// The second pass's unit waited for the timers.
		expect(unitTimerTurns.second).toBeGreaterThan(unitTimerTurns.first);
	});

	it("runs a timer that fell due during a slice before the same pass's next slice", async () => {
		// Real time: each unit outlasts a slice's budget and the timers' 1 ms clamp.
		const busy = (ms: number) => {
			const start = performance.now();
			while (performance.now() - start < ms) {}
		};
		let fired = false;
		const seen: boolean[] = [];
		await mapInSlices([0, 1, 2], index => {
			if (index > 0) seen.push(fired);
			fired = false;
			setTimeout(() => (fired = true), 0);
			busy(EVENT_LOOP_SLICE_MS + 2);
		});
		// Each unit spent a slice, so the pass's release waited for the timers.
		expect(seen).toEqual([true, true]);
	});

	it("closes a slice that a pass finished inside, so the next pass after an idle wait runs a unit at once", async () => {
		await mapInSlices([0], value => value);
		await new Promise(resolve => setTimeout(resolve, EVENT_LOOP_SLICE_MS * 2));
		expect(sliceExpired()).toBe(false);
	});

	it("ends a pass under fake timers with a clock that moves, though the timers that close slices never run", async () => {
		vi.useFakeTimers();
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now++);
		const units = await mapInSlices(
			Array.from({ length: 500 }, (_, index) => index),
			value => value,
		);
		expect(units.length).toBe(500);
	}, 3_000);

	it("runs to completion under fake timers, whose frozen clock never ends a slice", async () => {
		vi.useFakeTimers();
		let spin = 0;
		const out = await mapInSlices([1, 2, 3], value => {
			for (let i = 0; i < 100_000; i++) spin += i;
			return value + 1;
		});
		expect(out).toEqual([2, 3, 4]);
		expect(spin).toBeGreaterThan(0);
	});
});

describe("runInSlices", () => {
	it("ends a unit at each yield of the steps and returns their value", async () => {
		const clock = mockWorkClock();
		const turns = countTurns();
		const unitTurns: number[] = [];
		function* steps(): Generator<void, string, undefined> {
			for (let index = 0; index < UNITS_PER_SLICE * 2; index++) {
				yield;
				unitTurns.push(turns.turn());
				clock.spend(UNIT_MS);
			}
			return "done";
		}
		expect(await runInSlices(steps())).toBe("done");
		turns.stop();
		expect(sliceSizes(unitTurns)).toEqual([UNITS_PER_SLICE, UNITS_PER_SLICE]);
	});
});

describe("readJsonInSlices", () => {
	it("parses each fetched payload in a slice of its own, so two that arrive together do not hold off due timers", async () => {
		// About 10 MB: its parse outlasts a slice's budget on any machine.
		const body = JSON.stringify(
			Array.from({ length: 150_000 }, (_, index) => ({
				id: `model-${index}`,
				name: `Model ${index}`,
				window: index,
			})),
		);
		let fired = false;
		setTimeout(() => (fired = true), 0);
		const firedAtEnd: boolean[] = [];
		const parsed = await Promise.all(
			[new Response(body), new Response(body)].map(async response => {
				const payload = await readJsonInSlices(response);
				firedAtEnd.push(fired);
				return payload;
			}),
		);
		expect(parsed.map(payload => (payload as unknown[]).length)).toEqual([150_000, 150_000]);
		// The second payload's parse waited for the timers.
		expect(firedAtEnd[1]).toBe(true);
	});
});
