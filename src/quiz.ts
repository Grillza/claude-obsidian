export type QuestionType = "multiple_choice" | "true_false" | "short_answer";
export type QuizStyle = "mixed" | QuestionType;
export type Difficulty = "easy" | "medium" | "hard";

export interface QuizQuestion {
	type: QuestionType;
	question: string;
	/** Choices for multiple choice / true-false; empty for short answer. */
	options: string[];
	/** For choice questions, exactly one entry of `options`. */
	answer: string;
	explanation: string;
	/** Vault note path or URL the question is based on. */
	source: string;
}

export interface Quiz {
	title: string;
	questions: QuizQuestion[];
}

export interface QuizRequest {
	count: number;
	style: QuizStyle;
	difficulty: Difficulty;
	focus: string;
	webAccess: boolean;
	notes: { path: string; content: string }[];
}

export const QUIZ_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		questions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["multiple_choice", "true_false", "short_answer"] },
					question: { type: "string" },
					options: { type: "array", items: { type: "string" } },
					answer: { type: "string" },
					explanation: { type: "string" },
					source: { type: "string" },
				},
				required: ["type", "question", "options", "answer", "explanation", "source"],
				additionalProperties: false,
			},
		},
	},
	required: ["title", "questions"],
	additionalProperties: false,
} as const;

const STYLE_TEXT: Record<QuizStyle, string> = {
	mixed: "a mix of multiple choice, true/false and short answer questions",
	multiple_choice: "multiple choice questions with 4 options each",
	true_false: 'true/false questions (options exactly ["True", "False"])',
	short_answer: "short answer questions (options must be an empty array)",
};

export function quizPrompt(req: QuizRequest): string {
	const notes = req.notes
		.map((n) => `<note path="${n.path.replace(/"/g, "'")}">\n${n.content}\n</note>`)
		.join("\n\n");
	const web = req.webAccess
		? "You may search the web to add context or check facts, but every question must still be about material in these notes. For a question that relies on web information, set source to the URL."
		: "Use only the notes below. Do not add facts from outside knowledge or the web.";
	return `Write a ${req.difficulty} quiz of exactly ${req.count} questions with ${STYLE_TEXT[req.style]}, based on the user's Obsidian notes below.
${req.focus ? `\nFocus on: ${req.focus}\n` : ""}
${web}

Rules:
- Test understanding of the important ideas, not trivia like file names or formatting.
- For multiple_choice and true_false, "answer" must be copied exactly from "options". For short_answer, "options" is [] and "answer" is a concise model answer.
- Make wrong options plausible. Vary which position holds the correct option.
- "explanation" says briefly why the answer is right, referring to the note.
- "source" is the path of the note the question comes from.
- "title" is a short name for the quiz.

Respond with only the quiz as JSON matching the required schema.

<notes>
${notes}
</notes>`;
}

/** Validate model output, dropping malformed questions instead of failing the whole quiz. */
export function parseQuiz(raw: unknown): Quiz {
	let data = raw;
	if (typeof data === "string") data = JSON.parse(extractJson(data));
	if (!data || typeof data !== "object") throw new Error("Claude did not return a quiz.");
	const obj = data as Record<string, unknown>;
	const questions = (Array.isArray(obj.questions) ? obj.questions : [])
		.map((q): QuizQuestion | null => {
			if (!q || typeof q !== "object") return null;
			const r = q as Record<string, unknown>;
			const type = r.type as QuestionType;
			if (!["multiple_choice", "true_false", "short_answer"].includes(type)) return null;
			const options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === "string") : [];
			const answer = typeof r.answer === "string" ? r.answer : "";
			if (typeof r.question !== "string" || !answer) return null;
			if (type !== "short_answer" && !options.includes(answer)) return null;
			return {
				type,
				question: r.question,
				options: type === "short_answer" ? [] : options,
				answer,
				explanation: typeof r.explanation === "string" ? r.explanation : "",
				source: typeof r.source === "string" ? r.source : "",
			};
		})
		.filter((q): q is QuizQuestion => q !== null);
	if (questions.length === 0) throw new Error("Claude's quiz had no usable questions.");
	return { title: typeof obj.title === "string" && obj.title ? obj.title : "Quiz", questions };
}

function extractJson(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1];
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("Claude did not return JSON.");
	return text.slice(start, end + 1);
}

export function sourceLink(source: string): string {
	if (!source) return "";
	if (/^https?:\/\//.test(source)) return `[${source}](${source})`;
	return `[[${source.replace(/\.md$/, "")}]]`;
}

export function quizToMarkdown(quiz: Quiz, scopeLabel: string): string {
	const date = new Date().toLocaleDateString("en-CA");
	const parts = [`---\ntype: quiz\ncreated: ${date}\nscope: "${scopeLabel.replace(/"/g, "'")}"\n---`, `# ${quiz.title}`];
	quiz.questions.forEach((q, i) => {
		const lines = [`## ${i + 1}. ${q.question}`];
		if (q.options.length) {
			const letters = "ABCDEFGHIJ";
			q.options.forEach((o, j) => lines.push(`- ${letters[j] ?? "-"}. ${o}`));
		}
		lines.push("", "> [!success]- Answer", `> **${q.answer}**`);
		if (q.explanation) lines.push(">", `> ${q.explanation.replace(/\n/g, "\n> ")}`);
		if (q.source) lines.push(">", `> Source: ${sourceLink(q.source)}`);
		parts.push(lines.join("\n"));
	});
	return parts.join("\n\n") + "\n";
}
