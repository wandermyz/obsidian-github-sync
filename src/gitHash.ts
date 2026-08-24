/**
 * Git object hashing.
 *
 * Every blob GitHub reports carries its git SHA-1, computed over
 * `blob <bytelength>\0<bytes>`. Recomputing that locally after a write is the
 * cheapest possible integrity check: no extra network call, no server-side
 * support, and it catches truncated writes, encoding damage, and mid-sync
 * corruption alike. Comparing sizes alone would miss all three.
 *
 * SHA-1 is used because git uses it — this is corruption detection against a
 * value GitHub already published, not a security boundary.
 */

const encoder = new TextEncoder();

/** Compute the git blob SHA-1 of raw bytes. */
export async function gitBlobSha(content: ArrayBuffer): Promise<string> {
	const header = encoder.encode(`blob ${content.byteLength}\0`);
	const payload = new Uint8Array(header.byteLength + content.byteLength);
	payload.set(header, 0);
	payload.set(new Uint8Array(content), header.byteLength);

	const digest = await crypto.subtle.digest("SHA-1", payload);
	return hex(digest);
}

/** Compute the git blob SHA-1 of a UTF-8 string. */
export async function gitBlobShaOfText(text: string): Promise<string> {
	const bytes = encoder.encode(text);
	// Copy into a standalone buffer: encode() may return a view into a larger one.
	return gitBlobSha(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Decode GitHub's base64 blob payload into raw bytes. */
export function base64ToBytes(base64: string): ArrayBuffer {
	// GitHub wraps base64 at 60 chars; atob rejects the newlines.
	const clean = base64.replace(/\s/g, "");
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

/** Encode raw bytes as base64 for a blob upload. */
export function bytesToBase64(content: ArrayBuffer): string {
	const bytes = new Uint8Array(content);
	// Chunked: String.fromCharCode with a whole vault-sized file spread across
	// its arguments blows the call-stack limit.
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
