/**
 * A loopback listener that a test's child process dials as soon as it runs and holds until it dies: `started`
 * resolves on that connection and `exited` when it closes, which only the process's death does. So a test waits on
 * the child's own events, not on a time.
 */
export function livenessListener(): {
	port: number;
	started: Promise<void>;
	exited: Promise<void>;
	[Symbol.dispose](): void;
} {
	const started = Promise.withResolvers<void>();
	const exited = Promise.withResolvers<void>();
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open: () => started.resolve(),
			data() {},
			end: () => exited.resolve(),
			close: () => exited.resolve(),
			error: () => exited.resolve(),
		},
	});
	return {
		port: listener.port,
		started: started.promise,
		exited: exited.promise,
		[Symbol.dispose]: () => listener.stop(true),
	};
}

/** The source of a child that dials `port` and holds the connection until it is killed. */
export function dialAndHold(port: number): string {
	return `await Bun.connect({hostname:"127.0.0.1",port:${port},socket:{data(){},close(){},error(){}}});await Bun.sleep(60_000);`;
}
