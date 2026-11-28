import { encodeAsar } from "./asar";
import { gzipCompress } from "./codecs/gzip";
import { zstdCompress } from "./codecs/zstd";
import { memberContentToBytes } from "./open";
import { encodeTar, type TarMemberPayload, writeTarFile } from "./tar";
import type { ArchiveFormat, ArchiveMemberContent, WritableArchiveFormat } from "./types";
import { encodeZip } from "./zip";

const TEXT_ENCODER = new TextEncoder();

const WRITABLE_FORMATS: Record<WritableArchiveFormat, true> = {
	zip: true,
	tar: true,
	"tar.gz": true,
	"tar.zst": true,
	asar: true,
};

/** Whether `format` can be serialized by {@link writeArchive} (rest are read-only). */
export function isWritableArchiveFormat(format: ArchiveFormat): format is WritableArchiveFormat {
	return format in WRITABLE_FORMATS;
}

/** One archive entry: its member name and content. */
type ArchiveEntry = readonly [string, ArchiveMemberContent];

/**
 * `entries` as they are packed, one at a time: member names normalized to
 * forward slashes, string members encoded as UTF-8, and binary members
 * (`Uint8Array` or `Blob`) passed on unread, so a `Blob` from another realm,
 * which is not `instanceof Blob`, still streams.
 */
async function* packedMembers(
	entries: Iterable<ArchiveEntry> | AsyncIterable<ArchiveEntry>,
): AsyncGenerator<readonly [string, TarMemberPayload]> {
	for await (const [name, content] of entries) {
		yield [name.replace(/\\/g, "/"), typeof content === "string" ? TEXT_ENCODER.encode(content) : content];
	}
}

/**
 * Serialize `entries` into an archive of `format` in memory. String members
 * are encoded as UTF-8; member names are normalized to forward slashes.
 */
export async function encodeArchive(
	format: WritableArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<Uint8Array> {
	const members: (readonly [string, Uint8Array])[] = [];
	for await (const [name, payload] of packedMembers(entries)) {
		members.push([name, await memberContentToBytes(payload)] as const);
	}
	switch (format) {
		case "zip":
			return encodeZip(members);
		case "asar":
			return encodeAsar(members);
		case "tar":
			return encodeTar(members);
		case "tar.gz":
			return gzipCompress(await encodeTar(members));
		case "tar.zst":
			return zstdCompress(await encodeTar(members));
	}
}

/** {@link encodeArchive}, written to `destPath` (parent directories auto-created). */
export async function writeArchive(
	destPath: string,
	format: WritableArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<void> {
	await Bun.write(destPath, await encodeArchive(format, entries));
}

/**
 * {@link writeArchive} for a plain tar, written member by member: the same
 * bytes, but a `Blob` member (e.g. `Bun.file`) streams from its source, so the
 * archive is never built in memory. `entries` may be an async iterable: the
 * writer takes each entry only once the one before it is written. Parent
 * directories are auto-created. Unlike `writeArchive`, which builds the whole
 * archive before it writes, this empties `destPath` first, so a failure leaves
 * a truncated file there: write to a staging file and rename it over the
 * target on success, as its one caller (`packSession`) does.
 */
export async function writeTarArchive(
	destPath: string,
	entries: Iterable<ArchiveEntry> | AsyncIterable<ArchiveEntry>,
): Promise<void> {
	await writeTarFile(destPath, packedMembers(entries));
}
