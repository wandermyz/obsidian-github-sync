import { requestUrl } from "obsidian";
import type { GitHubHost } from "./auth";
import { base64ToBytes, bytesToBase64 } from "./gitHash";

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
	/** Absent for entries GitHub won't attribute to a blob, e.g. submodules. */
	sha?: string | null;
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

/** An Error carrying the HTTP status, so callers can branch on 409/422. */
export interface GitHubError extends Error {
	status?: number;
}

export function errorStatus(err: unknown): number | undefined {
	return err instanceof Error ? (err as GitHubError).status : undefined;
}

/**
 * One entry in a tree we're about to create. `sha: null` deletes the path;
 * `content` uploads inline text without a separate blob request.
 */
export interface TreeEntry {
	path: string;
	mode: "100644";
	type: "blob";
	sha?: string | null;
	content?: string;
}

export class GitHubClient {
	constructor(
		private host: GitHubHost,
		private token: string,
	) {}

	private async api(path: string): Promise<any> {
		return this.request("GET", path);
	}

	private async request(
		method: "GET" | "POST" | "PATCH",
		path: string,
		body?: unknown,
	): Promise<any> {
		const res = await requestUrl({
			url: `${this.host.apiBase}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});
		if (res.status >= 400) {
			const message = res.json?.message ?? res.text ?? "";
			const err = new Error(`GitHub API ${res.status} on ${path}: ${message}`);
			(err as GitHubError).status = res.status;
			throw err;
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
		if (!/^[0-9a-f]{40}$/.test(blobSha ?? "")) {
			throw new Error(`Refusing to fetch a blob with a malformed SHA: ${JSON.stringify(blobSha)}`);
		}
		const json = await this.api(`/repos/${owner}/${repo}/git/blobs/${blobSha}`);
		if (json.encoding !== "base64") {
			throw new Error(`Unexpected blob encoding "${json.encoding}" for ${blobSha}`);
		}
		return base64ToBytes(json.content);
	}

	/**
	 * Upload raw bytes as a blob and return its SHA.
	 *
	 * Everything goes up base64-encoded rather than as inline UTF-8 text: a vault
	 * holds images and PDFs alongside notes, and even a note can contain bytes
	 * that don't survive a JSON round-trip intact.
	 */
	async createBlob(owner: string, repo: string, content: ArrayBuffer): Promise<string> {
		const json = await this.request("POST", `/repos/${owner}/${repo}/git/blobs`, {
			content: bytesToBase64(content),
			encoding: "base64",
		});
		return json.sha as string;
	}

	/**
	 * Create a tree layered on top of `baseTree`, so only changed paths need
	 * listing. Entries with `sha: null` remove a path.
	 */
	async createTree(
		owner: string,
		repo: string,
		baseTree: string,
		entries: TreeEntry[],
	): Promise<string> {
		const json = await this.request("POST", `/repos/${owner}/${repo}/git/trees`, {
			base_tree: baseTree,
			tree: entries,
		});
		return json.sha as string;
	}

	async createCommit(
		owner: string,
		repo: string,
		message: string,
		treeSha: string,
		parents: string[],
	): Promise<string> {
		const json = await this.request("POST", `/repos/${owner}/${repo}/git/commits`, {
			message,
			tree: treeSha,
			parents,
		});
		return json.sha as string;
	}

	/**
	 * Move a branch to `commitSha`, refusing anything but a fast-forward.
	 *
	 * `force: false` is the whole concurrency story: if someone else pushed since
	 * we read the head, GitHub rejects with 422 and we re-plan against the new
	 * head instead of clobbering their commit.
	 */
	async updateRef(owner: string, repo: string, branch: string, commitSha: string) {
		await this.request("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
			sha: commitSha,
			force: false,
		});
	}
}
