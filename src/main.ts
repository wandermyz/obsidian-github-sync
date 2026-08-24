import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { AccessTokenResponse, GitHubHost, hostFromWebBase, refreshAccessToken } from "./auth";
import { DeviceFlowModal } from "./deviceFlowModal";
import { GitHubClient } from "./github";
import { SyncEngine, SyncReport } from "./sync";
import { DEFAULT_LOCAL, LOCAL_FILE, LocalState, loadLocalState, saveLocalState } from "./storage";

/**
 * Synced settings. Deliberately holds no credentials and no per-device state —
 * see storage.ts. This is what `data.json` contains, and it is safe to commit.
 */
interface Settings {
	clientId: string;
	githubWebBase: string;
	scope: string;

	/** owner/repo to sync notes from. */
	syncRepo: string;
	branch: string;
	/** Repo subfolder to sync from; "" is the repo root. */
	remoteFolder: string;
	/** Vault subfolder to sync into; "" is the vault root. */
	targetFolder: string;

	syncOnStartup: boolean;
	autoSyncEnabled: boolean;
	autoSyncMinutes: number;
}

const DEFAULT_SETTINGS: Settings = {
	clientId: "",
	githubWebBase: "https://github.com",
	scope: "repo read:org",
	syncRepo: "",
	branch: "",
	remoteFolder: "",
	targetFolder: "",
	syncOnStartup: false,
	autoSyncEnabled: false,
	autoSyncMinutes: 15,
};

/** Renew this long before actual expiry, so a sync doesn't die mid-flight. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Wait this long after startup before auto-syncing, so launch stays responsive. */
const STARTUP_SYNC_DELAY_MS = 3000;

export default class GitHubSyncPlugin extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	/** Credentials and per-device sync state; never written to data.json. */
	local: LocalState = { ...DEFAULT_LOCAL };
	/** Guards against overlapping runs (auto timer firing during a manual sync). */
	private syncing = false;
	private autoSyncTimer: number | null = null;
	statusBar: HTMLElement | null = null;
	/**
	 * The settings tab, so state changes driven from outside it (finishing the
	 * device flow, a sync completing) can redraw it instead of leaving stale
	 * text until the user navigates away and back.
	 */
	settingTab: GitHubSyncSettingTab | null = null;

	/** Redraw the settings tab if it is currently on screen. */
	refreshSettingsTab() {
		this.settingTab?.refresh();
	}

	async onload() {
		await this.loadSettings();
		this.settingTab = new GitHubSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.statusBar = this.addStatusBarItem();
		this.renderStatusBar();

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
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.sync("manual"),
		});

		this.addCommand({
			id: "full-resync",
			name: "Full resync (rebuild from scratch)",
			callback: () => void this.sync("manual", true),
		});

		this.addCommand({
			id: "sign-out",
			name: "Sign out of GitHub",
			callback: async () => {
				// Keep syncState: the vault still holds those files, so a later
				// sign-in should resume incrementally rather than refetch everything.
				this.local = { ...DEFAULT_LOCAL, syncState: this.local.syncState };
				await this.saveLocal();
				this.refreshSettingsTab();
				new Notice("Signed out.");
			},
		});

		// Defer startup sync until the workspace is ready: syncing while Obsidian
		// is still indexing fights the file watcher and slows down launch.
		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				window.setTimeout(() => void this.sync("startup"), STARTUP_SYNC_DELAY_MS);
			});
		}
		this.restartAutoSyncTimer();
	}

	onunload() {
		this.clearAutoSyncTimer();
	}

	private clearAutoSyncTimer() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
	}

	/** (Re)arm the periodic sync from current settings. Safe to call repeatedly. */
	restartAutoSyncTimer() {
		this.clearAutoSyncTimer();
		if (!this.settings.autoSyncEnabled) return;

		const minutes = Math.max(1, this.settings.autoSyncMinutes);
		this.autoSyncTimer = window.setInterval(
			() => void this.sync("auto"),
			minutes * 60 * 1000,
		);
		// registerInterval ties the timer to the plugin lifecycle, so disabling
		// the plugin doesn't leave it firing.
		this.registerInterval(this.autoSyncTimer);
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
				// Redraw before verifying: verification hits the network, and the
				// button should already read "Re-authenticate" by then.
				this.refreshSettingsTab();
				await this.verifyAccess();
			},
		).open();
	}

	/** Persist a token response, recording expiry when the app uses expiring tokens. */
	private async storeToken(token: AccessTokenResponse) {
		const now = Date.now();
		this.local.accessToken = token.access_token;
		this.local.accessTokenExpiresAt = token.expires_in ? now + token.expires_in * 1000 : 0;
		// GitHub rotates the refresh token on each use; keep the newest.
		if (token.refresh_token) {
			this.local.refreshToken = token.refresh_token;
			this.local.refreshTokenExpiresAt = token.refresh_token_expires_in
				? now + token.refresh_token_expires_in * 1000
				: 0;
		}
		await this.saveLocal();
	}

	/**
	 * Return a usable access token, refreshing first if it is expired or close
	 * to it. Returns "" when the user must sign in again.
	 */
	async validAccessToken(): Promise<string> {
		const { accessToken, accessTokenExpiresAt, refreshToken } = this.local;
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
	 * and read a file from the sync repo.
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
			this.local.login = user.login;
			await this.saveLocal();
			this.refreshSettingsTab();
			new Notice(`Signed in as ${user.login}`);

			const [owner, repo] = this.settings.syncRepo.split("/");
			if (!owner || !repo) {
				new Notice("Set the sync repository (owner/repo) to verify file reads.");
				return;
			}

			const dir = this.settings.remoteFolder.trim();
			const entries = await client.listDirectory(owner, repo, dir);
			console.log(`[github-sync] ${owner}/${repo}/${dir} :`, entries);

			const firstFile = entries.find((e) => e.type === "file");
			if (!firstFile) {
				new Notice(`Listed ${entries.length} entries; no files at ${dir || "the repo root"}.`);
				return;
			}
			const content = await client.readFile(owner, repo, firstFile.path);
			console.log(`[github-sync] ${firstFile.path} (${content.length} chars):\n${content.slice(0, 500)}`);
			new Notice(
				`Read ${firstFile.path} — ${content.length} chars. ${entries.length} entries at ${dir || "root"}.`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[github-sync]", err);
			new Notice(`Verification failed: ${message}`, 10000);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.local = await loadLocalState(this);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async saveLocal() {
		await saveLocalState(this, this.local);
	}

	/**
	 * Pull changes from GitHub into the vault.
	 *
	 * `trigger` only affects how loudly it reports: a background run shouldn't
	 * pop a notice every 15 minutes just to say nothing changed.
	 */
	async sync(trigger: "manual" | "auto" | "startup", forceFull = false): Promise<void> {
		const loud = trigger === "manual";

		if (this.syncing) {
			if (loud) new Notice("A sync is already running.");
			return;
		}

		const [owner, repo] = this.settings.syncRepo.split("/");
		if (!owner || !repo) {
			if (loud) new Notice("Set the sync repository (owner/repo) in settings.");
			return;
		}

		const token = await this.validAccessToken();
		if (!token) {
			// Always loud: silence here looks identical to "nothing changed",
			// and the user needs to know auto-sync has stopped working.
			new Notice("GitHub Sync: not signed in — sync skipped.");
			return;
		}

		this.syncing = true;
		this.renderStatusBar("Syncing…");

		try {
			const client = new GitHubClient(this.host, token);
			const branch =
				this.settings.branch.trim() || (await client.defaultBranch(owner, repo));

			const engine = new SyncEngine(this.app.vault, client, {
				owner,
				repo,
				branch,
				targetFolder: this.settings.targetFolder.trim(),
				remoteFolder: this.settings.remoteFolder.trim(),
			});

			const state = forceFull ? null : this.local.syncState;
			const plan = await engine.plan(state);

			if (plan.writes.length === 0 && plan.deletes.length === 0) {
				if (loud) new Notice("Already up to date.");
				this.local.syncState = {
					commit: plan.targetCommit,
					blobs: state?.blobs ?? {},
					lastSyncedAt: Date.now(),
				};
				await this.saveLocal();
				this.renderStatusBar();
				return;
			}

			const { report, state: newState } = await engine.apply(plan, state, (done, total) => {
				this.renderStatusBar(`Syncing ${done}/${total}…`);
			});

			this.local.syncState = newState;
			await this.saveLocal();
			this.reportSync(report, loud);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[github-sync] sync failed", err);
			// Failures are always surfaced — a silently broken sync is worse
			// than a noisy one.
			new Notice(`GitHub Sync failed: ${message}`, 10000);
		} finally {
			this.syncing = false;
			this.renderStatusBar();
		}
	}

	private reportSync(report: SyncReport, loud: boolean) {
		console.log("[github-sync] sync report", report);

		const parts: string[] = [];
		if (report.added) parts.push(`${report.added} added`);
		if (report.updated) parts.push(`${report.updated} updated`);
		if (report.deleted) parts.push(`${report.deleted} deleted`);
		const summary = parts.length ? parts.join(", ") : "no changes";

		// Problems are always announced, however the sync was triggered.
		if (report.integrityFailures.length) {
			new Notice(
				`GitHub Sync: ${report.integrityFailures.length} file(s) failed verification and will retry next sync:\n` +
					report.integrityFailures.slice(0, 5).join("\n"),
				15000,
			);
		}
		if (report.skippedLocalEdits.length) {
			new Notice(
				`GitHub Sync: skipped ${report.skippedLocalEdits.length} locally-edited file(s) to avoid overwriting your changes:\n` +
					report.skippedLocalEdits.slice(0, 5).join("\n"),
				15000,
			);
		}

		if (loud || report.added || report.updated || report.deleted) {
			new Notice(`GitHub Sync (${report.mode}): ${summary}.`);
		}
	}

	renderStatusBar(override?: string) {
		if (!this.statusBar) return;
		if (override) {
			this.statusBar.setText(`⟳ ${override}`);
			return;
		}
		const state = this.local.syncState;
		if (!state?.lastSyncedAt) {
			this.statusBar.setText("");
			return;
		}
		const mins = Math.round((Date.now() - state.lastSyncedAt) / 60000);
		const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
		this.statusBar.setText(`⟳ ${ago}`);
	}
}

class GitHubSyncSettingTab extends PluginSettingTab {
	/** Only true while the tab is on screen; redrawing a hidden tab is wasted work. */
	private open = false;

	constructor(
		app: App,
		private plugin: GitHubSyncPlugin,
	) {
		super(app, plugin);
	}

	hide() {
		this.open = false;
		super.hide();
	}

	/** Redraw only if the user is actually looking at this tab. */
	refresh() {
		if (this.open) this.display();
	}

	display() {
		this.open = true;
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

		const s = this.plugin.settings;
		const l = this.plugin.local;
		let status: string;
		if (!l.accessToken) {
			status = "Not signed in.";
		} else {
			status = `Signed in${l.login ? ` as ${l.login}` : ""}.`;
			if (l.accessTokenExpiresAt) {
				const mins = Math.round((l.accessTokenExpiresAt - Date.now()) / 60000);
				status +=
					mins > 0
						? ` Token valid ${mins > 90 ? `${Math.round(mins / 60)}h` : `${mins}m`}` +
							(l.refreshToken ? "; auto-renews." : "; no refresh token.")
						: l.refreshToken
							? " Token expired; will auto-renew."
							: " Token expired — sign in again.";
			}
		}

		new Setting(containerEl)
			.setName("Account")
			.setDesc(`${status} Stored in ${LOCAL_FILE}, separate from your synced settings.`)
			.addButton((b) =>
				b
					.setButtonText(l.accessToken ? "Re-authenticate" : "Sign in")
					.setCta()
					.onClick(() => this.plugin.signIn()),
			);

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Repository")
			.setDesc("owner/repo to sync notes from.")
			.addText((t) =>
				t
					.setPlaceholder("owner/repo")
					.setValue(s.syncRepo)
					.onChange(async (v) => {
						this.plugin.settings.syncRepo = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("Leave empty to use the repository's default branch.")
			.addText((t) =>
				t
					.setPlaceholder("main")
					.setValue(s.branch)
					.onChange(async (v) => {
						this.plugin.settings.branch = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Remote folder")
			.setDesc("Only sync this subfolder of the repo. Empty = the whole repo.")
			.addText((t) =>
				t
					.setPlaceholder("notes")
					.setValue(s.remoteFolder)
					.onChange(async (v) => {
						this.plugin.settings.remoteFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vault folder")
			.setDesc("Where the remote files land in this vault. Empty = the vault root.")
			.addText((t) =>
				t
					.setPlaceholder("GitHub")
					.setValue(s.targetFolder)
					.onChange(async (v) => {
						this.plugin.settings.targetFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		const lastSync = l.syncState?.lastSyncedAt
			? `Last synced ${new Date(l.syncState.lastSyncedAt).toLocaleString()} at ${l.syncState.commit.slice(0, 7)}.`
			: "Never synced.";

		new Setting(containerEl)
			.setName("Manual sync")
			.setDesc(lastSync)
			.addButton((b) =>
				b
					.setButtonText("Sync now")
					.setCta()
					.onClick(async () => {
						await this.plugin.sync("manual");
						this.refresh();
					}),
			)
			.addButton((b) =>
				b.setButtonText("Full resync").onClick(async () => {
					await this.plugin.sync("manual", true);
					this.refresh();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Verify access").onClick(async () => {
					await this.plugin.verifyAccess();
					this.refresh();
				}),
			);

		new Setting(containerEl).setName("Automatic sync").setHeading();

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Pull changes shortly after Obsidian finishes loading.")
			.addToggle((t) =>
				t.setValue(s.syncOnStartup).onChange(async (v) => {
					this.plugin.settings.syncOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Periodic sync")
			.setDesc("Pull changes on a timer while Obsidian is open.")
			.addToggle((t) =>
				t.setValue(s.autoSyncEnabled).onChange(async (v) => {
					this.plugin.settings.autoSyncEnabled = v;
					await this.plugin.saveSettings();
					this.plugin.restartAutoSyncTimer();
					this.refresh();
				}),
			);

		if (s.autoSyncEnabled) {
			new Setting(containerEl)
				.setName("Sync interval")
				.setDesc("Minutes between automatic syncs.")
				.addText((t) =>
					t
						.setPlaceholder("15")
						.setValue(String(s.autoSyncMinutes))
						.onChange(async (v) => {
							const n = Number(v);
							if (!Number.isFinite(n) || n < 1) return;
							this.plugin.settings.autoSyncMinutes = Math.round(n);
							await this.plugin.saveSettings();
							this.plugin.restartAutoSyncTimer();
						}),
				);
		}
	}
}
