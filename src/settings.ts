import {
	AbstractInputSuggest,
	App,
	Notice,
	PluginSettingTab,
	SecretComponent,
	Setting,
	TFolder,
} from "obsidian";
import type ClaudeVaultPlugin from "./main";

export type ConnectionMode = "api" | "cli" | "mcp";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeVaultSettings {
	connectionMode: ConnectionMode;
	/** Name of the entry in Obsidian's secret storage that holds the API key. */
	apiKeySecret: string;
	model: string;
	effort: Effort;
	cliPath: string;
	cliModel: string;
	/** Folders Claude may read. Empty means the whole vault. */
	allowedFolders: string[];
	/** Folders Claude may never read, even inside an allowed folder. */
	excludedFolders: string[];
	webAccess: boolean;
	includeActiveNote: boolean;
	mcpEnabled: boolean;
	mcpPort: number;
	mcpToken: string;
	quizFolder: string;
	quizQuestionCount: number;
}

export const DEFAULT_SETTINGS: ClaudeVaultSettings = {
	connectionMode: "api",
	apiKeySecret: "",
	model: "claude-opus-5-5",
	effort: "medium",
	cliPath: "claude",
	cliModel: "",
	allowedFolders: [],
	excludedFolders: [],
	webAccess: false,
	includeActiveNote: true,
	mcpEnabled: false,
	mcpPort: 27125,
	mcpToken: "",
	quizFolder: "Quizzes",
	quizQuestionCount: 10,
};

export const MODEL_OPTIONS: Record<string, string> = {
	"claude-opus-5-5": "Claude Opus 5.5",
	"claude-sonnet-5-5": "Claude Sonnet 5.5",
	"claude-haiku-5-5": "Claude Haiku 5.5",
	"claude-fable-5-1": "Claude Fable 5.1",
};

export function randomToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.filter((f) => f.path.toLowerCase().includes(q))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}

export class ClaudeVaultSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ClaudeVaultPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		// ---- Connection ----
		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("Connect via")
			.setDesc(
				"API key: pay-as-you-go Anthropic API. Claude Code: uses the Claude account you are signed into in the Claude Code CLI. Claude Desktop only: no chat inside Obsidian; Claude Desktop reads your vault through the MCP server below.",
			)
			.addDropdown((d) =>
				d
					.addOptions({
						api: "Anthropic API key",
						cli: "Claude Code (signed-in account)",
						mcp: "Claude Desktop only (MCP)",
					})
					.setValue(s.connectionMode)
					.onChange(async (v) => {
						s.connectionMode = v as ConnectionMode;
						if (v === "mcp") s.mcpEnabled = true;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (s.connectionMode === "api") {
			new Setting(containerEl)
				.setName("API key")
				.setDesc(
					"Pick or create a secret in Obsidian's secret storage holding your key from platform.claude.com. The key is not written to the plugin's data.json.",
				)
				.addComponent((el) =>
					new SecretComponent(this.app, el)
						.setValue(s.apiKeySecret)
						.onChange(async (v) => {
							s.apiKeySecret = v ?? "";
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Model")
				.addDropdown((d) =>
					d
						.addOptions(MODEL_OPTIONS)
						.setValue(s.model in MODEL_OPTIONS ? s.model : "claude-opus-5-5")
						.onChange(async (v) => {
							s.model = v;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Effort")
				.setDesc("How hard Claude thinks. Higher is slower and costs more.")
				.addDropdown((d) =>
					d
						.addOptions({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" })
						.setValue(s.effort)
						.onChange(async (v) => {
							s.effort = v as Effort;
							await this.plugin.saveSettings();
						}),
				);
		}

		if (s.connectionMode === "cli") {
			new Setting(containerEl)
				.setName("Claude Code executable")
				.setDesc(
					"Path to the `claude` command. Run `claude` once in a terminal and sign in first. Use an absolute path if Obsidian can't find it.",
				)
				.addText((t) =>
					t
						.setPlaceholder("claude")
						.setValue(s.cliPath)
						.onChange(async (v) => {
							s.cliPath = v.trim() || "claude";
							await this.plugin.saveSettings();
						}),
				)
				.addButton((b) =>
					b.setButtonText("Test").onClick(async () => {
						const res = await this.plugin.testCli();
						new Notice(res);
					}),
				);

			new Setting(containerEl)
				.setName("Model")
				.setDesc("Leave empty to use Claude Code's default. Accepts aliases like `opus` or `sonnet`.")
				.addText((t) =>
					t.setValue(s.cliModel).onChange(async (v) => {
						s.cliModel = v.trim();
						await this.plugin.saveSettings();
					}),
				);
		}

		// ---- Vault access ----
		new Setting(containerEl).setName("Vault access").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Claude can only list, search and read notes inside the allowed folders. With no allowed folders, the whole vault is visible except the excluded folders. These rules apply in every connection mode, including Claude Desktop.",
		});

		this.folderList(containerEl, "Allowed folders", s.allowedFolders, "Whole vault is allowed.");
		this.folderList(containerEl, "Excluded folders", s.excludedFolders, "Nothing excluded.");

		new Setting(containerEl)
			.setName("Include the open note")
			.setDesc("Send the note you have open as context with each chat message (only if it is in an allowed folder).")
			.addToggle((t) =>
				t.setValue(s.includeActiveNote).onChange(async (v) => {
					s.includeActiveNote = v;
					await this.plugin.saveSettings();
				}),
			);

		// ---- Internet ----
		new Setting(containerEl).setName("Internet").setHeading();
		new Setting(containerEl)
			.setName("Allow web search")
			.setDesc(
				"On: Claude may search the web to add information beyond your notes, and will mark what came from the web. Off: Claude answers only from your vault. You can still flip this per chat in the chat panel. In Claude Desktop mode this is passed as an instruction; Claude Desktop's own web search setting still applies.",
			)
			.addToggle((t) =>
				t.setValue(s.webAccess).onChange(async (v) => {
					s.webAccess = v;
					await this.plugin.saveSettings();
				}),
			);

		// ---- MCP ----
		new Setting(containerEl).setName("Claude Desktop / MCP server").setHeading();
		new Setting(containerEl)
			.setName("Run MCP server")
			.setDesc(
				"Lets Claude Desktop (or Claude Code) read your vault through a local server on 127.0.0.1, guarded by a token and the folder rules above. Required in Claude Code mode.",
			)
			.addToggle((t) =>
				t
					.setValue(s.mcpEnabled || s.connectionMode !== "api")
					.setDisabled(s.connectionMode !== "api")
					.onChange(async (v) => {
						s.mcpEnabled = v;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl).setName("Port").addText((t) =>
			t.setValue(String(s.mcpPort)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isInteger(n) && n > 1024 && n < 65536) {
					s.mcpPort = n;
					await this.plugin.saveSettings();
				}
			}),
		);

		new Setting(containerEl)
			.setName("Access token")
			.setDesc("Clients must send this token. Regenerating it disconnects existing clients until you update their config.")
			.addButton((b) =>
				b.setButtonText("Regenerate").onClick(async () => {
					s.mcpToken = randomToken();
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.mcpRunning()) {
			const pre = containerEl.createDiv({ cls: "cva-config" });
			pre.createEl("p", {
				text: "Add this to claude_desktop_config.json (Claude Desktop → Settings → Developer → Edit Config), then restart Claude Desktop. Requires Node.js 18+.",
			});
			const code = pre.createEl("pre").createEl("code");
			code.setText(this.plugin.desktopConfigSnippet());
			new Setting(pre).addButton((b) =>
				b.setButtonText("Copy").onClick(async () => {
					await navigator.clipboard.writeText(this.plugin.desktopConfigSnippet());
					new Notice("Copied Claude Desktop config");
				}),
			);
			pre.createEl("p", { text: "For Claude Code in a terminal:" });
			pre.createEl("pre").createEl("code").setText(this.plugin.claudeCodeAddCommand());
		}

		// ---- Quizzes ----
		new Setting(containerEl).setName("Quizzes").setHeading();
		new Setting(containerEl)
			.setName("Save quizzes to")
			.setDesc("Folder for quizzes you save as notes.")
			.addText((t) => {
				new FolderSuggest(this.app, t.inputEl);
				t.setValue(s.quizFolder).onChange(async (v) => {
					s.quizFolder = v.trim() || "Quizzes";
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl).setName("Default number of questions").addSlider((sl) =>
			sl
				.setLimits(3, 30, 1)
				.setValue(s.quizQuestionCount)
				.setDynamicTooltip()
				.onChange(async (v) => {
					s.quizQuestionCount = v;
					await this.plugin.saveSettings();
				}),
		);
	}

	private folderList(containerEl: HTMLElement, name: string, list: string[], emptyText: string): void {
		const setting = new Setting(containerEl).setName(name);
		let pending = "";
		setting.addText((t) => {
			new FolderSuggest(this.app, t.inputEl);
			t.setPlaceholder("Folder path").onChange((v) => (pending = v));
		});
		setting.addButton((b) =>
			b.setButtonText("Add").onClick(async () => {
				const path = normalizeFolder(pending);
				if (!path) return;
				if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) {
					new Notice(`No folder named "${path}"`);
					return;
				}
				if (!list.includes(path)) list.push(path);
				await this.plugin.saveSettings();
				this.display();
			}),
		);

		const listEl = containerEl.createDiv({ cls: "cva-folder-list" });
		if (list.length === 0) {
			listEl.createSpan({ cls: "cva-muted", text: emptyText });
		}
		for (const folder of [...list]) {
			const chip = listEl.createDiv({ cls: "cva-chip" });
			chip.createSpan({ text: folder });
			const x = chip.createEl("button", { text: "×", attr: { "aria-label": `Remove ${folder}` } });
			x.onclick = async () => {
				list.remove(folder);
				await this.plugin.saveSettings();
				this.display();
			};
		}
	}
}

export function normalizeFolder(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
