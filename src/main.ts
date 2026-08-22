import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { AccessTokenResponse, GitHubHost, hostFromWebBase, refreshAccessToken } from "./auth";
import { DeviceFlowModal } from "./deviceFlowModal";
import { GitHubClient } from "./github";

interface Settings {
	clientId: string;
	githubWebBase: string;
	scope: string;
	/** owner/repo the verification commands read from. */
	testRepo: string;
	accessToken: string;
	login: string;
	/** Epoch ms when accessToken expires; 0 when the app issues non-expiring tokens. */
	accessTokenExpiresAt: number;
	refreshToken: string;
	refreshTokenExpiresAt: number;
}

const DEFAULT_SETTINGS: Settings = {
	clientId: "",
	githubWebBase: "https://github.com",
	scope: "repo read:org",
	testRepo: "",
	accessToken: "",
	login: "",
	accessTokenExpiresAt: 0,
	refreshToken: "",
	refreshTokenExpiresAt: 0,
};

/** Renew this long before actual expiry, so a sync doesn't die mid-flight. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export default class GitHubSyncPlugin extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new GitHubSyncSettingTab(this.app, this));

		this.addCommand({
			id: "sign-in",
			name: "Sign in to GitHub (device flow)",
			callback: () => this.signIn(),
		});

		this.addCommand({
			id: "verify-access",
			name: "Verify GitHub access",
			callback: () => void this.verifyAccess(),
		});

		this.addCommand({
			id: "sign-out",
			name: "Sign out of GitHub",
			callback: async () => {
				this.settings.accessToken = "";
				this.settings.login = "";
				this.settings.accessTokenExpiresAt = 0;
				this.settings.refreshToken = "";
				this.settings.refreshTokenExpiresAt = 0;
				await this.saveSettings();
				new Notice("Signed out.");
			},
		});
	}

	get host(): GitHubHost {
		return hostFromWebBase(this.settings.githubWebBase);
	}

	signIn() {
		if (!this.settings.clientId) {
			new Notice("Set the OAuth app Client ID in settings first.");
			return;
		}
		new DeviceFlowModal(
			this.app,
			this.host,
			this.settings.clientId,
			this.settings.scope,
			async (token) => {
				await this.storeToken(token);
				await this.verifyAccess();
			},
		).open();
	}

	/** Persist a token response, recording expiry when the app uses expiring tokens. */
	private async storeToken(token: AccessTokenResponse) {
		const now = Date.now();
		this.settings.accessToken = token.access_token;
		this.settings.accessTokenExpiresAt = token.expires_in ? now + token.expires_in * 1000 : 0;
		// GitHub rotates the refresh token on each use; keep the newest.
		if (token.refresh_token) {
			this.settings.refreshToken = token.refresh_token;
			this.settings.refreshTokenExpiresAt = token.refresh_token_expires_in
				? now + token.refresh_token_expires_in * 1000
				: 0;
		}
		await this.saveSettings();
	}

	/**
	 * Return a usable access token, refreshing first if it is expired or close
	 * to it. Returns "" when the user must sign in again.
	 */
	async validAccessToken(): Promise<string> {
		const { accessToken, accessTokenExpiresAt, refreshToken } = this.settings;
		if (!accessToken) return "";
		// Non-expiring token, or still comfortably valid.
		if (accessTokenExpiresAt === 0) return accessToken;
		if (Date.now() < accessTokenExpiresAt - REFRESH_MARGIN_MS) return accessToken;

		if (!refreshToken) return "";
		try {
			const renewed = await refreshAccessToken(this.host, this.settings.clientId, refreshToken);
			await this.storeToken(renewed);
			return renewed.access_token;
		} catch (err) {
			console.error("[github-sync] refresh failed", err);
			return "";
		}
	}

	/**
	 * End-to-end proof the flow worked: identify the token's user, then list
	 * and read a file from the configured repo.
	 */
	async verifyAccess() {
		const token = await this.validAccessToken();
		if (!token) {
			new Notice("Not signed in — run the sign-in command.");
			return;
		}
		const client = new GitHubClient(this.host, token);
		try {
			const user = await client.currentUser();
			this.settings.login = user.login;
			await this.saveSettings();
			new Notice(`Signed in as ${user.login}`);

			const [owner, repo] = this.settings.testRepo.split("/");
			if (!owner || !repo) {
				new Notice("Set a test repo (owner/repo) to verify file reads.");
				return;
			}

			const entries = await client.listDirectory(owner, repo);
			console.log(`[github-sync] ${owner}/${repo} root:`, entries);

			const firstFile = entries.find((e) => e.type === "file");
			if (!firstFile) {
				new Notice(`Listed ${entries.length} entries; repo root has no files.`);
				return;
			}
			const content = await client.readFile(owner, repo, firstFile.path);
			console.log(`[github-sync] ${firstFile.path} (${content.length} chars):\n${content.slice(0, 500)}`);
			new Notice(
				`Read ${firstFile.path} — ${content.length} chars. ${entries.length} entries at root.`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[github-sync]", err);
			new Notice(`Verification failed: ${message}`, 10000);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GitHubSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: GitHubSyncPlugin,
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("GitHub host")
			.setDesc("https://github.com, or your GitHub Enterprise Server URL.")
			.addText((t) =>
				t
					.setPlaceholder("https://github.com")
					.setValue(this.plugin.settings.githubWebBase)
					.onChange(async (v) => {
						this.plugin.settings.githubWebBase = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("OAuth app Client ID")
			.setDesc("From the GitHub OAuth app with device flow enabled.")
			.addText((t) =>
				t
					.setPlaceholder("Iv1.xxxxxxxxxxxx")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (v) => {
						this.plugin.settings.clientId = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Scopes")
			.setDesc("Space-separated OAuth scopes.")
			.addText((t) =>
				t.setValue(this.plugin.settings.scope).onChange(async (v) => {
					this.plugin.settings.scope = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Test repository")
			.setDesc("owner/repo — used by the verify command to list and read a file.")
			.addText((t) =>
				t
					.setPlaceholder("owner/repo")
					.setValue(this.plugin.settings.testRepo)
					.onChange(async (v) => {
						this.plugin.settings.testRepo = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		const s = this.plugin.settings;
		let status: string;
		if (!s.accessToken) {
			status = "Not signed in.";
		} else {
			status = `Signed in${s.login ? ` as ${s.login}` : ""}.`;
			if (s.accessTokenExpiresAt) {
				const mins = Math.round((s.accessTokenExpiresAt - Date.now()) / 60000);
				status +=
					mins > 0
						? ` Token valid ${mins > 90 ? `${Math.round(mins / 60)}h` : `${mins}m`}` +
							(s.refreshToken ? "; auto-renews." : "; no refresh token.")
						: s.refreshToken
							? " Token expired; will auto-renew."
							: " Token expired — sign in again.";
			}
		}

		new Setting(containerEl)
			.setName("Account")
			.setDesc(status)
			.addButton((b) =>
				b
					.setButtonText(this.plugin.settings.accessToken ? "Re-authenticate" : "Sign in")
					.setCta()
					.onClick(() => this.plugin.signIn()),
			)
			.addButton((b) =>
				b.setButtonText("Verify access").onClick(async () => {
					await this.plugin.verifyAccess();
					this.display();
				}),
			);
	}
}
