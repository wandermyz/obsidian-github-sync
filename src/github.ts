import { requestUrl } from "obsidian";
import type { GitHubHost } from "./auth";
import { base64ToBytes } from "./gitHash";

export interface RepoEntry {
	path: string;
	name: string;
	type: "file" | "dir";
	sha: string;
	size: number;
}

/** One changed path between two commits. */
export interface CompareFile {
	filename: string;
	/** git status; "renamed" also carries previous_filename. */
	status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
	sha: string;
	previous_filename?: string;
}

export interface CompareResult {
	/** "ahead" | "behind" | "identical" | "diverged" */
	status: string;
	files: CompareFile[];
	/** GitHub caps the compare payload at 300 files. */
	truncated: boolean;
	total_commits: number;
}

/** A blob entry from the recursive tree listing. */
export interface TreeBlob {
	path: string;
	sha: string;
	size: number;
}

export class GitHubClient {
	constructor(
		private host: GitHubHost,
		private token: string,
	) {}

	private async api(path: string): Promise<any> {
		const res = await requestUrl({
			url: `${this.host.apiBase}${path}`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			throw: false,
		});
		if (res.status >= 400) {
			const message = res.json?.message ?? res.text ?? "";
			throw new Error(`GitHub API ${res.status} on ${path}: ${message}`);
		}
		return res.json;
	}

	/** The authenticated user's login — the cheapest proof the token works. */
	async currentUser(): Promise<{ login: string; name: string | null }> {
		return this.api("/user");
	}

	async listDirectory(owner: string, repo: string, dirPath = ""): Promise<RepoEntry[]> {
		const suffix = dirPath ? `/${encodeURI(dirPath.replace(/^\/+/, ""))}` : "";
		const json = await this.api(`/repos/${owner}/${repo}/contents${suffix}`);
		if (!Array.isArray(json)) throw new Error(`${dirPath || "/"} is a file, not a directory.`);
		return json as RepoEntry[];
	}

	/** Read a text file's contents. Uses the raw media type, so no base64 decode. */
	async readFile(owner: string, repo: string, filePath: string): Promise<string> {
		const res = await requestUrl({
			url: `${this.host.apiBase}/repos/${owner}/${repo}/contents/${encodeURI(filePath.replace(/^\/+/, ""))}`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github.raw+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			throw: false,
		});
		if (res.status >= 400) throw new Error(`GitHub API ${res.status} reading ${filePath}`);
		return res.text;
	}

	/** Resolve a branch name to its current head commit SHA. */
	async branchHead(owner: string, repo: string, branch: string): Promise<string> {
		const json = await this.api(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
		return json.commit.sha;
	}

	/** The repo's default branch, used when the user hasn't picked one. */
	async defaultBranch(owner: string, repo: string): Promise<string> {
		const json = await this.api(`/repos/${owner}/${repo}`);
		return json.default_branch;
	}

	/**
	 * Every blob in a commit, one request. This is the full-sync path and the
	 * fallback when a diff is unusable.
	 */
	async listTree(owner: string, repo: string, commitSha: string): Promise<TreeBlob[]> {
		const json = await this.api(
			`/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
		);
		if (json.truncated) {
			throw new Error(
				"Repository tree exceeds GitHub's listing limit — too large to sync as a single tree.",
			);
		}
		return (json.tree as any[])
			.filter((e) => e.type === "blob")
			.map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
	}

	/**
	 * Changed paths between two commits — the heart of incremental sync.
	 *
	 * One request replaces walking the whole tree, so a sync that changed three
	 * notes costs three downloads instead of re-listing thousands of files.
	 */
	async compare(
		owner: string,
		repo: string,
		base: string,
		head: string,
	): Promise<CompareResult> {
		const json = await this.api(
			`/repos/${owner}/${repo}/compare/${base}...${head}?per_page=300`,
		);
		const files = (json.files ?? []) as CompareFile[];
		return {
			status: json.status,
			files,
			// GitHub silently caps the file list at 300; beyond that the diff lies
			// by omission, so callers must fall back to a full tree comparison.
			truncated: files.length >= 300,
			total_commits: json.total_commits ?? 0,
		};
	}

	/**
	 * Fetch a blob by SHA rather than by path.
	 *
	 * Path-based reads resolve against a branch tip, which can move mid-sync and
	 * silently hand back content from a different commit than the diff described.
	 * Addressing the blob directly pins the bytes to the commit we planned
	 * against. Returns base64 for binary safety.
	 */
	async readBlob(owner: string, repo: string, blobSha: string): Promise<ArrayBuffer> {
		const json = await this.api(`/repos/${owner}/${repo}/git/blobs/${blobSha}`);
		if (json.encoding !== "base64") {
			throw new Error(`Unexpected blob encoding "${json.encoding}" for ${blobSha}`);
		}
		return base64ToBytes(json.content);
	}
}
