# Claude Vault Assistant

An Obsidian plugin that connects Claude to your vault. Ask questions about your notes, generate quizzes from them, and decide exactly which folders Claude can see and whether it may use the internet.

## Features

- **Chat about your vault.** A side panel where Claude searches and reads your notes, then answers with `[[wikilinks]]` to the notes it used. Answers stream in, and the panel shows what Claude is doing ("Searching notes for…", "Reading Biology/Cells.md…").
- **Quizzes.** Generate a quiz from the open note, a folder, or all allowed notes. You can choose the number of questions, question type (multiple choice, true/false, short answer, or mixed), difficulty, and an optional focus topic. Take the quiz in Obsidian, check your score, and save it as a note with collapsible answers.
- **Folder permissions.** Set allowed folders and excluded folders. Claude can't list, search or read anything outside them. The rules apply in every connection mode, including Claude Desktop.
- **Vault only, or vault + web.** With web search off, Claude answers only from your notes and says so when they don't cover something. With it on, Claude may search the web and labels what came from it. Set the default in settings and change it per chat with the toggle in the chat header.

## Ways to connect

| Mode | What you need | Chat + quizzes in Obsidian | Notes |
|---|---|---|---|
| **Anthropic API key** | A key from [platform.claude.com](https://platform.claude.com) | Yes | Pay per use. The key is kept in Obsidian's secret storage, not in `data.json`. |
| **Claude Code (signed-in account)** | [Claude Code](https://code.claude.com) installed and signed in (`claude` once in a terminal) | Yes | Uses your Claude subscription via the CLI. Claude Code's file and shell tools are turned off. It can only reach your vault through the plugin's MCP server. |
| **Claude Desktop only** | Claude Desktop + Node.js 18+ | No, you chat in Claude Desktop | The plugin runs a local MCP server and Claude Desktop connects to it. |

Third-party apps can't sign in to claude.ai directly, so the "sign in" option goes through your own Claude Code login.

### Connecting Claude Desktop

1. In plugin settings, turn on **Run MCP server** (it's always on in Claude Code and Claude Desktop modes).
2. Click **Copy** under the config snippet, or run the command **Claude Vault Assistant: Copy Claude Desktop config**.
3. In Claude Desktop, go to **Settings → Developer → Edit Config** and merge the snippet into `claude_desktop_config.json`.
4. Restart Claude Desktop. The *obsidian* server provides `list_notes`, `search_notes`, `read_note` and `get_active_note`, plus a **Quiz me on my notes** prompt.

Obsidian has to be open for Claude Desktop to reach the vault. The server only listens on `127.0.0.1`, needs a random access token, and rejects requests from web pages. You can regenerate the token in settings.

The settings also show a `claude mcp add …` command, so you can use your vault from Claude Code in a terminal.

## Install

### From source

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/claude-vault-assistant/`. Then enable **Claude Vault Assistant** under Settings → Community plugins.

For development, run `npm run dev` to rebuild on changes. A symlink from the plugin folder to this repo makes this easier.

Requires Obsidian 1.11.4 or newer, desktop only.

## Usage

- **Ribbon icons:** the bot icon opens the chat and the checklist icon generates a quiz.
- **Commands:** *Open chat*, *Generate a quiz*, *Summarize the open note*, *Copy Claude Desktop config*.
- **Open note as context:** by default, the note you have open is sent with each chat message (only if it's in an allowed folder). You can turn this off in settings.

## Privacy

- Claude only receives note content it reads through the plugin's tools, plus the open note if that option is on. Both are limited to the allowed folders. Hidden folders like `.obsidian` are never readable.
- In API mode, requests go straight from Obsidian to the Anthropic API. In Claude Code mode, they go through your local `claude` process.
- With web search off, no web tools are given to Claude in API or Claude Code mode. In Claude Desktop mode, the setting reaches Claude as an instruction, and Claude Desktop's own web search setting still applies.

## Project layout

```
src/
  main.ts            plugin entry, commands, provider selection, MCP lifecycle
  settings.ts        settings model + settings tab
  vault-access.ts    folder rules; all note listing/search/reading goes through here
  tools.ts           vault tool definitions + system prompt (shared by API and MCP)
  quiz.ts            quiz schema, prompt, parsing, Markdown export
  mcp-server.ts      local MCP server (HTTP) + stdio bridge for Claude Desktop
  providers/api.ts   Anthropic API: streaming tool loop, web search, structured output
  providers/cli.ts   Claude Code CLI: `claude -p` with stream-json, vault via MCP
  ui/chat-view.ts    chat side panel
  ui/quiz-modals.ts  quiz setup + quiz taking
```
