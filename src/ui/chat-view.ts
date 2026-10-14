import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeVaultPlugin from "../main";
import type { ChatSession } from "../providers/types";

export const CHAT_VIEW_TYPE = "claude-vault-chat";

export class ChatView extends ItemView {
	private session: ChatSession | null = null;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private webToggle!: HTMLInputElement;
	private abort: AbortController | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ClaudeVaultPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Claude";
	}
	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("cva-chat");

		const header = root.createDiv({ cls: "cva-chat-header" });
		const webLabel = header.createEl("label", { cls: "cva-web-toggle" });
		this.webToggle = webLabel.createEl("input", { type: "checkbox" });
		this.webToggle.checked = this.plugin.settings.webAccess;
		webLabel.createSpan({ text: "Web search" });
		webLabel.setAttr("title", "Off: answers come only from your vault. On: Claude may add information from the web.");

		const actions = header.createDiv({ cls: "cva-header-actions" });
		this.iconButton(actions, "list-checks", "Generate a quiz", () => this.plugin.openQuizSetup());
		this.iconButton(actions, "rotate-ccw", "New chat", () => this.reset());

		this.messagesEl = root.createDiv({ cls: "cva-messages" });
		this.renderEmptyState();

		const composer = root.createDiv({ cls: "cva-composer" });
		this.inputEl = composer.createEl("textarea", {
			attr: { placeholder: "Ask about your notes…  (Enter to send, Shift+Enter for a new line)", rows: "3" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		});
		this.sendBtn = composer.createEl("button", { cls: "mod-cta", text: "Send" });
		this.sendBtn.onclick = () => (this.abort ? this.abort.abort() : void this.submit());
	}

	async onClose(): Promise<void> {
		this.abort?.abort();
	}

	reset(): void {
		this.abort?.abort();
		this.session = null;
		this.messagesEl.empty();
		this.renderEmptyState();
	}

	/** Ask a question programmatically (used by commands). */
	async ask(text: string): Promise<void> {
		this.inputEl.value = text;
		await this.submit();
	}

	private renderEmptyState(): void {
		const empty = this.messagesEl.createDiv({ cls: "cva-empty" });
		empty.createEl("p", { text: `Ask Claude about your vault. Connected via ${this.plugin.connectionLabel()}.` });
		const scope = this.plugin.scopeDescription();
		empty.createEl("p", { cls: "cva-muted", text: scope });
		for (const example of [
			"Summarize what I've written about this topic",
			"What are the open questions in my notes on…",
			"Quiz me on the note I have open",
		]) {
			const b = empty.createEl("button", { cls: "cva-suggestion", text: example });
			b.onclick = () => {
				this.inputEl.value = example;
				this.inputEl.focus();
			};
		}
	}

	private async submit(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text || this.abort) return;

		let provider;
		try {
			provider = this.plugin.getProvider();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
			return;
		}
		if (!this.session) {
			this.session = provider.newChat();
			this.messagesEl.empty();
		}

		this.inputEl.value = "";
		this.addMessage("user", text);
		const bubble = this.addMessage("assistant", "");
		const statusEl = bubble.createDiv({ cls: "cva-status" });
		const bodyEl = bubble.createDiv({ cls: "cva-body" });

		this.abort = new AbortController();
		this.setBusy(true);
		let answer = "";
		let pendingRender = false;
		const render = () => {
			if (pendingRender) return;
			pendingRender = true;
			window.requestAnimationFrame(async () => {
				pendingRender = false;
				bodyEl.empty();
				await MarkdownRenderer.render(this.app, answer, bodyEl, "", this);
				this.scrollToEnd();
			});
		};

		try {
			const context = await this.plugin.activeNoteContext();
			await this.session.send(
				text,
				{ webAccess: this.webToggle.checked, context, signal: this.abort.signal },
				{
					onText: (d) => {
						answer += d;
						render();
					},
					onStatus: (s) => {
						statusEl.setText(s);
						statusEl.toggleClass("is-hidden", !s);
					},
				},
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			bubble.createDiv({ cls: "cva-error", text: msg });
		} finally {
			statusEl.addClass("is-hidden");
			this.abort = null;
			this.setBusy(false);
			if (answer) {
				bodyEl.empty();
				await MarkdownRenderer.render(this.app, answer, bodyEl, "", this);
				this.wireLinks(bodyEl);
				this.addCopyButton(bubble, answer);
			}
			this.scrollToEnd();
		}
	}

	private addMessage(role: "user" | "assistant", text: string): HTMLElement {
		const el = this.messagesEl.createDiv({ cls: `cva-msg cva-${role}` });
		if (text) el.createDiv({ cls: "cva-body", text });
		this.scrollToEnd();
		return el;
	}

	private addCopyButton(bubble: HTMLElement, text: string): void {
		const b = this.iconButton(bubble.createDiv({ cls: "cva-msg-actions" }), "copy", "Copy answer", async () => {
			await navigator.clipboard.writeText(text);
			new Notice("Copied");
		});
		b.addClass("cva-small");
	}

	/** Make [[wikilinks]] in rendered answers open the note. */
	private wireLinks(el: HTMLElement): void {
		el.querySelectorAll("a.internal-link").forEach((a) => {
			a.addEventListener("click", (e) => {
				e.preventDefault();
				const target = a.getAttribute("data-href") ?? a.getAttribute("href");
				if (target) void this.app.workspace.openLinkText(target, "", (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey);
			});
		});
	}

	private setBusy(busy: boolean): void {
		this.sendBtn.setText(busy ? "Stop" : "Send");
		this.sendBtn.toggleClass("mod-warning", busy);
		this.sendBtn.toggleClass("mod-cta", !busy);
	}

	private scrollToEnd(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const b = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.onclick = onClick;
		return b;
	}
}
