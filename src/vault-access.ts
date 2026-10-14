import { App, TFile, normalizePath } from "obsidian";
import type { ClaudeVaultSettings } from "./settings";

const READABLE_EXTENSIONS = new Set(["md", "txt", "canvas"]);
const MAX_NOTE_CHARS = 60_000;

export interface SearchHit {
	path: string;
	score: number;
	snippets: string[];
}

/**
 * The only way Claude touches the vault. Every read goes through `isAllowed`,
 * so the folder rules hold no matter which connection mode is in use.
 */
export class VaultAccess {
	constructor(
		private app: App,
		private getSettings: () => ClaudeVaultSettings,
	) {}

	isAllowed(path: string): boolean {
		const p = normalizePath(path);
		if (p.split("/").some((part) => part === ".." || part.startsWith("."))) return false;
		const { allowedFolders, excludedFolders } = this.getSettings();
		const inside = (folder: string) => folder === "" || p === folder || p.startsWith(folder + "/");
		if (excludedFolders.some(inside)) return false;
		return allowedFolders.length === 0 || allowedFolders.some(inside);
	}

	/** Readable notes visible to Claude, optionally limited to one folder. */
	notes(folder?: string): TFile[] {
		const f = folder ? normalizePath(folder).replace(/^\/+|\/+$/g, "") : "";
		return this.app.vault
			.getFiles()
			.filter(
				(file) =>
					READABLE_EXTENSIONS.has(file.extension) &&
					this.isAllowed(file.path) &&
					(f === "" || f === "/" || file.path.startsWith(f + "/")),
			)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getFile(path: string): TFile | null {
		const p = normalizePath(path);
		if (!this.isAllowed(p)) return null;
		let file = this.app.vault.getAbstractFileByPath(p);
		if (!file && !p.includes(".")) file = this.app.vault.getAbstractFileByPath(p + ".md");
		if (!(file instanceof TFile) || !READABLE_EXTENSIONS.has(file.extension)) return null;
		return this.isAllowed(file.path) ? file : null;
	}

	async read(file: TFile, maxChars = MAX_NOTE_CHARS): Promise<string> {
		const text = await this.app.vault.cachedRead(file);
		if (text.length <= maxChars) return text;
		return text.slice(0, maxChars) + `\n\n[... truncated, ${text.length - maxChars} more characters]`;
	}

	activeNote(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && this.isAllowed(file.path) && READABLE_EXTENSIONS.has(file.extension) ? file : null;
	}

	async search(query: string, limit = 10, folder?: string): Promise<SearchHit[]> {
		const terms = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 1);
		if (terms.length === 0) return [];

		const hits: SearchHit[] = [];
		for (const file of this.notes(folder)) {
			const text = await this.app.vault.cachedRead(file);
			const lower = text.toLowerCase();
			const name = file.basename.toLowerCase();
			let score = 0;
			const snippets: string[] = [];
			for (const term of terms) {
				if (name.includes(term)) score += 5;
				let idx = lower.indexOf(term);
				let count = 0;
				while (idx !== -1 && count < 50) {
					count++;
					if (snippets.length < 3 && count === 1) {
						const start = Math.max(0, idx - 80);
						snippets.push(text.slice(start, idx + term.length + 80).replace(/\s+/g, " ").trim());
					}
					idx = lower.indexOf(term, idx + term.length);
				}
				score += count;
			}
			// Prefer notes that match every term.
			if (terms.every((t) => lower.includes(t) || name.includes(t))) score *= 2;
			if (score > 0) hits.push({ path: file.path, score, snippets });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Gather note text up to a character budget, for quizzes. */
	async collect(files: TFile[], budget: number): Promise<{ path: string; content: string }[]> {
		const out: { path: string; content: string }[] = [];
		let used = 0;
		for (const file of files) {
			if (used >= budget) break;
			const content = await this.read(file, Math.min(MAX_NOTE_CHARS, budget - used));
			if (!content.trim()) continue;
			out.push({ path: file.path, content });
			used += content.length;
		}
		return out;
	}
}
