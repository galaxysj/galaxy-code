# Galaxy Code
One IDE. Every Agent. Endless Possibilities.

<img width="1472" height="957" alt="image" src="https://github.com/user-attachments/assets/4a943c3c-f906-47d8-b350-946efe512d05" />


**Galaxy Code** is an all-in-one AI-powered development environment inspired by [Cursor](https://cursor.com), [Codex](https://chatgpt.com/codex), and [Claude Code](https://claude.dev), powered by [OpenRouter](https://openrouter.ai).

**Galaxy Code** combines multiple AI coding agents and platforms into one unified workspace.

> Under active development. Distribution scripts currently target macOS.

## Features

- **Projects and conversations**: Work in local folders or Git worktrees, with separate windows and side chats.
- **Multiple agents**: Connect the built-in OpenRouter agent, Claude Code, Codex, and ACP agents.
- **Editing and review**: Browse files, edit , inspect diffs, and restore conversation checkpoints.
- **Terminal and browser**: Run commands and inspect web pages within the app.
- **Execution controls**: Send follow-up instructions during a run, inspect tool activity, and manage approvals and permission modes.
- **Model options**: Choose models, reasoning effort, and speed options where supported.
- **ACP agents**: Connect external providers, Codex & Claude for integrated use in one workspace.

Available tools and model options depend on the selected agent.

## Getting started

### Requirements

- Node.js **22.12 or later** and npm
- An LLM API key or an installed agent CLI for your chosen provider

From the repository directory:

```bash
npm install 
npm run dev
```

The `dev`, `start`, `build`, and distribution commands automatically prepare executable permissions for the `node-pty` spawn helper.

### First session

1. Add a project folder in the app.
2. Sign In or enter OpenRouter API Key in **Settings → Providers**. ACP Agents will automatically detected by default.
3. Enable models in **Settings → Models** as needed.
4. Start a new chat, select a provider and model, and describe your task.

## Connecting agents

| Connection | Setup |
| --- | --- |
| Galaxy | Add an API keys in Providers. This is the default provider and runs the built-in agent without a separate coding agent CLI. |
| Claude Code | Install the `claude` CLI, then sign in through the app or use an existing login. |
| Codex | Install the `codex` CLI, then sign in through the app or use an existing login. |
| OpenCode | Install the `opencode` CLI, then sign in if you need more models. |
| Cursor/Grok | Install the Cursor/Grok CLI, then sign in through the app or use an existing login. |
| Antigravity | Install the `agy` CLI and authenticate your account. This integration uses `agy-acp`, an unofficial adapter which may result in the suspension of your Google account. **Use at your own risk.** |

If a CLI is not detected automatically, set its executable path in the provider settings. ACP model, mode, and other session options come from the connected agent.

Chats remain tied to their initial provider. Start a new chat to use a different provider.

The OpenRouter key also powers chat title generation, image generation, Auto approval, and some editor assistance features like tabs. These features require their own OpenRouter configuration even when using Claude Code or Codex for chat.

Antigravity is an unofficial integration. The app explains the possibility of account restrictions or suspension from third-party adapter access and downloads the adapter when needed.

## Permissions and data

Permission modes include `Ask`, `Auto`, `Accept edits`, and `Full access`. The default is `Auto`, which requires an OpenRouter key for action review. Approval behavior also depends on the connected agent's permission support.

Settings, project lists, conversations, and checkpoints are stored in Electron's `userData` directory. When using APIs or external agents, task context is sent to the corresponding service.

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Run in development mode |
| `npm run typecheck` | Check TypeScript for the main process and renderer |
| `npm run build` | Build the app |
| `npm start` | Preview the built app |
| `npm run icon` | Generate app icons |
| `npm run dist` | Package a macOS app bundle |
| `npm run dist:dmg` | Build a macOS DMG |

Build output goes to `out/`; distribution artifacts go to `release/`. The current macOS packaging configuration does not specify a signing identity.

## Project structure

```text
src/
  main/
    agent/       Conversation execution, approvals, and team management
    engines/     Built-in, Claude, Codex, and ACP engines
    services/    Git, terminal, browser, MCP, and other services
    tools/       Agent tools
  preload/       Electron IPC bridge
  renderer/src/  React UI and state management
  shared/        Shared types, model catalog, and ACP registry
scripts/         Icon generation and runtime preparation
resources/       App resources
```

Built with Electron, React, TypeScript, and electron-vite, with Monaco Editor and xterm.js. Built-in models are defined in `src/shared/models.ts`; ACP connections are defined in `src/shared/acp-registry.ts`.

## License

[MIT](LICENSE) © 2026 galaxysj.  

The built-in Skill Creator skill in `resources/skills/skill-creator` is modified from the skill-creator skill in OpenAI Codex and adapts some writing principles from [anthropics/skills](https://github.com/anthropics/skills). It is distributed under the Apache License 2.0, not under this project's license. See its [LICENSE.txt](resources/skills/skill-creator/LICENSE.txt) and [NOTICE.txt](resources/skills/skill-creator/NOTICE.txt).

