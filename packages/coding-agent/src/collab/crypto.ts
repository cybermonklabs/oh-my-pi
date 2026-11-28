/**
 * AES-256-GCM sealing for collab frames.
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 * Sealed layout: `[12B IV][ciphertext+tag]`.
 */
import { asStrictBytes } from "@oh-my-pi/pi-utils";
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";
import type { CollabFrame } from "./protocol";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(ROOM_KEY_BYTES);
	crypto.getRandomValues(key);
	return key;
}

export function generateWriteToken(): Uint8Array {
	const token = new Uint8Array(WRITE_TOKEN_BYTES);
	crypto.getRandomValues(token);
	return token;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== ROOM_KEY_BYTES) {
		throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
	}
	return crypto.subtle.importKey("raw", asStrictBytes(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, frame: CollabFrame): Promise<Uint8Array> {
	return sealSerialized(key, JSON.stringify(frame));
}

export async function sealSerialized(key: CryptoKey, frame: string): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	const plaintext = TEXT_ENCODER.encode(frame);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

/** Why {@link open} refuses a `fetch-transcript`; fixed, so a reply never echoes what the peer sent. */
export const FETCH_TRANSCRIPT_FROM_BYTE_REFUSAL = "fetch-transcript fromByte must be a safe integer";

/**
 * A frame {@link open} decrypted and authenticated, so a room peer sent it, but refuses to hand on: a field is unfit
 * to act on. Unlike a frame that does not decrypt, it is answered when it names its request: the host replies under
 * `reqId` with the fixed `message`. `reqId` is the frame's only when that is a safe integer.
 */
export class CollabFrameRefusedError extends Error {
	readonly reqId: number | undefined;

	constructor(reqId: unknown, message: string) {
		super(message);
		this.name = "CollabFrameRefusedError";
		this.reqId = typeof reqId === "number" && Number.isSafeInteger(reqId) ? reqId : undefined;
	}
}

/**
 * Inverse of {@link seal}. Throws on auth failure or malformed input, and with a {@link CollabFrameRefusedError} on
 * a `fetch-transcript` frame whose `fromByte` is not a safe integer: the host reads the transcript from that byte,
 * and session reads answer only whole offsets as they always have.
 */
export async function open(key: CryptoKey, data: Uint8Array): Promise<CollabFrame> {
	if (data.byteLength <= IV_LENGTH) {
		throw new Error("Sealed frame too short");
	}
	const iv = asStrictBytes(data.subarray(0, IV_LENGTH));
	const ciphertext = asStrictBytes(data.subarray(IV_LENGTH));
	const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
	const frame = JSON.parse(TEXT_DECODER.decode(plaintext)) as CollabFrame;
	if (frame.t === "fetch-transcript" && !Number.isSafeInteger(frame.fromByte)) {
		throw new CollabFrameRefusedError(frame.reqId, FETCH_TRANSCRIPT_FROM_BYTE_REFUSAL);
	}
	return frame;
}
