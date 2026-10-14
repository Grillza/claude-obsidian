import type { VaultAccess } from "./vault-access";

export interface VaultToolDef {
	name: string;
	description: string;
	input_schema: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
		additionalProperties: false;
	};
}

/** Tool definitions shared by the API tool loop and the MCP server. */
export const VAULT_TOOLS: VaultToolDef[] = [
	{
		name: "list_notes",
		description:
			"List the paths of notes in the user's Obsidian vault that you are allowed to read. Optionally restrict to one folder. Use this to see what notes exist before reading them.",
		input_schema: {
			type: "object",
			properties: {
				folder: { type: "string", description: "Folder path relative to the vault root. Empty for all allowed notes." },
			},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: "search_notes",
		description:
			"Full-text search across the allowed notes in the user's Obsidian vault. Returns matching note paths with short snippets, best matches first. Search with a few distinctive keywords, then read the most relevant notes.",
		input_schema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Keywords to search for." },
				limit: { type: "integer", description: "Maximum results (default 10, max 30)." },
				folder: { type: "string", description: "Optional folder to search within." },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "read_note",
		description:
			"Read the full Markdown content of one note in the user's Obsidian vault by its path (as returned by list_notes or search_notes).",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Note path relative to the vault root, e.g. 'Biology/Cells.md'." },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "get_active_note",
		description: "Get the path and content of the note the user currently has open in Obsidian.",
		input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
	},
];

export interface ToolOutput {
	text: string;
	isError: boolean;
}

const MAX_LISTED = 2000;

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

export async function runVaultTool(vault: VaultAccess, name: string, input: unknown): Promise<ToolOutput> {
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	try {
		switch (name) {
			case "list_notes": {
				const notes = vault.notes(str(args.folder));
				if (notes.length === 0) return ok("No readable notes found in the allowed folders.");
				const lines = notes.slice(0, MAX_LISTED).map((f) => f.path);
				if (notes.length > MAX_LISTED) lines.push(`... and ${notes.length - MAX_LISTED} more (narrow with a folder)`);
				return ok(`${notes.length} notes:\n${lines.join("\n")}`);
			}
			case "search_notes": {
				const query = str(args.query);
				if (!query) return err("query is required");
				const limit = Math.min(30, Math.max(1, typeof args.limit === "number" ? args.limit : 10));
				const hits = await vault.search(query, limit, str(args.folder));
				if (hits.length === 0) return ok(`No notes match "${query}".`);
				return ok(
					hits
						.map((h) => `## ${h.path}\n${h.snippets.map((s) => `> …${s}…`).join("\n")}`)
						.join("\n\n"),
				);
			}
			case "read_note": {
				const path = str(args.path);
				if (!path) return err("path is required");
				const file = vault.getFile(path);
				if (!file) return err(`"${path}" does not exist or is outside the folders the user allows you to read.`);
				return ok(`# ${file.path}\n\n${await vault.read(file)}`);
			}
			case "get_active_note": {
				const file = vault.activeNote();
				if (!file) return ok("No note is open, or the open note is outside the allowed folders.");
				return ok(`# ${file.path}\n\n${await vault.read(file)}`);
			}
			default:
				return err(`Unknown tool: ${name}`);
		}
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

function ok(text: string): ToolOutput {
	return { text, isError: false };
}
function err(text: string): ToolOutput {
	return { text, isError: true };
}

export function systemPrompt(webAccess: boolean, vaultName: string): string {
	const sources = webAccess
		? `You may also use web search to add up-to-date or missing information. Ground your answer in the user's notes first, and clearly label anything that came from the web (cite the source) so the user can tell it apart from their own notes.`
		: `Answer only from the user's notes. Do not use outside knowledge to add facts the notes don't contain; if the notes don't cover something, say so plainly. You may still use general language understanding to explain what the notes say.`;
	return `You are a study and research assistant inside the user's Obsidian vault "${vaultName}". Use the vault tools (search_notes, list_notes, read_note, get_active_note) to find and read relevant notes before answering questions about them. You can only see folders the user has allowed; never claim to have read a note you did not read.

${sources}

When you rely on a note, cite it as an Obsidian wikilink using its path without the .md extension, e.g. [[Biology/Cells]]. Format answers in Markdown.`;
}
