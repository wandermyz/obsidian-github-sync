import { App, Modal, Setting } from "obsidian";
import { ResyncPlan } from "./sync";

/** How many paths to list per group before summarizing the rest. */
const MAX_LISTED = 10;

/**
 * Asks before a full resync throws away local changes. Resolves true only
 * when the user explicitly confirms; closing the modal any other way cancels.
 */
export function confirmResync(app: App, plan: ResyncPlan, source: string): Promise<boolean> {
	return new Promise((resolve) => new ResyncModal(app, plan, source, resolve).open());
}

class ResyncModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private plan: ResyncPlan,
		private source: string,
		private resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, plan } = this;
		this.titleEl.setText("Full resync");

		contentEl.createEl("p", {
			text:
				`This replaces your synced notes with the contents of ${this.source}. ` +
				"Nothing is pushed to GitHub. Local changes that haven't been pushed will be lost.",
		});

		if (plan.overwritten.length === 0 && plan.localOnly.length === 0) {
			contentEl.createEl("p", { text: "No local changes were found." });
		} else {
			this.renderGroup("Overwritten with the remote version", plan.overwritten);
			this.renderGroup("Deleted, because they aren't on GitHub", plan.localOnly);
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(
						plan.overwritten.length || plan.localOnly.length ? "Discard local changes and resync" : "Resync",
					)
					.setDestructive()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					}),
			);
	}

	private renderGroup(heading: string, paths: string[]) {
		if (paths.length === 0) return;
		this.contentEl.createEl("p", { text: `${heading} (${paths.length}):` });
		const list = this.contentEl.createEl("ul");
		for (const path of paths.slice(0, MAX_LISTED)) list.createEl("li", { text: path });
		if (paths.length > MAX_LISTED) list.createEl("li", { text: `…and ${paths.length - MAX_LISTED} more` });
	}

	onClose() {
		this.contentEl.empty();
		this.resolve(this.confirmed);
	}
}
