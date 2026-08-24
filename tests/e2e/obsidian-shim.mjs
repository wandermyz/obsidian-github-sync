/**
 * Minimal stand-ins for the Obsidian APIs the sync engine uses, so `src/` can
 * run under plain Node against a real GitHub repository.
 *
 * Only what the engine actually touches is implemented. Everything here is a
 * thin wrapper over `node:fs` or `fetch` — deliberately dumb, because the point
 * of the e2e tests is to exercise the plugin's logic, not a second
 * reimplementation of Obsidian.
 *
 * The one behaviour worth mirroring carefully is `DataAdapter`: the engine
 * chose the adapter over the Vault API precisely because it is filesystem-first
 * (see the comment on SyncEngine.writeFile), and these tests would be worthless
 * if the shim quietly restored index-like semantics.
 */
import fs from "node:fs/promises";
import path from "node:path";

export function normalizePath(p) {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export const Platform = { isMobile: false, isDesktop: true };

/**
 * `requestUrl` over `fetch`. Obsidian's version bypasses CORS and always
 * resolves — `throw: false` means the caller inspects `status` itself — so the
 * shim must not reject on 4xx either.
 */
export async function requestUrl(options) {
	const { url, method = "GET", headers = {}, body, throw: doThrow = true } = options;
	const res = await fetch(url, { method, headers, body });
	const text = await res.text();

	let json;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}

	if (doThrow && res.status >= 400) {
		throw new Error(`Request failed, status ${res.status}`);
	}
	return { status: res.status, text, json, headers: Object.fromEntries(res.headers) };
}

/** A DataAdapter backed by a real directory. Paths are vault-relative. */
export class FsAdapter {
	constructor(root) {
		this.root = root;
	}

	full(p) {
		// "" and "/" both mean the vault root.
		const rel = p === "/" || p === "" ? "" : p;
		return path.join(this.root, rel);
	}

	async exists(p) {
		try {
			await fs.stat(this.full(p));
			return true;
		} catch {
			return false;
		}
	}

	async read(p) {
		return fs.readFile(this.full(p), "utf8");
	}

	async write(p, data) {
		await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
		await fs.writeFile(this.full(p), data, "utf8");
	}

	async readBinary(p) {
		const buf = await fs.readFile(this.full(p));
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}

	async writeBinary(p, data) {
		// Deliberately no mkdir here: the real adapter doesn't create parents
		// either, which is why the engine has ensureParentFolder(). Creating them
		// silently would hide a regression in it.
		await fs.writeFile(this.full(p), Buffer.from(data));
	}

	async mkdir(p) {
		// Non-recursive, matching Obsidian: the engine walks the levels itself.
		await fs.mkdir(this.full(p));
	}

	async trashLocal(p) {
		await fs.rm(this.full(p), { force: true });
	}

	async remove(p) {
		await fs.rm(this.full(p), { force: true });
	}

	/** Returns vault-relative paths, as Obsidian's does. */
	async list(p) {
		const dir = this.full(p);
		const prefix = p === "/" || p === "" ? "" : `${p}/`;
		const files = [];
		const folders = [];
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const rel = `${prefix}${entry.name}`;
			if (entry.isDirectory()) folders.push(rel);
			else files.push(rel);
		}
		return { files, folders };
	}
}

/** The engine only ever reaches through to `vault.adapter`. */
export function fakeVault(root) {
	return { adapter: new FsAdapter(root) };
}
