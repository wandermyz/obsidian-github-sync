import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { GitHubHost, hostFromWebBase } from "./auth";
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
}

const DEFAULT_SETTINGS: Settings = {
	clientId: "",
	githubWebBase: "https://github.com",
	scope: "repo read:org",
	testRepo: "",
	accessToken: "",
	login: "",
};

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
				this.settings.accessToken = token.access_token;
				await this.saveSettings();
				await this.verifyAccess();
			},
		).open();
	}

	/**
	 * End-to-end proof the flow worked: identify the token's user, then list
	 * and read a file from the configured repo.
	 */
	async verifyAccess() {
		if (!this.settings.accessToken) {
			new Notice("Not signed in.");
			return;
		}
		const client = new GitHubClient(this.host, this.settings.accessToken);
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

		const status = this.plugin.settings.accessToken
			? `Signed in${this.plugin.settings.login ? ` as ${this.plugin.settings.login}` : ""}.`
			: "Not signed in.";

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
