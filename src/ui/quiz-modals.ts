import { App, MarkdownRenderer, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type ClaudeVaultPlugin from "../main";
import { quizToMarkdown, sourceLink, type Difficulty, type Quiz, type QuizStyle } from "../quiz";

type Scope = "active" | "folder" | "vault";

const CHAR_BUDGET = 400_000; // roughly 100k tokens of notes

/** Pick what to be quizzed on, then generate. */
export class QuizSetupModal extends Modal {
	private quizScope: Scope;
	private folder = "";
	private count: number;
	private style: QuizStyle = "mixed";
	private difficulty: Difficulty = "medium";
	private focus = "";
	private web: boolean;
	private abort: AbortController | null = null;

	constructor(
		app: App,
		private plugin: ClaudeVaultPlugin,
	) {
		super(app);
		this.quizScope = plugin.vault.activeNote() ? "active" : "vault";
		this.count = plugin.settings.quizQuestionCount;
		this.web = plugin.settings.webAccess;
	}

	onOpen(): void {
		this.setTitle("Generate a quiz");
		this.render();
	}

	onClose(): void {
		this.abort?.abort();
		this.contentEl.empty();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const active = this.plugin.vault.activeNote();

		new Setting(el).setName("Quiz me on").addDropdown((d) => {
			if (active) d.addOption("active", `Open note (${active.basename})`);
			d.addOption("folder", "A folder");
			d.addOption("vault", "All allowed notes");
			d.setValue(this.quizScope).onChange((v) => {
				this.quizScope = v as Scope;
				this.render();
			});
		});

		if (this.quizScope === "folder") {
			const folders = this.allowedFolders();
			if (!this.folder && folders.length) this.folder = folders[0];
			new Setting(el).setName("Folder").addDropdown((d) => {
				for (const f of folders) d.addOption(f, f);
				d.setValue(this.folder).onChange((v) => (this.folder = v));
			});
		}

		new Setting(el)
			.setName("Focus (optional)")
			.setDesc("A topic to concentrate on. With a large scope, notes matching it are used first.")
			.addText((t) => t.setPlaceholder("e.g. photosynthesis").setValue(this.focus).onChange((v) => (this.focus = v)));

		new Setting(el).setName("Questions").addSlider((s) =>
			s
				.setLimits(3, 30, 1)
				.setValue(this.count)
				.setDynamicTooltip()
				.onChange((v) => (this.count = v)),
		);

		new Setting(el).setName("Question type").addDropdown((d) =>
			d
				.addOptions({
					mixed: "Mixed",
					multiple_choice: "Multiple choice",
					true_false: "True / false",
					short_answer: "Short answer",
				})
				.setValue(this.style)
				.onChange((v) => (this.style = v as QuizStyle)),
		);

		new Setting(el).setName("Difficulty").addDropdown((d) =>
			d
				.addOptions({ easy: "Easy", medium: "Medium", hard: "Hard" })
				.setValue(this.difficulty)
				.onChange((v) => (this.difficulty = v as Difficulty)),
		);

		new Setting(el)
			.setName("Use the web")
			.setDesc("Let Claude check facts or add context from the internet. Off keeps the quiz strictly to your notes.")
			.addToggle((t) => t.setValue(this.web).onChange((v) => (this.web = v)));

		const status = el.createDiv({ cls: "cva-status is-hidden" });
		new Setting(el).addButton((b) =>
			b
				.setButtonText("Generate")
				.setCta()
				.onClick(async () => {
					if (this.abort) {
						this.abort.abort();
						return;
					}
					b.setButtonText("Cancel");
					status.removeClass("is-hidden");
					this.abort = new AbortController();
					try {
						await this.generate((s) => status.setText(s), this.abort.signal);
					} catch (e) {
						if (!this.abort?.signal.aborted) new Notice(e instanceof Error ? e.message : String(e), 8000);
						status.addClass("is-hidden");
					} finally {
						this.abort = null;
						b.setButtonText("Generate");
					}
				}),
		);
	}

	private allowedFolders(): string[] {
		const set = new Set<string>();
		for (const f of this.plugin.vault.notes()) {
			let folder: TFolder | null = f.parent;
			while (folder && !folder.isRoot()) {
				set.add(folder.path);
				folder = folder.parent;
			}
		}
		return [...set].sort();
	}

	private async generate(onStatus: (s: string) => void, signal: AbortSignal): Promise<void> {
		const provider = this.plugin.getProvider();
		const vault = this.plugin.vault;
		let files: TFile[];
		let label: string;
		if (this.quizScope === "active") {
			const f = vault.activeNote();
			if (!f) throw new Error("No allowed note is open.");
			files = [f];
			label = f.path;
		} else if (this.quizScope === "folder") {
			files = vault.notes(this.folder);
			label = this.folder;
		} else {
			files = vault.notes();
			label = "vault";
		}
		if (files.length === 0) throw new Error("No notes in that scope.");

		if (this.focus.trim() && files.length > 1) {
			const hits = await vault.search(this.focus, 1000, this.quizScope === "folder" ? this.folder : undefined);
			const rank = new Map(hits.map((h, i) => [h.path, i]));
			files = files
				.filter((f) => rank.has(f.path))
				.sort((a, b) => rank.get(a.path)! - rank.get(b.path)!)
				.concat(files.filter((f) => !rank.has(f.path)));
		} else if (files.length > 1) {
			// No focus: favour recently edited notes when everything won't fit.
			files = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime);
		}

		onStatus("Reading notes…");
		const notes = await vault.collect(files, CHAR_BUDGET);
		if (notes.length === 0) throw new Error("Those notes are empty.");

		const quiz = await provider.generateQuiz(
			{
				count: this.count,
				style: this.style,
				difficulty: this.difficulty,
				focus: this.focus.trim(),
				webAccess: this.web,
				notes,
			},
			signal,
			onStatus,
		);
		if (signal.aborted) return;
		this.close();
		new QuizModal(this.app, this.plugin, quiz, label).open();
	}
}

/** Take the quiz: answer, check, see score, save as a note. */
export class QuizModal extends Modal {
	private answers = new Map<number, string>();
	private selfGrades = new Map<number, boolean>();
	private checked = false;

	constructor(
		app: App,
		private plugin: ClaudeVaultPlugin,
		private quiz: Quiz,
		private scopeLabel: string,
	) {
		super(app);
		this.modalEl.addClass("cva-quiz-modal");
	}

	onOpen(): void {
		this.setTitle(this.quiz.title);
		void this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const el = this.contentEl;
		el.empty();

		if (this.checked) {
			const { right, total, pending } = this.score();
			const s = el.createDiv({ cls: "cva-score" });
			s.setText(
				pending
					? `Score so far: ${right} / ${total} — mark your short answers below`
					: `Score: ${right} / ${total} (${Math.round((right / total) * 100)}%)`,
			);
		}

		for (const [i, q] of this.quiz.questions.entries()) {
			const card = el.createDiv({ cls: "cva-question" });
			const head = card.createDiv({ cls: "cva-q-text" });
			await MarkdownRenderer.render(this.app, `**${i + 1}.** ${q.question}`, head, "", this.plugin);

			if (q.type === "short_answer") {
				const input = card.createEl("textarea", { attr: { rows: "2", placeholder: "Your answer" } });
				input.value = this.answers.get(i) ?? "";
				input.disabled = this.checked;
				input.oninput = () => this.answers.set(i, input.value);
			} else {
				const opts = card.createDiv({ cls: "cva-options" });
				for (const option of q.options) {
					const label = opts.createEl("label", { cls: "cva-option" });
					const radio = label.createEl("input", { type: "radio", attr: { name: `q${i}` } });
					radio.checked = this.answers.get(i) === option;
					radio.disabled = this.checked;
					radio.onchange = () => this.answers.set(i, option);
					label.createSpan({ text: option });
					if (this.checked) {
						if (option === q.answer) label.addClass("is-correct");
						else if (this.answers.get(i) === option) label.addClass("is-wrong");
					}
				}
			}

			if (this.checked) {
				const fb = card.createDiv({ cls: "cva-feedback" });
				if (q.type === "short_answer") {
					fb.createDiv({ text: `Model answer: ${q.answer}` });
					const grade = fb.createDiv({ cls: "cva-self-grade" });
					const mark = (v: boolean) => {
						this.selfGrades.set(i, v);
						void this.render();
					};
					const g = this.selfGrades.get(i);
					const yes = grade.createEl("button", { text: "I got it" });
					const no = grade.createEl("button", { text: "I missed it" });
					if (g === true) yes.addClass("mod-cta");
					if (g === false) no.addClass("mod-warning");
					yes.onclick = () => mark(true);
					no.onclick = () => mark(false);
				} else {
					const right = this.answers.get(i) === q.answer;
					fb.createDiv({ cls: right ? "cva-right" : "cva-wrong", text: right ? "Correct" : `Answer: ${q.answer}` });
				}
				const extra = [q.explanation, q.source ? `Source: ${sourceLink(q.source)}` : ""].filter(Boolean).join("\n\n");
				if (extra) {
					const ex = fb.createDiv({ cls: "cva-explanation" });
					await MarkdownRenderer.render(this.app, extra, ex, "", this.plugin);
					ex.querySelectorAll("a.internal-link").forEach((a) =>
						a.addEventListener("click", (e) => {
							e.preventDefault();
							const href = a.getAttribute("data-href");
							if (href) void this.app.workspace.openLinkText(href, "", true);
						}),
					);
				}
			}
		}

		const buttons = new Setting(el);
		if (!this.checked) {
			buttons.addButton((b) =>
				b
					.setButtonText("Check answers")
					.setCta()
					.onClick(() => {
						this.checked = true;
						void this.render();
						this.contentEl.scrollTop = 0;
					}),
			);
		} else {
			buttons.addButton((b) =>
				b.setButtonText("Retake").onClick(() => {
					this.checked = false;
					this.answers.clear();
					this.selfGrades.clear();
					void this.render();
					this.contentEl.scrollTop = 0;
				}),
			);
		}
		buttons.addButton((b) => b.setButtonText("Save as note").onClick(() => void this.save()));
	}

	private score(): { right: number; total: number; pending: boolean } {
		let right = 0;
		let pending = false;
		this.quiz.questions.forEach((q, i) => {
			if (q.type === "short_answer") {
				const g = this.selfGrades.get(i);
				if (g === undefined) pending = true;
				else if (g) right++;
			} else if (this.answers.get(i) === q.answer) right++;
		});
		return { right, total: this.quiz.questions.length, pending };
	}

	private async save(): Promise<void> {
		const folder = normalizePath(this.plugin.settings.quizFolder);
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const safe = this.quiz.title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Quiz";
		const date = new Date().toLocaleDateString("en-CA");
		let path = normalizePath(`${folder}/${safe} ${date}.md`);
		for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) {
			path = normalizePath(`${folder}/${safe} ${date} ${n}.md`);
		}
		const file = await this.app.vault.create(path, quizToMarkdown(this.quiz, this.scopeLabel));
		new Notice(`Saved ${file.path}`);
		await this.app.workspace.getLeaf("tab").openFile(file);
	}
}
