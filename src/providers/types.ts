import type { Quiz, QuizRequest } from "../quiz";

export interface StreamHandlers {
	/** Called with each chunk of answer text as it arrives. */
	onText: (delta: string) => void;
	/** Short status line, e.g. "Reading Biology/Cells.md". */
	onStatus: (status: string) => void;
}

export interface ChatOptions {
	webAccess: boolean;
	/** Extra context prepended to the user message (e.g. the open note). */
	context?: string;
	signal: AbortSignal;
}

/** A conversation with Claude. Holds its own history. */
export interface ChatSession {
	send(userText: string, opts: ChatOptions, handlers: StreamHandlers): Promise<void>;
}

export interface ClaudeProvider {
	readonly label: string;
	newChat(): ChatSession;
	generateQuiz(req: QuizRequest, signal: AbortSignal, onStatus: (s: string) => void): Promise<Quiz>;
}

export class ProviderError extends Error {}
