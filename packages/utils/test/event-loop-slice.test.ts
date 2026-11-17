import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	EVENT_LOOP_SLICE_MS,
	mapInSlices,
	nextSlice,
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
