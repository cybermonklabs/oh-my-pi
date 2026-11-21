/**
 * A Linux lock held the way an omp build before the sidecar lock held it: a
 * datagram socket bound to the abstract name of the lock's path (9058ab9d
 * `crates/pi-natives/src/file_lock/linux.rs`, the name from `memory_lock_name`
 * in `file_lock/mod.rs`). Lets a test meet an older build's lock without an
 * older build.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const AF_UNIX = 1;
const SOCK_DGRAM = 2;
const SOCK_CLOEXEC = 0o2000000;
const HIGH_SEED = 0x4f4d_502d_4c4f_434bn;
const LOW_SEED = 0x5049_2d46_494c_454cn;

/** The abstract-socket name an older build binds to hold `lockPath`. */
function olderBuildLockName(lockPath: string): string {
	const bytes = new TextEncoder().encode(lockPath);
	const high = Bun.hash.xxHash64(bytes, HIGH_SEED).toString(16).padStart(16, "0");
	const low = Bun.hash.xxHash64(bytes, LOW_SEED).toString(16).padStart(16, "0");
	return `omp-file-lock-${high}${low}`;
}

/** Hold `lockPath` as an older Linux build does, until the returned function runs. */
export function holdAsAnOlderLinuxBuild(lockPath: string): () => void {
	const libc = dlopen("libc.so.6", {
		socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		close: { args: [FFIType.i32], returns: FFIType.i32 },
	});
	const name = olderBuildLockName(lockPath);
	// struct sockaddr_un: sun_family (host order; little-endian on the targets
	// this runs on), then sun_path, whose leading 0 byte makes the name abstract.
	const address = new Uint8Array(2 + 1 + name.length);
	new DataView(address.buffer).setUint16(0, AF_UNIX, true);
	address.set(new TextEncoder().encode(name), 3);
	const fd = libc.symbols.socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	if (fd < 0) {
		libc.close();
		throw new Error("socket(AF_UNIX, SOCK_DGRAM) failed");
	}
	if (libc.symbols.bind(fd, ptr(address), address.length) !== 0) {
		libc.symbols.close(fd);
		libc.close();
		throw new Error(`binding the older build's name ${name} for ${lockPath} failed`);
	}
	return () => {
		libc.symbols.close(fd);
		libc.close();
	};
}
