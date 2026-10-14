import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import { QUIZ_SCHEMA, parseQuiz, quizPrompt, type Quiz, type QuizRequest } from "../quiz";
import { systemPrompt } from "../tools";
import { ProviderError, type ChatOptions, type ChatSession, type ClaudeProvider, type StreamHandlers } from "./types";

export interface CliConfig {
	cliPath: string;
	model: string;
	vaultName: string;
	/** Local MCP server Claude Code connects to for vault access. */
	mcpUrl: string;
	mcpToken: string;
}

type CliEvent = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MCP_NAME = "obsidian";

/**
 * Runs the user's own Claude Code CLI in print mode, so requests use the Claude
 * account they signed into there. Built-in file and shell tools are turned off;
 * vault access goes only through the plugin's MCP server.
 */
export class CliProvider implements ClaudeProvider {
	readonly label = "Claude Code";

	constructor(private cfg: CliConfig) {}

	newChat(): ChatSession {
		return new CliChat(this);
	}

	async generateQuiz(req: QuizRequest, signal: AbortSignal, onStatus: (s: string) => void): Promise<Quiz> {
		onStatus(`Writing ${req.count} questions from ${req.notes.length} note(s)…`);
		const args = [
			"--output-format",
			"stream-json",
			"--verbose",
			"--json-schema",
			JSON.stringify(QUIZ_SCHEMA),
			"--no-session-persistence",
			...this.toolArgs(req.webAccess, false),
			"--system-prompt",
			"You write accurate study quizzes from a student's own notes.",
		];
		let result: CliEvent | null = null;
		await this.run(args, quizPrompt(req), signal, (ev) => {
			if (ev.type === "stream_event" && ev.event?.type === "content_block_start") {
				const name = ev.event.content_block?.name;
				if (name === "WebSearch" || name === "WebFetch") onStatus("Searching the web…");
			}
			if (ev.type === "result") result = ev;
		});
		const res = result as CliEvent | null;
		if (!res) throw new ProviderError("Claude Code ended without a result.");
		if (res.is_error) throw new ProviderError(`Claude Code: ${res.result ?? res.subtype}`);
		return parseQuiz(res.structured_output ?? res.result);
	}

	toolArgs(webAccess: boolean, withVault: boolean): string[] {
		const builtins = webAccess ? ["WebSearch", "WebFetch"] : [];
		const allowed = [...builtins];
		const args = ["--tools", builtins.join(","), "--strict-mcp-config", "--setting-sources", ""];
		if (withVault) {
			allowed.push(`mcp__${MCP_NAME}`);
			args.push(
				"--mcp-config",
				JSON.stringify({
					mcpServers: {
						[MCP_NAME]: {
							type: "http",
							url: this.cfg.mcpUrl,
							headers: { Authorization: `Bearer ${this.cfg.mcpToken}` },
						},
					},
				}),
			);
		}
		if (allowed.length) args.push("--allowedTools", allowed.join(","));
		if (this.cfg.model) args.push("--model", this.cfg.model);
		return args;
	}

	systemPrompt(webAccess: boolean): string {
		return systemPrompt(webAccess, this.cfg.vaultName);
	}

	/** Spawn `claude -p`, feed the prompt on stdin, and stream parsed JSON events. */
	run(args: string[], prompt: string, signal: AbortSignal, onEvent: (ev: CliEvent) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new ProviderError("Stopped."));
			const child = spawn(this.cfg.cliPath, ["-p", ...args], {
				cwd: os.tmpdir(),
				env: cliEnv(),
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			let stderr = "";
			let buffer = "";
			const onAbort = () => child.kill();
			signal.addEventListener("abort", onAbort, { once: true });

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				let nl: number;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;
					try {
						onEvent(JSON.parse(line));
					} catch {
						/* ignore non-JSON lines */
					}
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (c: string) => (stderr += c));
			child.on("error", (e: NodeJS.ErrnoException) => {
				signal.removeEventListener("abort", onAbort);
				reject(
					new ProviderError(
						e.code === "ENOENT"
							? `Couldn't find Claude Code at "${this.cfg.cliPath}". Install it or set the full path in settings.`
							: e.message,
					),
				);
			});
			child.on("close", (code) => {
				signal.removeEventListener("abort", onAbort);
				if (buffer.trim()) {
					try {
						onEvent(JSON.parse(buffer));
					} catch {
						/* ignore */
					}
				}
				if (signal.aborted) return reject(new ProviderError("Stopped."));
				if (code !== 0 && code !== null) {
					const msg = stderr.trim().split("\n").slice(-3).join(" ");
					return reject(new ProviderError(`Claude Code exited with code ${code}${msg ? `: ${msg}` : ""}`));
				}
				resolve();
			});
			child.stdin.end(prompt);
		});
	}

	async version(): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.cfg.cliPath, ["--version"], { env: cliEnv(), windowsHide: true });
			let out = "";
			child.stdout.on("data", (c) => (out += c));
			child.on("error", (e) => reject(e));
			child.on("close", () => resolve(out.trim()));
		});
	}
}

class CliChat implements ChatSession {
	private sessionId: string | null = null;

	constructor(private provider: CliProvider) {}

	async send(userText: string, opts: ChatOptions, h: StreamHandlers): Promise<void> {
		const args = [
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			...this.provider.toolArgs(opts.webAccess, true),
			"--system-prompt",
			this.provider.systemPrompt(opts.webAccess),
		];
		if (this.sessionId) args.push("--resume", this.sessionId);

		const prompt = opts.context ? `${opts.context}\n\n${userText}` : userText;
		let wroteText = false;
		let needsBreak = false;
		let errorText: string | null = null;
		h.onStatus("Thinking…");

		await this.provider.run(args, prompt, opts.signal, (ev) => {
			if (ev.session_id && !this.sessionId) this.sessionId = ev.session_id;
			if (ev.type === "stream_event") {
				const e = ev.event;
				if (e?.type === "content_block_start") {
					const block = e.content_block ?? {};
					if (block.type === "tool_use" || block.type === "server_tool_use") {
						h.onStatus(cliToolStatus(block.name));
						if (wroteText) needsBreak = true;
					}
				} else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
					if (needsBreak) h.onText("\n\n");
					needsBreak = false;
					wroteText = true;
					h.onStatus("");
					h.onText(e.delta.text);
				}
			} else if (ev.type === "result") {
				if (ev.session_id) this.sessionId = ev.session_id;
				if (ev.is_error) errorText = String(ev.result ?? ev.subtype ?? "unknown error");
				else if (!wroteText && typeof ev.result === "string") h.onText(ev.result);
			}
		});
		h.onStatus("");
		if (errorText) throw new ProviderError(`Claude Code: ${errorText}`);
	}
}

function cliToolStatus(name: string | undefined): string {
	const tool = (name ?? "").replace(`mcp__${MCP_NAME}__`, "");
	switch (tool) {
		case "search_notes":
			return "Searching notes…";
		case "read_note":
			return "Reading a note…";
		case "list_notes":
			return "Listing notes…";
		case "get_active_note":
			return "Reading the open note…";
		case "WebSearch":
		case "web_search":
			return "Searching the web…";
		case "WebFetch":
			return "Reading a web page…";
		default:
			return "Working…";
	}
}

/** Apps launched from a desktop often miss shell PATH entries where `claude` lives. */
function cliEnv(): NodeJS.ProcessEnv {
	const home = os.homedir();
	const extra =
		process.platform === "win32"
			? [path.join(home, ".local", "bin"), path.join(home, "AppData", "Roaming", "npm")]
			: [
					path.join(home, ".local", "bin"),
					path.join(home, ".claude", "local"),
					path.join(home, ".npm-global", "bin"),
					"/usr/local/bin",
					"/opt/homebrew/bin",
				];
	const sep = process.platform === "win32" ? ";" : ":";
	const env = { ...process.env };
	// Use the CLI's own login, not an API key that happens to be in Obsidian's environment.
	delete env.ANTHROPIC_API_KEY;
	env.PATH = [...(process.env.PATH ?? "").split(sep), ...extra].filter(Boolean).join(sep);
	return env;
}
