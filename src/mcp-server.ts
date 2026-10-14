import * as http from "http";
import { VAULT_TOOLS, runVaultTool } from "./tools";
import type { VaultAccess } from "./vault-access";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1_000_000;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

/**
 * A minimal MCP server (Streamable HTTP transport, JSON responses only) bound to
 * localhost. It exposes the same vault tools the in-app chat uses, so the
 * folder rules apply to Claude Desktop and Claude Code too.
 */
export class VaultMcpServer {
	private server: http.Server | null = null;

	constructor(
		private vault: VaultAccess,
		private opts: { port: number; token: string; instructions: () => string; version: string },
	) {}

	get running(): boolean {
		return this.server?.listening ?? false;
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				this.handle(req, res).catch((e) => {
					if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify(rpcError(null, -32603, e instanceof Error ? e.message : String(e))));
				});
			});
			server.once("error", reject);
			server.listen(this.opts.port, "127.0.0.1", () => {
				server.off("error", reject);
				this.server = server;
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) return Promise.resolve();
		return new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		});
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/mcp") return void res.writeHead(404).end();

		// Browsers always send Origin; MCP clients like Claude Desktop don't. Blocking
		// browser origins stops web pages from reaching the vault (DNS rebinding).
		if (req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) {
			return void res.writeHead(403).end("Forbidden origin");
		}
		if (req.headers.authorization !== `Bearer ${this.opts.token}`) {
			return void res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
		}
		if (req.method === "DELETE") return void res.writeHead(200).end();
		if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();

		const body = await readBody(req);
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			return sendJson(res, 400, rpcError(null, -32700, "Parse error"));
		}

		const batch = Array.isArray(payload);
		const requests = (batch ? payload : [payload]) as JsonRpcRequest[];
		const responses = [];
		for (const r of requests) {
			const out = await this.dispatch(r);
			if (out) responses.push(out);
		}
		if (responses.length === 0) return void res.writeHead(202).end();
		sendJson(res, 200, batch ? responses : responses[0]);
	}

	private async dispatch(r: JsonRpcRequest): Promise<object | null> {
		if (!r || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
			return rpcError(r?.id ?? null, -32600, "Invalid request");
		}
		const isNotification = r.id === undefined || r.id === null;
		const id = r.id ?? null;

		switch (r.method) {
			case "initialize": {
				const requested = String(r.params?.protocolVersion ?? "");
				return rpcResult(id, {
					protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
					capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
					serverInfo: { name: "obsidian-vault", title: "Obsidian Vault", version: this.opts.version },
					instructions: this.opts.instructions(),
				});
			}
			case "ping":
				return rpcResult(id, {});
			case "tools/list":
				return rpcResult(id, {
					tools: VAULT_TOOLS.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.input_schema,
						annotations: { readOnlyHint: true, openWorldHint: false },
					})),
				});
			case "tools/call": {
				const name = String(r.params?.name ?? "");
				if (!VAULT_TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
				const out = await runVaultTool(this.vault, name, r.params?.arguments ?? {});
				return rpcResult(id, { content: [{ type: "text", text: out.text }], isError: out.isError });
			}
			case "prompts/list":
				return rpcResult(id, { prompts: [QUIZ_PROMPT] });
			case "prompts/get": {
				if (r.params?.name !== QUIZ_PROMPT.name) return rpcError(id, -32602, "Unknown prompt");
				const args = (r.params?.arguments ?? {}) as Record<string, string>;
				return rpcResult(id, {
					description: QUIZ_PROMPT.description,
					messages: [{ role: "user", content: { type: "text", text: quizPromptText(args) } }],
				});
			}
			default:
				if (isNotification) return null;
				return rpcError(id, -32601, `Method not found: ${r.method}`);
		}
	}
}

const QUIZ_PROMPT = {
	name: "quiz_me",
	title: "Quiz me on my notes",
	description: "Generate a quiz from notes in your Obsidian vault.",
	arguments: [
		{ name: "topic", description: "Topic, folder, or note to be quizzed on", required: true },
		{ name: "count", description: "Number of questions (default 10)", required: false },
	],
};

function quizPromptText(args: Record<string, string>): string {
	const count = Number(args.count) || 10;
	return `Quiz me on "${args.topic ?? "my notes"}" using my Obsidian vault. First use search_notes / list_notes and read_note to find and read the relevant notes. Then write ${count} questions (a mix of multiple choice, true/false and short answer) testing the key ideas. Ask them one at a time, wait for my answer, tell me if I was right with a short explanation citing the note, and give my score at the end.`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error("Request too large"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function rpcResult(id: string | number | null, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Claude Desktop launches local MCP servers as stdio processes. This tiny
 * bridge forwards stdio JSON-RPC to the plugin's HTTP server. It is written
 * into the plugin folder and run with the user's Node.js.
 */
export const BRIDGE_SOURCE = `#!/usr/bin/env node
// Generated by the Claude Vault Assistant Obsidian plugin.
// Bridges Claude Desktop (stdio) to the plugin's local MCP server (HTTP).
"use strict";
const url = process.env.OBSIDIAN_MCP_URL || "http://127.0.0.1:27125/mcp";
const token = process.env.OBSIDIAN_MCP_TOKEN || "";
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();

function reply(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const ids = (Array.isArray(msg) ? msg : [msg]).filter((m) => m && m.id !== undefined && m.id !== null).map((m) => m.id);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + token },
      body: line,
    });
    if (res.status === 202) return;
    const text = await res.text();
    if (!res.ok) throw new Error("HTTP " + res.status + ": " + text);
    const out = JSON.parse(text);
    for (const o of Array.isArray(out) ? out : [out]) reply(o);
  } catch (e) {
    const message = "" + (String(e && e.message).includes("HTTP 401") ? "Token mismatch: copy the config again from Claude Vault Assistant settings." : "Obsidian is not reachable. Open Obsidian and enable the MCP server in Claude Vault Assistant settings. (" + (e && e.message) + ")");
    for (const id of ids) reply({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  }
}

rl.on("line", (line) => { if (line.trim()) queue = queue.then(() => forward(line)); });
rl.on("close", () => queue.then(() => process.exit(0)));
`;
