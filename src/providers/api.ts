import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../settings";
import { VAULT_TOOLS, runVaultTool, systemPrompt } from "../tools";
import type { VaultAccess } from "../vault-access";
import { QUIZ_SCHEMA, parseQuiz, quizPrompt, type Quiz, type QuizRequest } from "../quiz";
import { ProviderError, type ChatOptions, type ChatSession, type ClaudeProvider, type StreamHandlers } from "./types";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

const MAX_TOOL_ROUNDS = 25;

export interface ApiConfig {
	apiKey: string;
	model: string;
	effort: Effort;
	vaultName: string;
}

export class ApiProvider implements ClaudeProvider {
	readonly label = "Anthropic API";
	private client: Anthropic;

	constructor(
		private cfg: ApiConfig,
		private vault: VaultAccess,
	) {
		// Obsidian runs in Electron's renderer, so the SDK sees a browser.
		// The key belongs to the user and never leaves their machine except to the API.
		this.client = new Anthropic({ apiKey: cfg.apiKey, dangerouslyAllowBrowser: true });
	}

	newChat(): ChatSession {
		return new ApiChat(this);
	}

	tools(webAccess: boolean): ToolUnion[] {
		const tools: ToolUnion[] = VAULT_TOOLS.map((t) => ({ ...t, eager_input_streaming: true }));
		if (webAccess) tools.push(this.webSearchTool());
		return tools;
	}

	private webSearchTool(): ToolUnion {
		// The dynamic-filtering variant needs a recent Opus/Sonnet/Fable; Haiku keeps the basic one.
		return this.cfg.model.startsWith("claude-haiku")
			? { type: "web_search_20250305", name: "web_search", max_uses: 5 }
			: { type: "web_search_20260209", name: "web_search", max_uses: 5 };
	}

	/** One streamed request. Shared request shape for chat and quizzes. */
	stream(
		params: { system: string; messages: MessageParam[]; tools: ToolUnion[]; maxTokens: number; format?: object },
		signal: AbortSignal,
	) {
		return this.client.beta.messages.stream(
			{
				model: this.cfg.model,
				max_tokens: params.maxTokens,
				system: params.system,
				messages: params.messages,
				tools: params.tools,
				cache_control: { type: "ephemeral" },
				output_config: {
					effort: this.cfg.effort,
					...(params.format ? { format: { type: "json_schema", schema: params.format as Record<string, unknown> } } : {}),
				},
				// On a policy decline, let the API retry on the model's default fallback.
				betas: ["server-side-fallback-2026-07-01"],
				fallbacks: "default",
			},
			{ signal },
		);
	}

	vaultAccess(): VaultAccess {
		return this.vault;
	}

	systemPrompt(webAccess: boolean): string {
		return systemPrompt(webAccess, this.cfg.vaultName);
	}

	async generateQuiz(req: QuizRequest, signal: AbortSignal, onStatus: (s: string) => void): Promise<Quiz> {
		const messages: MessageParam[] = [{ role: "user", content: quizPrompt(req) }];
		const tools = req.webAccess ? [this.webSearchTool()] : [];
		onStatus(`Writing ${req.count} questions from ${req.notes.length} note(s)…`);

		for (let round = 0; round < 5; round++) {
			const stream = this.stream(
				{
					system: "You write accurate study quizzes from a student's own notes.",
					messages,
					tools,
					maxTokens: 32000,
					format: QUIZ_SCHEMA,
				},
				signal,
			);
			stream.on("streamEvent", (ev) => {
				if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
					onStatus("Searching the web…");
				}
			});
			const msg = await finalMessage(stream);
			checkStop(msg.stop_reason, msg.stop_details);
			if (msg.stop_reason === "pause_turn") {
				messages.push({ role: "assistant", content: msg.content });
				continue;
			}
			const text = msg.content
				.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
				.map((b) => b.text)
				.join("");
			return parseQuiz(text);
		}
		throw new ProviderError("Claude kept pausing while writing the quiz. Try again.");
	}
}

class ApiChat implements ChatSession {
	/** Append-only history, including tool calls and results. */
	private messages: MessageParam[] = [];

	constructor(private provider: ApiProvider) {}

	async send(userText: string, opts: ChatOptions, h: StreamHandlers): Promise<void> {
		const content = opts.context ? `${opts.context}\n\n${userText}` : userText;
		this.messages.push({ role: "user", content });
		const tools = this.provider.tools(opts.webAccess);
		const vault = this.provider.vaultAccess();

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			h.onStatus(round === 0 ? "Thinking…" : "Working…");
			const stream = this.provider.stream(
				{ system: this.provider.systemPrompt(opts.webAccess), messages: this.messages, tools, maxTokens: 64000 },
				opts.signal,
			);
			let wroteText = false;
			stream.on("text", (delta) => {
				if (!wroteText) h.onStatus("");
				wroteText = true;
				h.onText(delta);
			});
			stream.on("streamEvent", (ev) => {
				if (ev.type !== "content_block_start") return;
				if (ev.content_block.type === "server_tool_use") h.onStatus("Searching the web…");
				if (ev.content_block.type === "tool_use") h.onStatus(toolStatus(ev.content_block.name));
			});

			let msg: Anthropic.Beta.Messages.BetaMessage;
			try {
				msg = await finalMessage(stream);
			} catch (e) {
				// Drop the unanswered user turn so the chat can continue after an error.
				if (this.messages[this.messages.length - 1]?.role === "user" && round === 0) this.messages.pop();
				throw e;
			}

			this.messages.push({ role: "assistant", content: msg.content });
			if (msg.stop_reason === "refusal") checkStop(msg.stop_reason, msg.stop_details);
			if (msg.stop_reason === "pause_turn") continue;

			const toolUses = msg.content.filter(
				(b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use",
			);
			if (toolUses.length === 0) {
				if (msg.stop_reason === "max_tokens") h.onText("\n\n*[Response cut off: reached the length limit.]*");
				h.onStatus("");
				return;
			}
			if (msg.stop_reason === "max_tokens") {
				throw new ProviderError("Claude's tool call was cut off by the length limit.");
			}

			const results: ToolResult[] = [];
			for (const use of toolUses) {
				h.onStatus(toolStatus(use.name, use.input));
				const out = await runVaultTool(vault, use.name, use.input);
				results.push({ type: "tool_result", tool_use_id: use.id, content: out.text, is_error: out.isError });
			}
			this.messages.push({ role: "user", content: results });
			if (wroteText) h.onText("\n\n");
		}
		throw new ProviderError("Stopped after too many tool calls.");
	}
}

async function finalMessage(stream: ReturnType<ApiProvider["stream"]>): Promise<Anthropic.Beta.Messages.BetaMessage> {
	try {
		return await stream.finalMessage();
	} catch (e) {
		throw friendlyError(e);
	}
}

function checkStop(stop: string | null, details: Anthropic.Beta.Messages.BetaMessage["stop_details"]): void {
	if (stop === "refusal") {
		throw new ProviderError(
			`Claude declined this request${details?.explanation ? `: ${details.explanation}` : "."}`,
		);
	}
	if (stop === "max_tokens") throw new ProviderError("Claude's response was cut off by the length limit.");
}

function friendlyError(e: unknown): Error {
	if (e instanceof Anthropic.APIUserAbortError) return new ProviderError("Stopped.");
	if (e instanceof Anthropic.AuthenticationError) return new ProviderError("Invalid API key. Check the plugin settings.");
	if (e instanceof Anthropic.PermissionDeniedError) return new ProviderError(`Permission denied: ${e.message}`);
	if (e instanceof Anthropic.NotFoundError) return new ProviderError("Model not found. Pick another model in settings.");
	if (e instanceof Anthropic.RateLimitError) return new ProviderError("Rate limited by the API. Wait a moment and retry.");
	if (e instanceof Anthropic.BadRequestError) return new ProviderError(`Request rejected: ${e.message}`);
	if (e instanceof Anthropic.APIConnectionError) return new ProviderError("Could not reach the Anthropic API.");
	if (e instanceof Anthropic.APIError) return new ProviderError(`API error ${e.status}: ${e.message}`);
	return e instanceof Error ? e : new Error(String(e));
}

function toolStatus(name: string, input?: unknown): string {
	const args = (input ?? {}) as Record<string, unknown>;
	switch (name) {
		case "search_notes":
			return args.query ? `Searching notes for "${args.query}"…` : "Searching notes…";
		case "read_note":
			return args.path ? `Reading ${args.path}…` : "Reading a note…";
		case "list_notes":
			return "Listing notes…";
		case "get_active_note":
			return "Reading the open note…";
		default:
			return "Working…";
	}
}
