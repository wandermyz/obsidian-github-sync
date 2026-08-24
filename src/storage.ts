import { Plugin, normalizePath } from "obsidian";
import type { SyncState } from "./sync";

/**
 * State that must NOT travel between devices.
 *
 * Two separate reasons, one file:
 *
 * - The OAuth token is a credential. If the vault is a git repo, it has no
 *   business being committed.
 * - `syncState` describes *this* vault's contents. Copying it to another device
 *   would make that device believe it already holds files it has never
 *   downloaded, and it would silently skip them forever.
 *
 * Everything else lives in the normal `data.json`, which is safe to sync.
 */
export interface LocalState {
	accessToken: string;
	login: string;
	/** Epoch ms when accessToken expires; 0 when the app issues non-expiring tokens. */
	accessTokenExpiresAt: number;
	refreshToken: string;
	refreshTokenExpiresAt: number;
	/** Vault contents as of the last successful sync. */
	syncState: SyncState | null;
}

export const DEFAULT_LOCAL: LocalState = {
	accessToken: "",
	login: "",
	accessTokenExpiresAt: 0,
	refreshToken: "",
	refreshTokenExpiresAt: 0,
	syncState: null,
};

/** Filename inside the plugin folder. Add this to .gitignore. */
export const LOCAL_FILE = "local.json";

export function localStatePath(plugin: Plugin): string {
	// manifest.dir is vault-relative, e.g. ".obsidian/plugins/obsidian-github-sync".
	return normalizePath(`${plugin.manifest.dir}/${LOCAL_FILE}`);
}

export async function loadLocalState(plugin: Plugin): Promise<LocalState> {
	const path = localStatePath(plugin);
	const adapter = plugin.app.vault.adapter;
	if (!(await adapter.exists(path))) return { ...DEFAULT_LOCAL };
	try {
		return { ...DEFAULT_LOCAL, ...JSON.parse(await adapter.read(path)) };
	} catch (err) {
		// A corrupt file must not brick the plugin — the worst case is signing in
		// again and re-syncing, both recoverable.
		console.error("[github-sync] could not read local state; starting fresh", err);
		return { ...DEFAULT_LOCAL };
	}
}

export async function saveLocalState(plugin: Plugin, state: LocalState): Promise<void> {
	await plugin.app.vault.adapter.write(localStatePath(plugin), JSON.stringify(state, null, 2));
}
