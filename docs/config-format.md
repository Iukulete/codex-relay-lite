# Codex 配置格式

Codex Relay Lite 写入 `~/.codex/config.toml` 的格式如下：

```toml
[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com"
env_key = "CODEX_RELAY_DEEPSEEK_KEY"
wire_api = "responses"
```

如果勾选“设为默认中转站”，会写入或更新顶层：

```toml
model_provider = "deepseek"
model = "deepseek-chat"
```

同时会生成 `~/.codex/deepseek.config.toml`，用于 `codex -p deepseek`：

```toml
model_provider = "deepseek"
model = "deepseek-chat"
model_reasoning_effort = "none"
model_reasoning_summary = "none"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com"
env_key = "CODEX_RELAY_DEEPSEEK_KEY"
wire_api = "responses"
```

切回 ChatGPT 账号登录时不会写入 `profile = "chatgpt"`。Codex Relay Lite 会清理顶层 `profile`、`model_provider` 和 `model`，让 Codex 使用账号登录的原生默认路径。

## 安全策略

- API Key 不写入 `config.toml`。
- Windows 上使用用户环境变量保存，例如 `CODEX_RELAY_DEEPSEEK_KEY`。
- 每次保存前备份原配置：`config.toml.bak.<timestamp>`。
- 每次保存 profile 文件前备份原配置：`<profile>.config.toml.bak.<timestamp>`。
- 不删除原有 `chatgpt`、`api` 或其他 profile。
- `chatgpt` 是账号登录保留名，不能作为中转站 profile 名称。

## 约束

当前版本只处理简单 profile 名：英文字母、数字、下划线和短横线。复杂 TOML 表名、跨文件 include、注释保留位置不做完整解析。旧版本生成的 `[profiles.<name>]` 会在重新保存同名中转站时被移除。
