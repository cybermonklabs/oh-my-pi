import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { ErrorsRoute } from "../src/client/routes/ErrorsRoute";
import { mountDomRoot, tearDownDomRoot } from "./helpers/dom-root";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

afterEach(async () => {
	await tearDownDomRoot();
	vi.restoreAllMocks();
});

describe("ErrorsRoute range", () => {
	it("requests the selected range again when the range changes", async () => {
		const root = await mountDomRoot();
		const requestedUrls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, _init?: FetchInit) => {
				requestedUrls.push(input instanceof Request ? input.url : input.toString());
				return Response.json([]);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await act(async () => {
			root.render(<ErrorsRoute active range="24h" onRequestClick={() => {}} />);
		});
		expect(requestedUrls).toEqual(["/api/stats/errors?range=24h&limit=50"]);

		await act(async () => {
			root.render(<ErrorsRoute active range="7d" onRequestClick={() => {}} />);
		});
		expect(requestedUrls).toEqual(["/api/stats/errors?range=24h&limit=50", "/api/stats/errors?range=7d&limit=50"]);
	});
});
