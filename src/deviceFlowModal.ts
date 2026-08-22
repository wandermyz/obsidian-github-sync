import { App, Modal, Notice, Setting } from "obsidian";
import {
	AccessTokenResponse,
	DeviceCodeResponse,
	GitHubHost,
	pollForToken,
	requestDeviceCode,
} from "./auth";

/**
 * Device-flow sign-in UI.
 *
 * Deliberately has no embedded web view: the only way the user reaches GitHub
 * is `window.open`, which hands the URL to the OS browser (Safari on iOS).
 * That keeps the password/SSO/MFA exchange inside the device's own browser,
 * where any enterprise SSO session already lives.
 */
export class DeviceFlowModal extends Modal {
	private abort = new AbortController();
	private statusEl!: HTMLElement;

	constructor(
		app: App,
		private host: GitHubHost,
		private clientId: string,
		private oauthScope: string,
		private onSuccess: (token: AccessTokenResponse) => void,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Sign in to GitHub");
		this.statusEl = this.contentEl.createEl("p", { text: "Requesting a device code…" });
		void this.start();
	}

	onClose() {
		this.abort.abort();
		this.contentEl.empty();
	}

	private async start() {
		let device: DeviceCodeResponse;
		try {
			device = await requestDeviceCode(this.host, this.clientId, this.oauthScope);
		} catch (err) {
			this.fail(err);
			return;
		}
		if (this.abort.signal.aborted) return;

		this.renderCode(device);

		try {
			const token = await pollForToken(this.host, this.clientId, device, this.abort.signal);
			this.onSuccess(token);
			new Notice("Signed in to GitHub.");
			this.close();
		} catch (err) {
			if (!this.abort.signal.aborted) this.fail(err);
		}
	}

	private renderCode(device: DeviceCodeResponse) {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("p", { text: "1. Copy this code:" });
		const codeEl = contentEl.createEl("div", { text: device.user_code });
		codeEl.style.cssText =
			"font-size:2em;font-weight:700;letter-spacing:0.15em;text-align:center;margin:0.5em 0;user-select:text;";

		contentEl.createEl("p", {
			text: `2. Open ${device.verification_uri} in your browser and enter the code.`,
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Copy code").onClick(async () => {
					await navigator.clipboard.writeText(device.user_code);
					new Notice("Code copied.");
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Open browser")
					.setCta()
					.onClick(() => {
						// Opens the system browser on both desktop and iOS/Android.
						window.open(device.verification_uri, "_blank");
					}),
			);

		this.statusEl = contentEl.createEl("p", {
			text: "Waiting for you to finish in the browser…",
		});
		this.statusEl.style.opacity = "0.7";
	}

	private fail(err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		this.statusEl.setText(`Sign-in failed: ${message}`);
		this.statusEl.style.color = "var(--text-error)";
	}
}
