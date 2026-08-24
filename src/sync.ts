import { DataAdapter, Vault, normalizePath } from "obsidian";
import { CompareFile, GitHubClient, TreeEntry, errorStatus } from "./github";
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
	/** Short name for this device, used in commit messages and conflict copies. */
	deviceLabel: string;
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
	/** Paths where local and remote both changed; the local copy was preserved beside it. */
	conflicts: string[];
	verifiedFiles: number;
	integrityFailures: string[];
	/** Human-readable reason a full sync was chosen over an incremental one. */
	reason: string;
}

/** What a push actually did. */
export interface PushReport {
	uploaded: string[];
	removed: string[];
	commit: string | null;
	/** Set when the branch moved underneath us and the caller should sync again. */
	raced: boolean;
	/** Set when the push was declined for safety; carries the explanation. */
	blocked: string | null;
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

/**
 * Mass-deletion guard. A push that removes most of what we synced is far more
 * likely to be a broken vault path than a deliberate cleanup, so it's refused
 * and the user is told to run a full resync if they meant it. Small vaults are
 * exempt below MIN_DELETIONS_BEFORE_GUARD, where any fraction is meaningless.
 */
const MAX_DELETION_FRACTION = 0.1;
const MIN_DELETIONS_BEFORE_GUARD = 5;

/** Local time, formatted for a filename (no colons — Windows and iOS reject them). */
function conflictStamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
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
			conflicts: [],
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

			// Local and remote both moved. Rather than drop either side, the remote
			// version takes the canonical path and the local bytes are preserved
			// beside it as a conflict copy — the next push sends that copy up, so
			// both versions exist everywhere and the user resolves it by editing.
			if (exists && blobs[write.path]) {
				const onDisk = await this.hashOnDisk(write.path);
				if (onDisk !== blobs[write.path]) {
					const copy = await this.makeConflictCopy(write.path);
					if (copy) {
						report.conflicts.push(copy);
					} else {
						// Couldn't preserve the local bytes, so don't overwrite them.
						report.skippedLocalEdits.push(write.path);
						onProgress?.(++done, total);
						continue;
					}
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
	 * Push local changes to the branch via the Git Data API.
	 *
	 * Must run *after* a clean pull: `state.commit` has to be the branch head, so
	 * every difference between the disk and `state.blobs` is genuinely a local
	 * change rather than a remote one we haven't fetched. The whole push is one
	 * commit, and the ref update is a fast-forward-only compare-and-swap, so a
	 * concurrent push from another device is detected rather than clobbered.
	 */
	async push(
		state: SyncState,
		onProgress?: (done: number, total: number) => void,
	): Promise<{ report: PushReport; state: SyncState }> {
		const { owner, repo, branch } = this.opts;
		const report: PushReport = { uploaded: [], removed: [], commit: null, raced: false, blocked: null };

		const head = await this.client.branchHead(owner, repo, branch);
		if (head !== state.commit) {
			// The branch moved since we pulled; pushing now would build a tree on
			// top of a base we haven't seen. Let the caller pull again first.
			report.raced = true;
			return { report, state };
		}

		const changes = await this.detectLocalChanges(state);
		if (changes.changed.length === 0 && changes.removed.length === 0) {
			return { report, state };
		}

		const tracked = Object.keys(state.blobs).length;
		// A vault that failed to mount, or a folder setting typo, looks exactly
		// like "the user deleted everything". Refuse rather than wipe the repo.
		if (
			tracked > 0 &&
			changes.removed.length > MIN_DELETIONS_BEFORE_GUARD &&
			changes.removed.length / tracked > MAX_DELETION_FRACTION
		) {
			report.blocked =
				`Refusing to push: ${changes.removed.length} of ${tracked} synced files are missing locally. ` +
				`Run a full resync if this is intentional.`;
			return { report, state };
		}

		const total = changes.changed.length + 1;
		let done = 0;

		const entries: TreeEntry[] = [];
		const newBlobs: Record<string, string> = { ...state.blobs };

		for (const path of changes.changed) {
			const content = await this.adapter.readBinary(path);
			const sha = await this.client.createBlob(owner, repo, content);
			entries.push({ path: this.toRepoPath(path), mode: "100644", type: "blob", sha });
			// Hash the bytes we uploaded, not the file again — the user may be
			// typing, and the state has to describe what the commit contains.
			newBlobs[path] = await gitBlobSha(content);
			report.uploaded.push(path);
			onProgress?.(++done, total);
		}

		for (const path of changes.removed) {
			entries.push({ path: this.toRepoPath(path), mode: "100644", type: "blob", sha: null });
			delete newBlobs[path];
			report.removed.push(path);
		}

		const message = this.commitMessage(report);
		const treeSha = await this.client.createTree(owner, repo, head, entries);
		const commitSha = await this.client.createCommit(owner, repo, message, treeSha, [head]);

		try {
			await this.client.updateRef(owner, repo, branch, commitSha);
		} catch (err) {
			// 422 is the fast-forward check firing: someone pushed between our
			// head read and the ref update. The commit object we made is orphaned
			// and harmless; the caller re-syncs and we try again from the new head.
			if (errorStatus(err) === 422) {
				report.raced = true;
				return { report, state };
			}
			throw err;
		}

		onProgress?.(++done, total);
		report.commit = commitSha;
		return {
			report,
			state: { commit: commitSha, blobs: newBlobs, lastSyncedAt: Date.now() },
		};
	}

	private commitMessage(report: PushReport): string {
		const parts: string[] = [];
		if (report.uploaded.length) parts.push(`${report.uploaded.length} updated`);
		if (report.removed.length) parts.push(`${report.removed.length} removed`);
		const detail = parts.join(", ");
		const only = report.uploaded.length + report.removed.length === 1;
		const subject = only
			? `Update ${(report.uploaded[0] ?? report.removed[0]) as string}`
			: `Sync ${detail}`;
		return `${subject}\n\nFrom ${this.opts.deviceLabel} via obsidian-github-sync.`;
	}

	/**
	 * Compare the disk against the last-synced blob SHAs.
	 *
	 * `changed` covers both edits and brand-new files; `removed` is a path we
	 * previously synced that is no longer on disk. An untracked file that isn't
	 * on disk simply never appears.
	 */
	private async detectLocalChanges(state: SyncState): Promise<{ changed: string[]; removed: string[] }> {
		const changed: string[] = [];
		const removed: string[] = [];

		const onDisk = await this.listLocalFiles();
		for (const path of onDisk) {
			const sha = await this.hashOnDisk(path);
			if (sha && sha !== state.blobs[path]) changed.push(path);
		}

		const present = new Set(onDisk);
		for (const path of Object.keys(state.blobs)) {
			if (!present.has(path)) removed.push(path);
		}

		return { changed, removed };
	}

	/**
	 * Every syncable file under the target folder, listed from the filesystem.
	 *
	 * The Vault index is not used here for the same reason writes don't use it:
	 * a file the user just created may not be indexed yet, and silently not
	 * pushing it is worse than a slightly slower walk.
	 */
	private async listLocalFiles(): Promise<string[]> {
		const root = this.opts.targetFolder.replace(/\/+$/, "");
		const found: string[] = [];
		const queue = [root];

		while (queue.length) {
			const dir = queue.shift() as string;
			if (dir && !(await this.adapter.exists(dir))) continue;

			const listing = await this.adapter.list(dir === "" ? "/" : dir);
			for (const folder of listing.folders) {
				if (this.isSkippedFolder(folder)) continue;
				queue.push(folder);
			}
			for (const file of listing.files) {
				const relative = root ? file.slice(root.length + 1) : file;
				if (isRefused(relative)) continue;
				found.push(file);
			}
		}

		return found;
	}

	/** Obsidian's own state and trash are never the user's notes. */
	private isSkippedFolder(folder: string): boolean {
		const name = folder.split("/").pop() ?? "";
		return name === ".obsidian" || name === ".trash" || name === ".git";
	}

	/** Inverse of toVaultPath: vault path -> path inside the repo. */
	private toRepoPath(vaultPath: string): string {
		const target = this.opts.targetFolder.replace(/\/+$/, "");
		const relative = target && vaultPath.startsWith(`${target}/`)
			? vaultPath.slice(target.length + 1)
			: vaultPath;
		const remote = this.opts.remoteFolder.replace(/\/+$/, "");
		return remote ? `${remote}/${relative}` : relative;
	}

	/**
	 * Copy the on-disk version aside before a remote version overwrites it.
	 *
	 * Naming mirrors what Obsidian Sync does: the user ends up with two files
	 * side by side in the same folder and merges them by hand. Returns the new
	 * path, or null if the copy itself failed — in which case the caller must
	 * not overwrite the original.
	 */
	private async makeConflictCopy(path: string): Promise<string | null> {
		try {
			const content = await this.adapter.readBinary(path);
			const dot = path.lastIndexOf(".");
			const slash = path.lastIndexOf("/");
			const hasExt = dot > slash;
			const stem = hasExt ? path.slice(0, dot) : path;
			const ext = hasExt ? path.slice(dot) : "";
			const target = `${stem} (conflict ${conflictStamp()} ${this.opts.deviceLabel})${ext}`;
			await this.adapter.writeBinary(target, content);
			return target;
		} catch (err) {
			console.warn("[github-sync] could not write conflict copy for", path, err);
			return null;
		}
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
