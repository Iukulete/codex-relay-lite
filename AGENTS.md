# Codex Relay Lite

This repository is now a small VS Code extension for editing Codex CLI relay
profiles.

## Scope

- Build only a Codex provider/profile editor.
- Do not add a backend service, proxy server, MCP integration, account system,
  assistant orchestration UI, or cloud sync.
- Keep the UI Chinese-first and Windows-friendly.

## Safety

- Never write API keys into `~/.codex/config.toml`.
- Back up `config.toml` before modifying it.
- Preserve existing ChatGPT/account-login profiles.
- Keep TOML edits conservative and easy to inspect.
