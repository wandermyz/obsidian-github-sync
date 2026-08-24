import { DataAdapter, Vault, normalizePath } from "obsidian";
import { CompareFile, GitHubClient } from "./github";
import { gitBlobSha } from "./gitHash";

/**
 * What the vault holds, as of the last successful sync.
 *
 * `commit` is the commit the local files were materialized from; `blobs` maps
 * vault-relative path -> git blob SHA. Keeping the blob SHAs means a file the
 * user edited locally is detectable without re-downloading anything.
 */
export interface SyncState {
	commit: string;
	blobs: Record<string, string>;
	lastSyncedAt: number;
}

export interface SyncOptions {
	owner: string;
	repo: string;
	branch: string;
	/** Vault subfolder to sync into; "" means the vault root. */
	targetFolder: string;
	/** Repo subfolder to sync from; "" means the repo root. */
	remoteFolder: string;
}

export type SyncMode = "full" | "incremental";

export interface SyncReport {
	mode: SyncMode;
	commit: string;
	added: number;
	updated: number;
	deleted: number;
	unchanged: number;
	skippedLocalEdits: string[];
	verifiedFiles: number;
	integrityFailures: string[];
	/** Human-readable reason a full sync was chosen over an incremental one. */
	reason: string;
}

/** One file operation to apply to the vault. */
interface PlannedWrite {
	path: string;
	blobSha: string;
}

export interface SyncPlan {
	mode: SyncMode;
	reason: string;
	targetCommit: string;
	writes: PlannedWrite[];
	deletes: string[];
	unchanged: number;
}

/**
 * Files we refuse to materialize into the vault. `.obsidian` would let a repo
 * overwrite the user's plugin config — including this plugin's own data.json,
 * which holds the access token.
 */
function isRefused(path: string): boolean {
	return path === ".obsidian" || path.startsWith(".obsidian/") || path.includes("/.obsidian/");
}

export class SyncEngine {
	/**
	 * All file I/O goes through the adapter, not the Vault API — see writeFile().
	 */
	private adapter: DataAdapter;

	constructor(
		private vault: Vault,
		private client: GitHubClient,
		private opts: SyncOptions,
	) {
		this.adapter = vault.adapter;
	}

	/** Map a repo path to its vault path, or null if outside the synced subtree. */
	private toVaultPath(repoPath: string): string | null {
		const prefix = this.opts.remoteFolder ? `${this.opts.remoteFolder.replace(/\/+$/, "")}/` : "";
		if (prefix && !repoPath.startsWith(prefix)) return null;
		const relative = repoPath.slice(prefix.length);
		if (!relative || isRefused(relative)) return null;
		const folder = this.opts.targetFolder.replace(/\/+$/, "");
		return normalizePath(folder ? `${folder}/${relative}` : relative);
	}

	/**
	 * Decide what to do. Incremental when we have a known-good previous commit
	 * and GitHub can describe the diff; full otherwise.
	 */
	async plan(state: SyncState | null): Promise<SyncPlan> {
		const { owner, repo, branch } = this.opts;
		const head = await this.client.branchHead(owner, repo, branch);

		if (state?.commit === head) {
			return {
				mode: "incremental",
				reason: "Already at the latest commit.",
				targetCommit: head,
				writes: [],
				deletes: [],
				unchanged: Object.keys(state.blobs).length,
			};
		}

		if (state?.commit) {
			const incremental = await this.tryIncrementalPlan(state, head);
			if (incremental) return incremental;
		}

		return this.fullPlan(head, state?.commit ? "Diff unusable — falling back to a full sync." : "First sync.");
	}

	/** Returns null when the diff can't be trusted and a full sync is required. */
	private async tryIncrementalPlan(state: SyncState, head: string): Promise<SyncPlan | null> {
		const { owner, repo } = this.opts;

		let comparison;
		try {
			comparison = await this.client.compare(owner, repo, state.commit, head);
		} catch (err) {
			// A force-push or GC'd commit makes the base unresolvable (404).
			console.warn("[github-sync] compare failed, will full-sync", err);
			return null;
		}

		// "diverged" means history was rewritten; the diff no longer describes
		// how to get from our files to head. Same for a truncated file list.
		if (comparison.status === "diverged") return null;
		if (comparison.truncated) return null;

		const writes: PlannedWrite[] = [];
		const deletes: string[] = [];

		for (const file of comparison.files) {
			this.applyCompareEntry(file, writes, deletes);
		}

		return {
			mode: "incremental",
			reason: `${comparison.total_commits} commit(s), ${comparison.files.length} changed path(s).`,
			targetCommit: head,
			writes,
			deletes,
			unchanged: Object.keys(state.blobs).length - writes.length - deletes.length,
		};
	}

	private applyCompareEntry(file: CompareFile, writes: PlannedWrite[], deletes: string[]) {
		const vaultPath = this.toVaultPath(file.filename);

		if (file.status === "removed") {
			if (vaultPath) deletes.push(vaultPath);
			return;
		}

		if (file.status === "renamed" && file.previous_filename) {
			const oldPath = this.toVaultPath(file.previous_filename);
			if (oldPath) deletes.push(oldPath);
		}

		// "unchanged" appears in compare output for files touched then reverted.
		if (file.status === "unchanged") return;
		if (vaultPath) writes.push({ path: vaultPath, blobSha: file.sha });
	}

	private async fullPlan(head: string, reason: string): Promise<SyncPlan> {
		const tree = await this.client.listTree(this.opts.owner, this.opts.repo, head);
		const writes: PlannedWrite[] = [];

		for (const blob of tree) {
			const vaultPath = this.toVaultPath(blob.path);
			if (vaultPath) writes.push({ path: vaultPath, blobSha: blob.sha });
		}

		return { mode: "full", reason, targetCommit: head, writes, deletes: [], unchanged: 0 };
	}

	/**
	 * Apply a plan, verifying every written file.
	 *
	 * Verification recomputes each file's git blob SHA from what actually landed
	 * on disk and compares it to the SHA GitHub published. That catches truncated
	 * writes and encoding damage without a single extra network request.
	 */
	async apply(
		plan: SyncPlan,
		state: SyncState | null,
		onProgress?: (done: number, total: number) => void,
	): Promise<{ report: SyncReport; state: SyncState }> {
		const blobs: Record<string, string> = { ...(state?.blobs ?? {}) };
		const report: SyncReport = {
			mode: plan.mode,
			commit: plan.targetCommit,
			added: 0,
			updated: 0,
			deleted: 0,
			unchanged: plan.unchanged,
			skippedLocalEdits: [],
			verifiedFiles: 0,
			integrityFailures: [],
			reason: plan.reason,
		};

		const total = plan.writes.length + plan.deletes.length;
		let done = 0;

		for (const write of plan.writes) {
			const exists = await this.adapter.exists(write.path);

			// Nothing to do when the local file is already this exact blob.
			if (exists && blobs[write.path] === write.blobSha) {
				if ((await this.hashOnDisk(write.path)) === write.blobSha) {
					report.unchanged++;
					onProgress?.(++done, total);
					continue;
				}
			}

			// Refuse to clobber a file the user changed since the last sync.
			if (exists && blobs[write.path]) {
				if ((await this.hashOnDisk(write.path)) !== blobs[write.path]) {
					report.skippedLocalEdits.push(write.path);
					onProgress?.(++done, total);
					continue;
				}
			}

			const content = await this.client.readBlob(this.opts.owner, this.opts.repo, write.blobSha);

			await this.ensureParentFolder(write.path);
			await this.writeFile(write.path, content);
			if (exists) report.updated++;
			else report.added++;

			// Integrity check: re-read what we just wrote and hash it.
			const actual = await this.hashOnDisk(write.path);
			if (actual === write.blobSha) {
				blobs[write.path] = write.blobSha;
				report.verifiedFiles++;
			} else {
				report.integrityFailures.push(
					actual === null ? `${write.path} (missing after write)` : `${write.path} (sha mismatch)`,
				);
				// Don't record a SHA we couldn't confirm — next sync retries it.
				delete blobs[write.path];
			}

			onProgress?.(++done, total);
		}

		for (const path of plan.deletes) {
			if (await this.removeFile(path)) report.deleted++;
			delete blobs[path];
			onProgress?.(++done, total);
		}

		// A full sync is authoritative: anything we tracked but the tree no
		// longer lists has been removed upstream.
		if (plan.mode === "full") {
			const planned = new Set(plan.writes.map((w) => w.path));
			for (const tracked of Object.keys(blobs)) {
				if (planned.has(tracked)) continue;
				if (await this.removeFile(tracked)) report.deleted++;
				delete blobs[tracked];
			}
		}

		// Only advance the commit pointer if everything verified. Otherwise the
		// next sync would diff from a commit the vault doesn't actually match.
		const clean = report.integrityFailures.length === 0 && report.skippedLocalEdits.length === 0;
		const newState: SyncState = {
			commit: clean ? plan.targetCommit : (state?.commit ?? ""),
			blobs,
			lastSyncedAt: Date.now(),
		};

		return { report, state: newState };
	}

	/**
	 * Write through the adapter rather than `Vault.createBinary`.
	 *
	 * The Vault API is index-first: it decides a path is free by consulting its
	 * in-memory file list, which lags behind the disk right after a sync writes a
	 * batch of files, and on mobile can lag by a lot. `createBinary` on a path the
	 * index hasn't caught up to throws "File already exists" — the incremental
	 * update is then lost even though the file is plainly there. The adapter talks
	 * to the filesystem, so create and overwrite are the same call and no
	 * existence check can go stale between the check and the write.
	 */
	private async writeFile(path: string, content: ArrayBuffer) {
		await this.adapter.writeBinary(path, content);
	}

	/** Git blob SHA of what's on disk, or null if the path isn't there. */
	private async hashOnDisk(path: string): Promise<string | null> {
		if (!(await this.adapter.exists(path))) return null;
		return gitBlobSha(await this.adapter.readBinary(path));
	}

	/** Returns true if a file was actually removed. */
	private async removeFile(path: string): Promise<boolean> {
		if (!(await this.adapter.exists(path))) return false;
		// trashLocal keeps the file recoverable in .trash, matching what the
		// Vault API did before, but works from a path instead of a TFile.
		await this.adapter.trashLocal(path);
		return true;
	}

	/** A binary write fails if the parent folder doesn't exist yet. */
	private async ensureParentFolder(path: string) {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		// Walk down creating each missing ancestor: mkdir won't create
		// intermediate folders, and a repo can introduce several levels at once.
		const parts = path.slice(0, slash).split("/");
		let folder = "";
		for (const part of parts) {
			folder = folder ? `${folder}/${part}` : part;
			if (await this.adapter.exists(folder)) continue;
			try {
				await this.adapter.mkdir(folder);
			} catch {
				// Concurrent creation or already-exists; harmless.
			}
		}
	}
}
