# Changelog

## 0.1.7

- Write relay defaults with top-level `model_provider` and `model` for current Codex.
- Stop writing legacy relay `[profiles.<name>]` blocks to `config.toml`.
- Generate `<profile>.config.toml` so `codex -p <profile>` continues to work.
- Clean up top-level relay defaults when switching back to ChatGPT login.

## 0.1.6

- Add hover-only delete controls for relay profiles.
- Block deletion of ChatGPT/OpenAI account-login profiles.
- Back up `config.toml` before profile deletion.
- Fix the profile delete confirmation string so the Webview script loads correctly.

## 0.1.5

- Remove the unused Windows wrapper binary and C# source.
- Keep the repository source-only and easier to audit.

## 0.1.4

- Polished README for open-source release.
- Added repository visuals and packaging workflow.
- Kept only the latest VSIX artifact locally.

## 0.1.3

- Always show the native ChatGPT account-login profile in the UI.
- Keep ChatGPT as a reserved profile name.

## 0.1.2

- Treat ChatGPT login as Codex native mode by clearing top-level `profile`.
- Stop writing `profile = "chatgpt"` for newer Codex versions.
- Remove automatic `chatgpt.cliExecutable` override.

## 0.1.0

- Initial minimal VS Code extension.
- Add/edit Codex custom provider profiles.
- Store API keys outside `config.toml`.
- Test `/responses` and fetch `/models`.
