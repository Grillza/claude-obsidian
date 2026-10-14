import { FileSystemAdapter, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import { BRIDGE_SOURCE, VaultMcpServer } from "./mcp-server";
import { ApiProvider } from "./providers/api";
import { CliProvider } from "./providers/cli";
import type { ClaudeProvider } from "./providers/types";
import { ClaudeVaultSettingTab, DEFAULT_SETTINGS, randomToken, type ClaudeVaultSettings } from "./settings";
import { systemPrompt } from "./tools";
import { CHAT_VIEW_TYPE, ChatView } from "./ui/chat-view";
import { QuizSetupModal } from "./ui/quiz-modals";
import { VaultAccess } from "./vault-access";

const BRIDGE_FILE = "mcp-bridge.cjs";

export default class ClaudeVaultPlugin extends Plugin {
	declare settings: ClaudeVaultSettings;
	vault!: VaultAccess;
	private mcp: VaultMcpServer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.vault = new VaultAccess(this.app, () => this.settings);

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.addSettingTab(new ClaudeVaultSettingTab(this.app, this));

		this.addRibbonIcon("bot", "Chat with Claude", () => void this.openChat());
		this.addRibbonIcon("list-checks", "Generate a quiz with Claude", () => this.openQuizSetup());

		this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.openChat() });
		this.addCommand({ id: "generate-quiz", name: "Generate a quiz", callback: () => this.openQuizSetup() });
		this.addCommand({
			id: "summarize-note",
			name: "Summarize the open note",
			checkCallback: (checking) => {
				const file = this.vault.activeNote();
				if (!file) return false;
				if (!checking) void this.openChat().then((v) => v?.ask(`Summarize [[${file.path.replace(/\.md$/, "")}]] and list its key points.`));
				return true;
			},
		});
		this.addCommand({
			id: "copy-desktop-config",
			name: "Copy Claude Desktop config",
			callback: async () => {
				if (!this.mcpRunning()) {
					new Notice("Turn on the MCP server in settings first.");
					return;
				}
				await navigator.clipboard.writeText(this.desktopConfigSnippet());
				new Notice("Copied Claude Desktop config");
			},
		});

		this.app.workspace.onLayoutReady(() => void this.syncMcpServer());
	}

	async onunload(): Promise<void> {
		await this.mcp?.stop();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.allowedFolders = [...this.settings.allowedFolders];
		this.settings.excludedFolders = [...this.settings.excludedFolders];
		if (!this.settings.mcpToken) {
			this.settings.mcpToken = randomToken();
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		await this.syncMcpServer();
	}

	// ---- Providers ----

	getProvider(): ClaudeProvider {
		const s = this.settings;
		switch (s.connectionMode) {
			case "api": {
				const key = s.apiKeySecret ? this.app.secretStorage.getSecret(s.apiKeySecret) : null;
				if (!key) throw new Error("Add your Anthropic API key in Claude Vault Assistant settings.");
				return new ApiProvider({ apiKey: key, model: s.model, effort: s.effort, vaultName: this.app.vault.getName() }, this.vault);
			}
			case "cli":
				if (!this.mcpRunning()) throw new Error("The vault MCP server isn't running. Check the port in settings.");
				return new CliProvider({
					cliPath: s.cliPath,
					model: s.cliModel,
					vaultName: this.app.vault.getName(),
					mcpUrl: this.mcpUrl(),
					mcpToken: s.mcpToken,
				});
			case "mcp":
				throw new Error(
					"You're in Claude Desktop mode: chat with your vault from Claude Desktop. Switch to API key or Claude Code mode to chat inside Obsidian.",
				);
		}
	}

	connectionLabel(): string {
		return { api: "Anthropic API", cli: "Claude Code", mcp: "Claude Desktop" }[this.settings.connectionMode];
	}

	async testCli(): Promise<string> {
		const cli = new CliProvider({ cliPath: this.settings.cliPath, model: "", vaultName: "", mcpUrl: "", mcpToken: "" });
		try {
			return `Found ${await cli.version()}`;
		} catch (e) {
			return `Couldn't run "${this.settings.cliPath}": ${e instanceof Error ? e.message : e}`;
		}
	}

	scopeDescription(): string {
		const { allowedFolders, excludedFolders, webAccess } = this.settings;
		const allowed = allowedFolders.length ? `Can read: ${allowedFolders.join(", ")}.` : "Can read the whole vault.";
		const excluded = excludedFolders.length ? ` Never reads: ${excludedFolders.join(", ")}.` : "";
		return `${allowed}${excluded} Web search is ${webAccess ? "on" : "off"} by default.`;
	}

	async activeNoteContext(): Promise<string | undefined> {
		if (!this.settings.includeActiveNote) return undefined;
		const file = this.vault.activeNote();
		if (!file) return undefined;
		const content = await this.vault.read(file, 20_000);
		return `<open_note path="${file.path}">\n${content}\n</open_note>\n(The user currently has this note open. Use it if relevant to the question.)`;
	}

	// ---- UI ----

	async openChat(): Promise<ChatView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof ChatView ? leaf.view : null;
	}

	openQuizSetup(): void {
		if (this.settings.connectionMode === "mcp") {
			new Notice('In Claude Desktop, attach the "Quiz me on my notes" prompt from the Obsidian Vault connector, or switch connection mode to generate quizzes here.', 10000);
			return;
		}
		new QuizSetupModal(this.app, this).open();
	}

	// ---- MCP server ----

	mcpRunning(): boolean {
		return this.mcp?.running ?? false;
	}

	private mcpWanted(): boolean {
		return this.settings.mcpEnabled || this.settings.connectionMode !== "api";
	}

	mcpUrl(): string {
		return `http://127.0.0.1:${this.settings.mcpPort}/mcp`;
	}

	private serverKey = "";

	async syncMcpServer(): Promise<void> {
		const key = this.mcpWanted() ? `${this.settings.mcpPort}:${this.settings.mcpToken}` : "";
		if (key === this.serverKey) return;
		await this.mcp?.stop();
		this.mcp = null;
		this.serverKey = key;
		if (!key) return;

		const server = new VaultMcpServer(this.vault, {
			port: this.settings.mcpPort,
			token: this.settings.mcpToken,
			version: this.manifest.version,
			instructions: () => systemPrompt(this.settings.webAccess, this.app.vault.getName()),
		});
		try {
			await server.start();
			this.mcp = server;
			await this.writeBridge();
		} catch (e) {
			this.serverKey = "";
			new Notice(`Claude Vault Assistant: couldn't start MCP server on port ${this.settings.mcpPort}: ${e instanceof Error ? e.message : e}`, 10000);
		}
	}

	private bridgePath(): string {
		const adapter = this.app.vault.adapter;
		const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
		return path.join(base, this.manifest.dir ?? "", BRIDGE_FILE);
	}

	private async writeBridge(): Promise<void> {
		const rel = `${this.manifest.dir}/${BRIDGE_FILE}`;
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(rel)) || (await adapter.read(rel)) !== BRIDGE_SOURCE) {
			await adapter.write(rel, BRIDGE_SOURCE);
		}
	}

	desktopConfigSnippet(): string {
		return JSON.stringify(
			{
				mcpServers: {
					obsidian: {
						command: "node",
						args: [this.bridgePath()],
						env: { OBSIDIAN_MCP_URL: this.mcpUrl(), OBSIDIAN_MCP_TOKEN: this.settings.mcpToken },
					},
				},
			},
			null,
			2,
		);
	}

	claudeCodeAddCommand(): string {
		return `claude mcp add --transport http obsidian ${this.mcpUrl()} --header "Authorization: Bearer ${this.settings.mcpToken}"`;
	}
}
