import { requestUrl } from "obsidian";
import type { GitHubHost } from "./auth";

export interface RepoEntry {
	path: string;
	name: string;
	type: "file" | "dir";
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
}
