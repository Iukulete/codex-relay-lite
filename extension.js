const cp = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { TextDecoder } = require("util");
const vscode = require("vscode");

const VIEW_ID = "codexRelayLite.view";
const SIMPLE_ID = /^[A-Za-z0-9_-]+$/;
const CHATGPT_PROFILE = "chatgpt";
const SAVED_KEY_MASK = "••••••••••••••••••••••••";

function activate(context) {
  hydrateRelayEnvironmentAtStartup();
  const provider = new RelayViewProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));
  context.subscriptions.push(vscode.commands.registerCommand("codexRelayLite.open", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.codexRelayLite");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("codexRelayLite.refresh", () => {
    provider.refresh();
  }));
}

function deactivate() {}

class RelayViewProvider {
  constructor(context) {
    this.context = context;
    this.webviews = new Set();
  }

  resolveWebviewView(view) {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    this.webviews.add(view.webview);
    view.onDidDispose(() => this.webviews.delete(view.webview));
    bindMessages(view.webview, this.context);
    view.webview.html = renderHtml(view.webview);
    sendState(view.webview, this.context);
  }

  refresh() {
    for (const webview of this.webviews) {
      sendState(webview, this.context);
    }
  }
}

function bindMessages(webview, context) {
  webview.onDidReceiveMessage(async (message) => {
    try {
      if (!message || !message.type) {
        return;
      }
      if (message.type === "ready" || message.type === "refresh") {
        await sendState(webview, context);
        return;
      }
      if (message.type === "saveProvider") {
        const result = await saveProvider(message.provider || {}, context);
        webview.postMessage({ type: "saveResult", result });
        await sendState(webview, context);
        return;
      }
      if (message.type === "applyProfile") {
        const result = await applyProfile(message.profile || "");
        webview.postMessage({ type: "notice", tone: "ready", text: result.message });
        await sendState(webview, context);
        return;
      }
      if (message.type === "deleteProfile") {
        const result = await deleteProfile(message.profile || "", context);
        webview.postMessage({ type: "notice", tone: "ready", text: result.message });
        await sendState(webview, context);
        return;
      }
      if (message.type === "testProvider") {
        const result = await testProvider(message.provider || {}, context);
        webview.postMessage({ type: "testResult", result });
        return;
      }
      if (message.type === "fetchModels") {
        const result = await fetchModels(message.provider || {}, context);
        webview.postMessage({ type: "modelsResult", result });
        return;
      }
      if (message.type === "copyCommand") {
        const profile = normalizeProfileId(message.profile || "");
        const command = profile ? `codex -p ${profile}` : "codex";
        await vscode.env.clipboard.writeText(command);
        webview.postMessage({ type: "notice", tone: "ready", text: "已复制命令：" + command });
        return;
      }
      if (message.type === "openCodex") {
        const profile = normalizeProfileId(message.profile || "");
        const terminalOptions = await terminalOptionsForProfile(profile, context);
        const terminal = vscode.window.createTerminal(terminalOptions);
        terminal.show();
        terminal.sendText(profile ? `codex -p ${profile}` : "codex");
        webview.postMessage({ type: "notice", tone: "ready", text: "已在终端打开 Codex" });
      }
    } catch (error) {
      webview.postMessage({ type: "notice", tone: "error", text: errorMessage(error) });
    }
  });
}

async function sendState(webview, context) {
  const configPath = codexConfigPath();
  let configText = "";
  let configError = "";
  try {
    configText = readTextIfExists(configPath);
  } catch (error) {
    configError = errorMessage(error);
  }
  const profiles = parseProfiles(configText);
  if (!profiles[CHATGPT_PROFILE]) {
    profiles[CHATGPT_PROFILE] = {
      id: CHATGPT_PROFILE,
      model_provider: "openai",
      model: "",
    };
  }
  const providers = parseProviders(configText);
  await hydrateEnvironmentFromSecrets(context, providers);
  const state = {
    configPath,
    configError,
    defaultProfile: parseDefaultProfile(configText),
    profiles,
    providers,
    keyStates: await buildKeyStates(context, providers),
    codexFound: await detectCodex(),
  };
  webview.postMessage({ type: "state", state });
}

function codexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

function hydrateRelayEnvironmentAtStartup() {
  if (process.platform !== "win32") {
    return;
  }
  for (const [name, value] of Object.entries(readAllWindowsRelayEnvironmentSync())) {
    if (!process.env[name] && value) {
      process.env[name] = value;
    }
  }

  let configText = "";
  try {
    configText = readTextIfExists(codexConfigPath());
  } catch {
    return;
  }
  const providers = parseProviders(configText);
  for (const provider of Object.values(providers)) {
    const envKey = provider && provider.env_key;
    if (!envKey || process.env[envKey]) {
      continue;
    }
    const value = readWindowsUserEnvironmentSync(envKey);
    if (value) {
      process.env[envKey] = value;
    }
  }
}

function readAllWindowsRelayEnvironmentSync() {
  const result = {};
  try {
    const stdout = cp.execFileSync("reg", ["query", "HKCU\\Environment"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const match = line.trim().match(/^(CODEX_RELAY_[A-Z0-9_]+_KEY)\s+REG_\S+\s+(.+)$/);
      if (match) {
        result[match[1]] = normalizeApiKey(match[2]);
      }
    }
  } catch {
    return result;
  }
  return result;
}

function readWindowsUserEnvironmentSync(name) {
  if (process.platform !== "win32" || !name) {
    return "";
  }
  try {
    const stdout = cp.execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    const line = String(stdout || "").split(/\r?\n/).find((item) => item.trim().toLowerCase().startsWith(name.toLowerCase() + " "));
    if (!line) {
      return "";
    }
    const match = line.trim().match(/^\S+\s+REG_\S+\s+(.+)$/);
    return match ? normalizeApiKey(match[1]) : "";
  } catch {
    return "";
  }
}

function readTextIfExists(file) {
  try {
    const bytes = fs.readFileSync(file);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw new Error("读取 Codex config 失败：" + errorMessage(error));
  }
}

function assertUtf8Text(text) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "utf8"));
  } catch (error) {
    throw new Error("生成的 Codex config 不是合法 UTF-8：" + errorMessage(error));
  }
}

function parseDefaultProfile(text) {
  const lines = normalizeNewlines(text).split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable === -1 ? lines.length : firstTable;
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line)) {
      continue;
    }
    const match = line.match(/^\s*profile\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }
  }
  return CHATGPT_PROFILE;
}

function parseProfiles(text) {
  const result = {};
  for (const table of parseSimpleTables(text, "profiles")) {
    const data = parseAssignments(table.body);
    result[table.id] = {
      id: table.id,
      model_provider: data.model_provider || "",
      model: data.model || "",
    };
  }
  return result;
}

function parseProviders(text) {
  const result = {};
  for (const table of parseSimpleTables(text, "model_providers")) {
    const data = parseAssignments(table.body);
    result[table.id] = {
      id: table.id,
      name: data.name || table.id,
      base_url: data.base_url || "",
      env_key: data.env_key || "",
      wire_api: data.wire_api || "",
    };
  }
  return result;
}

function parseSimpleTables(text, prefix) {
  const lines = normalizeNewlines(text).split("\n");
  const result = [];
  let current = null;
  for (const line of lines) {
    const header = line.match(/^\s*\[([A-Za-z0-9_]+)\.([A-Za-z0-9_-]+)\]\s*$/);
    if (header) {
      if (current) {
        result.push(current);
      }
      current = header[1] === prefix ? { id: header[2], body: [] } : null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (current) {
        result.push(current);
        current = null;
      }
      continue;
    }
    if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

function parseAssignments(lines) {
  const result = {};
  for (const line of lines || []) {
    if (/^\s*#/.test(line)) {
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) {
      result[match[1]] = match[2];
      continue;
    }
    const bare = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*([^\s#]+)\s*$/);
    if (bare) {
      result[bare[1]] = bare[2];
    }
  }
  return result;
}

async function saveProvider(rawProvider, context) {
  const provider = normalizeProvider(rawProvider);
  const configPath = codexConfigPath();
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });

  if (provider.apiKey) {
    await storeApiKey(context, provider.envKey, provider.apiKey);
    await setUserEnvironment(provider.envKey, provider.apiKey);
  } else {
    await hydrateSingleEnvironment(context, provider.envKey);
  }

  let text = readTextIfExists(configPath);
  backupCodexConfig(configPath);
  text = upsertProviderBlocks(text, provider);
  if (provider.setDefault) {
    text = setDefaultProfile(text, provider.profile);
  }
  assertUtf8Text(text);
  fs.writeFileSync(configPath, text, "utf8");
  readTextIfExists(configPath);
  return {
    ok: true,
    message: "已保存配置：" + provider.profile + "\n模型变更只影响新开的 Codex 线程，已打开的线程可能继续使用旧模型。",
    command: `codex -p ${provider.profile}`,
    envKey: provider.envKey,
  };
}

async function applyProfile(rawProfile) {
  const profile = normalizeProfileId(rawProfile);
  if (!profile) {
    throw new Error("profile 名称只能包含英文、数字、下划线或短横线");
  }
  const configPath = codexConfigPath();
  const text = readTextIfExists(configPath);
  const profiles = parseProfiles(text);
  if (profile !== CHATGPT_PROFILE && !profiles[profile]) {
    throw new Error("未在 Codex config 中找到 profile：" + profile);
  }
  backupCodexConfig(configPath);
  const next = setDefaultProfile(text, profile);
  assertUtf8Text(next);
  fs.writeFileSync(configPath, next, "utf8");
  readTextIfExists(configPath);
  if (profile === CHATGPT_PROFILE) {
    return { ok: true, message: "已切回 ChatGPT 账号登录：已删除顶层 profile 配置。\n请新开 Codex 线程让 Codex 面板读取最新配置。" };
  }
  return { ok: true, message: "已切换默认 profile：" + profile + "\n请新开 Codex 线程让 Codex 面板读取最新 profile。" };
}

async function deleteProfile(rawProfile, context) {
  const profile = normalizeProfileId(rawProfile);
  if (!profile) {
    throw new Error("profile 名称无效");
  }

  const configPath = codexConfigPath();
  const text = readTextIfExists(configPath);
  const profiles = parseProfiles(text);
  const providers = parseProviders(text);
  const selected = profiles[profile];
  if (!selected) {
    throw new Error("未在 Codex config 中找到 profile：" + profile);
  }
  if (profile === CHATGPT_PROFILE || selected.model_provider === "openai") {
    throw new Error("账号登录 profile 不能删除，只能删除中转站 profile");
  }

  const providerId = selected.model_provider || profile;
  const provider = providers[providerId] || providers[profile];
  if (!provider || !provider.base_url) {
    throw new Error("只能删除由中转站配置生成的 profile");
  }

  backupCodexConfig(configPath);

  let next = normalizeNewlines(text);
  next = removeTable(next, "profiles." + profile).trimEnd();

  const providerStillUsed = Object.entries(profiles).some(([id, item]) => {
    if (id === profile) {
      return false;
    }
    return (item.model_provider || "") === providerId;
  });
  if (!providerStillUsed) {
    next = removeTable(next, "model_providers." + providerId).trimEnd();
  }

  if (parseDefaultProfile(text) === profile) {
    next = clearDefaultProfile(next);
  } else {
    next = next.trimEnd() + "\n";
  }

  assertUtf8Text(next);
  fs.writeFileSync(configPath, next, "utf8");
  readTextIfExists(configPath);

  if (context && context.secrets && provider.env_key && !envKeyStillReferenced(next, provider.env_key)) {
    await context.secrets.delete(secretKeyForEnv(provider.env_key));
  }

  return {
    ok: true,
    message: "已删除中转 profile：" + profile + "\n已自动备份 config.toml；账号登录 profile 未受影响。",
  };
}

function envKeyStillReferenced(text, envKey) {
  return Object.values(parseProviders(text)).some((provider) => provider && provider.env_key === envKey);
}

function backupCodexConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return "";
  }
  const backupPath = configPath + ".bak." + timestamp();
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

function normalizeProvider(raw) {
  const profile = normalizeProfileId(raw.profileName || raw.name || "");
  if (!profile) {
    throw new Error("配置名称只能包含英文、数字、下划线或短横线");
  }
  if (profile === CHATGPT_PROFILE) {
    throw new Error("chatgpt 是 Codex 账号登录保留名，不能作为中转站 profile 名称");
  }
  const displayName = String(raw.displayName || raw.profileName || profile).trim() || profile;
  const baseUrl = String(raw.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(raw.model || "").trim();
  const wireApi = "responses";
  if (!baseUrl) {
    throw new Error("请填写 Base URL");
  }
  if (!model) {
    throw new Error("请填写模型名");
  }
  return {
    profile,
    displayName,
    providerKind: String(raw.providerKind || "openai-compatible"),
    baseUrl,
    apiKey: normalizeApiKey(raw.apiKey || ""),
    model,
    wireApi,
    setDefault: Boolean(raw.setDefault),
    envKey: envKeyForProfile(profile),
  };
}

function normalizeProfileId(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\s+/g, "-");
  return SIMPLE_ID.test(normalized) ? normalized : "";
}

function envKeyForProfile(profile) {
  return "CODEX_RELAY_" + profile.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_KEY";
}

function secretKeyForEnv(envKey) {
  return "codexRelayLite.apiKey." + envKey;
}

async function storeApiKey(context, envKey, apiKey) {
  if (!context || !context.secrets || !apiKey) {
    return;
  }
  await context.secrets.store(secretKeyForEnv(envKey), apiKey);
}

async function getStoredApiKey(context, envKey) {
  if (!envKey) {
    return "";
  }
  const fromProcess = normalizeApiKey(process.env[envKey] || "");
  if (fromProcess) {
    return fromProcess;
  }
  if (context && context.secrets) {
    const fromSecret = normalizeApiKey(await context.secrets.get(secretKeyForEnv(envKey)) || "");
    if (fromSecret) {
      process.env[envKey] = fromSecret;
      return fromSecret;
    }
  }
  const fromUserEnv = normalizeApiKey(await readWindowsUserEnvironment(envKey));
  if (fromUserEnv) {
    process.env[envKey] = fromUserEnv;
    if (context && context.secrets) {
      await context.secrets.store(secretKeyForEnv(envKey), fromUserEnv);
    }
    return fromUserEnv;
  }
  return "";
}

async function hydrateSingleEnvironment(context, envKey) {
  await getStoredApiKey(context, envKey);
}

async function hydrateEnvironmentFromSecrets(context, providers) {
  for (const provider of Object.values(providers || {})) {
    if (provider && provider.env_key) {
      await hydrateSingleEnvironment(context, provider.env_key);
    }
  }
}

async function buildKeyStates(context, providers) {
  const result = {};
  for (const provider of Object.values(providers || {})) {
    if (!provider || !provider.env_key) {
      continue;
    }
    const envKey = provider.env_key;
    const processValue = normalizeApiKey(process.env[envKey] || "");
    const secretValue = context && context.secrets ? normalizeApiKey(await context.secrets.get(secretKeyForEnv(envKey)) || "") : "";
    const userEnvValue = processValue || secretValue ? "" : normalizeApiKey(await readWindowsUserEnvironment(envKey));
    const value = processValue || secretValue || userEnvValue;
    if (value) {
      process.env[envKey] = value;
    }
    result[provider.id] = {
      envKey,
      hasKey: Boolean(value),
      length: value.length,
      source: processValue ? "当前进程" : (secretValue ? "插件密钥库" : (userEnvValue ? "Windows 用户环境变量" : "")),
    };
  }
  return result;
}

function readWindowsUserEnvironment(name) {
  return new Promise((resolve) => {
    if (process.platform !== "win32" || !name) {
      resolve("");
      return;
    }
    cp.execFile("reg", ["query", "HKCU\\Environment", "/v", name], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      const line = String(stdout || "").split(/\r?\n/).find((item) => item.trim().toLowerCase().startsWith(name.toLowerCase() + " "));
      if (!line) {
        resolve("");
        return;
      }
      const match = line.trim().match(/^\S+\s+REG_\S+\s+(.+)$/);
      resolve(match ? match[1].trim() : "");
    });
  });
}

function normalizeApiKey(value) {
  let text = String(value || "").trim();
  text = text.replace(/^Authorization\s*:\s*/i, "").trim();
  text = text.replace(/^Bearer\s+/i, "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function upsertProviderBlocks(text, provider) {
  // Conservative TOML editing: only replace the exact simple profile/provider
  // tables managed by this extension, then append fresh blocks at the end.
  let next = normalizeNewlines(text).trimEnd();
  next = removeTable(next, "profiles." + provider.profile).trimEnd();
  next = removeTable(next, "model_providers." + provider.profile).trimEnd();
  const block = [
    `[profiles.${provider.profile}]`,
    `model_provider = "${tomlString(provider.profile)}"`,
    `model = "${tomlString(provider.model)}"`,
    `model_reasoning_effort = "none"`,
    `model_reasoning_summary = "none"`,
    "",
    `[model_providers.${provider.profile}]`,
    `name = "${tomlString(provider.displayName)}"`,
    `base_url = "${tomlString(provider.baseUrl)}"`,
    `env_key = "${tomlString(provider.envKey)}"`,
    `wire_api = "${tomlString(provider.wireApi)}"`,
  ].join("\n");
  return (next ? next + "\n\n" : "") + block + "\n";
}

function removeTable(text, tableName) {
  const lines = normalizeNewlines(text).split("\n");
  const result = [];
  let skipping = false;
  const target = "[" + tableName + "]";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === target) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[[^\]]+\]$/.test(trimmed)) {
      skipping = false;
    }
    if (!skipping) {
      result.push(line);
    }
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

function setDefaultProfile(text, profile) {
  if (profile === CHATGPT_PROFILE) {
    return clearDefaultProfile(text);
  }
  const lines = normalizeNewlines(text).split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable === -1 ? lines.length : firstTable;
  for (let index = 0; index < limit; index += 1) {
    if (!/^\s*#/.test(lines[index]) && /^\s*profile\s*=/.test(lines[index])) {
      lines[index] = `profile = "${tomlString(profile)}"`;
      return lines.join("\n").trimEnd() + "\n";
    }
  }
  return `profile = "${tomlString(profile)}"\n\n` + normalizeNewlines(text).trimStart();
}

function clearDefaultProfile(text) {
  const lines = normalizeNewlines(text).split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable === -1 ? lines.length : firstTable;
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index < limit && !/^\s*#/.test(lines[index]) && /^\s*profile\s*=/.test(lines[index])) {
      continue;
    }
    result.push(lines[index]);
  }
  return result.join("\n").replace(/^\n+/, "").trimEnd() + "\n";
}

function tomlString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeNewlines(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function timestamp() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "-",
    pad(now.getMilliseconds(), 3),
  ].join("");
}

function setUserEnvironment(name, value) {
  return new Promise((resolve, reject) => {
    process.env[name] = value;
    if (process.platform !== "win32") {
      resolve();
      return;
    }
    cp.execFile("setx", [name, value], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve();
    });
  });
}

async function testProvider(rawProvider, context) {
  const provider = normalizeProvider(rawProvider);
  if (provider.apiKey) {
    await storeApiKey(context, provider.envKey, provider.apiKey);
    process.env[provider.envKey] = provider.apiKey;
  }
  const savedApiKey = provider.apiKey ? "" : await getStoredApiKey(context, provider.envKey);
  const apiKey = provider.apiKey || savedApiKey;
  const keySource = provider.apiKey ? "表单输入" : (savedApiKey ? `已保存的 ${provider.envKey}` : "未提供");
  if (!apiKey && !["ollama", "litellm-local"].includes(provider.providerKind)) {
    throw new Error("请填写 API Key，或先保存到环境变量");
  }
  const requests = testRequestsForProvider(provider);
  const failures = [];
  for (const request of requests) {
    const response = await postJson(request.url, request.body, apiKey);
    if (response.statusCode >= 200 && response.statusCode < 300 && isSuccessfulModelResponse(response.json)) {
      return { ok: true, message: `连接成功，${request.label} 返回正常。` + request.note };
    }
    failures.push(`${request.label} HTTP ${response.statusCode}: ` + String(response.body || "").slice(0, 1000) + "\n请求体：" + JSON.stringify(request.body));
  }
  return { ok: false, message: failures.join("\n\n") + "\n\n" + keyDiagnostic(keySource, apiKey) };
}

async function fetchModels(rawProvider, context) {
  const provider = normalizeProviderForModels(rawProvider);
  if (provider.apiKey) {
    await storeApiKey(context, provider.envKey, provider.apiKey);
    process.env[provider.envKey] = provider.apiKey;
  }
  const savedApiKey = provider.apiKey ? "" : await getStoredApiKey(context, provider.envKey);
  const apiKey = provider.apiKey || savedApiKey;
  if (!apiKey && !["ollama", "litellm-local"].includes(provider.providerKind)) {
    throw new Error("请填写 API Key，或先保存到环境变量");
  }
  const response = await getJson(modelsEndpoint(provider.baseUrl), apiKey);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      ok: false,
      models: [],
      message: `GET /models HTTP ${response.statusCode}: ` + String(response.body || "").slice(0, 1000),
    };
  }
  const models = extractModelIds(response.json);
  return {
    ok: models.length > 0,
    models,
    message: models.length ? `已获取 ${models.length} 个模型。` : "请求成功，但没有识别到模型列表。",
  };
}

function normalizeProviderForModels(raw) {
  const profile = normalizeProfileId(raw.profileName || raw.name || "relay");
  const baseUrl = String(raw.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("请填写 Base URL");
  }
  return {
    profile: profile || "relay",
    providerKind: String(raw.providerKind || "openai-compatible"),
    baseUrl,
    apiKey: normalizeApiKey(raw.apiKey || ""),
    envKey: envKeyForProfile(profile || "relay"),
  };
}

function modelsEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base.endsWith("/models") ? base : base + "/models";
}

function extractModelIds(json) {
  const values = [];
  if (Array.isArray(json && json.data)) {
    for (const item of json.data) {
      const id = typeof item === "string" ? item : item && (item.id || item.name || item.model);
      if (id) {
        values.push(String(id));
      }
    }
  } else if (Array.isArray(json && json.models)) {
    for (const item of json.models) {
      const id = typeof item === "string" ? item : item && (item.id || item.name || item.model);
      if (id) {
        values.push(String(id));
      }
    }
  } else if (json && typeof json === "object") {
    for (const key of Object.keys(json)) {
      if (json[key] && typeof json[key] === "object") {
        values.push(key);
      }
    }
  }
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

async function terminalOptionsForProfile(profile, context) {
  const options = {
    name: profile ? `Codex ${profile}` : "Codex",
  };
  if (!profile) {
    return options;
  }
  const text = readTextIfExists(codexConfigPath());
  const profiles = parseProfiles(text);
  const providers = parseProviders(text);
  const selected = profiles[profile];
  const providerId = selected && selected.model_provider ? selected.model_provider : profile;
  const provider = providers[providerId] || providers[profile];
  if (!provider || !provider.env_key) {
    return options;
  }
  const apiKey = await getStoredApiKey(context, provider.env_key);
  if (apiKey) {
    options.env = { [provider.env_key]: apiKey };
  }
  return options;
}

function keyDiagnostic(source, apiKey) {
  const length = String(apiKey || "").length;
  const warning = length > 0 && length <= 12 ? "\n提示：这个长度看起来不像完整中转站 API Key，请确认不是只填了占位符或短 token。" : "";
  return `本次认证来源：${source}，key 长度：${length} 字符。${warning}`;
}

function testRequestsForProvider(provider) {
  return [{
    label: "/responses",
    note: "",
    url: responsesEndpoint(provider.baseUrl),
    body: {
      model: provider.model,
      input: "ping",
      temperature: 0,
      max_output_tokens: 8,
    },
  }];
}

function isSuccessfulModelResponse(json) {
  if (!json || typeof json !== "object") {
    return false;
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const output = Array.isArray(json.output) ? json.output : [];
  return choices.length > 0 || output.length > 0 || typeof json.output_text === "string";
}

function responsesEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base.endsWith("/responses") ? base : base + "/responses";
}

function getJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const headers = {
      "Accept": "application/json",
      "User-Agent": "codex-relay-lite/0.1",
    };
    if (apiKey) {
      headers.Authorization = "Bearer " + apiKey;
    }
    const request = transport.request({
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers,
      timeout: 30000,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1000000) {
          request.destroy(new Error("响应过大"));
        }
      });
      response.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw || "{}");
        } catch (_error) {
          // Keep raw response for diagnostics.
        }
        resolve({ statusCode: response.statusCode || 0, body: raw, json });
      });
    });
    request.on("timeout", () => request.destroy(new Error("获取模型列表超时")));
    request.on("error", reject);
    request.end();
  });
}

function postJson(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Content-Length": String(data.length),
      "User-Agent": "codex-relay-lite/0.1",
    };
    if (apiKey) {
      headers.Authorization = "Bearer " + apiKey;
    }
    const request = transport.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers,
      timeout: 30000,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 200000) {
          request.destroy(new Error("响应过大"));
        }
      });
      response.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw || "{}");
        } catch (_error) {
          // Keep raw response for diagnostics.
        }
        resolve({ statusCode: response.statusCode || 0, body: raw, json });
      });
    });
    request.on("timeout", () => request.destroy(new Error("测试连接超时")));
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

function detectCodex() {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "where" : "which";
    cp.execFile(command, ["codex"], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      resolve({ ok: !error, path: String(stdout || "").split(/\r?\n/).find(Boolean) || "" });
    });
  });
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function renderHtml(webview) {
  const nonce = makeNonce();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Codex Relay Lite</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111315;
      --panel: #171a1d;
      --panel-2: #1d2226;
      --line: #30363d;
      --fg: #e5edf5;
      --muted: #9aa6b2;
      --accent: #38bdf8;
      --accent-2: #1d4f63;
      --danger: #f87171;
      --ready: #4ade80;
      --input: #111418;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      background: var(--vscode-sideBar-background, var(--bg));
      color: var(--vscode-foreground, var(--fg));
      font: 13px/1.5 var(--vscode-font-family, "Segoe UI", sans-serif);
    }
    .shell { max-width: 760px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    h1 { margin: 0; font-size: 21px; }
    h2 { margin: 0 0 10px; font-size: 14px; }
    .sub { margin: 3px 0 0; color: var(--muted); }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-editor-background, var(--panel)) 90%, transparent);
      padding: 12px;
      margin-bottom: 12px;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .status-item {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--panel-2);
      padding: 9px;
      min-width: 0;
    }
    .status-item span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .status-item strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    label { display: block; color: var(--muted); margin: 10px 0 5px; }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--vscode-input-background, var(--input));
      color: var(--vscode-input-foreground, var(--fg));
      padding: 8px 9px;
      outline: none;
      min-height: 34px;
      color-scheme: dark;
    }
    select {
      appearance: none;
      padding-right: 30px;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--muted) 50%),
        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position:
        calc(100% - 16px) 50%,
        calc(100% - 11px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    select option {
      background: var(--vscode-dropdown-background, var(--input));
      color: var(--vscode-dropdown-foreground, var(--fg));
    }
    select option:checked {
      background: color-mix(in srgb, var(--accent) 24%, var(--input));
      color: var(--fg);
    }
    select.native-select {
      display: none;
    }
    input:focus, select:focus { border-color: var(--accent); }
    .selectbox {
      position: relative;
      width: 100%;
    }
    .selectbox-button {
      width: 100%;
      min-height: 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--vscode-input-background, var(--input));
      color: var(--vscode-input-foreground, var(--fg));
      padding: 8px 9px;
      text-align: left;
    }
    .selectbox-button:focus,
    .selectbox.open .selectbox-button {
      outline: none;
      border-color: var(--accent);
    }
    .selectbox-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .selectbox-caret {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 12px;
    }
    .selectbox-menu {
      position: absolute;
      z-index: 35;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 230px;
      overflow: auto;
      border: 1px solid var(--accent);
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--input));
      color: var(--vscode-dropdown-foreground, var(--fg));
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
    }
    .selectbox-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 9px;
      min-height: 30px;
      overflow: hidden;
      cursor: pointer;
    }
    .selectbox-option-label {
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .selectbox-delete {
      flex: 0 0 auto;
      width: 20px;
      height: 20px;
      min-width: 20px;
      padding: 0;
      border-color: transparent;
      background: transparent;
      color: var(--muted);
      opacity: 0;
      line-height: 18px;
    }
    .selectbox-option:hover .selectbox-delete,
    .selectbox-delete:focus {
      opacity: 1;
    }
    .selectbox-delete:hover {
      border-color: color-mix(in srgb, var(--danger) 65%, var(--line));
      color: var(--danger);
      background: color-mix(in srgb, var(--danger) 12%, transparent);
    }
    .selectbox-option:hover,
    .selectbox-option.active {
      background: color-mix(in srgb, var(--accent) 22%, var(--input));
      color: var(--fg);
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px 0;
      color: var(--fg);
    }
    .check input { width: auto; }
    .actions {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--vscode-button-secondaryBackground, #1a2026);
      color: var(--vscode-button-secondaryForeground, var(--fg));
      padding: 8px 10px;
      cursor: pointer;
    }
    button.primary {
      background: var(--vscode-button-background, var(--accent-2));
      color: var(--vscode-button-foreground, #eaf8ff);
      border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
    }
    button:hover { border-color: var(--accent); }
    button:disabled {
      opacity: 0.55;
      cursor: default;
      border-color: var(--line);
    }
    .profile-list {
      display: grid;
      gap: 8px;
    }
    .profile-row {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto auto;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--panel-2);
      padding: 9px 34px 9px 9px;
    }
    .profile-main {
      min-width: 0;
    }
    .profile-title {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .profile-title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .profile-meta {
      color: var(--muted);
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .pill {
      flex: 0 0 auto;
      border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
      border-radius: 999px;
      color: var(--accent);
      padding: 1px 7px;
      font-size: 11px;
      line-height: 18px;
    }
    .pill.current {
      border-color: color-mix(in srgb, var(--ready) 55%, var(--line));
      color: var(--ready);
    }
    .profile-row button {
      min-width: 62px;
      padding: 6px 8px;
    }
    .profile-delete {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 22px;
      height: 22px;
      min-width: 22px;
      padding: 0;
      border-color: transparent;
      border-radius: 50%;
      background: transparent;
      color: var(--muted);
      opacity: 0;
      font-size: 16px;
      line-height: 18px;
      transition: opacity 120ms ease, color 120ms ease, background 120ms ease, border-color 120ms ease;
    }
    .profile-row:hover .profile-delete,
    .profile-delete:focus {
      opacity: 1;
    }
    .profile-delete:hover {
      border-color: color-mix(in srgb, var(--danger) 65%, var(--line));
      color: var(--danger);
      background: color-mix(in srgb, var(--danger) 12%, transparent);
    }
    .field-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 10px 0 5px;
    }
    .field-head label {
      margin: 0;
    }
    .field-spacer {
      width: 74px;
      height: 28px;
      flex: 0 0 74px;
    }
    .mini {
      padding: 4px 8px;
      min-width: 74px;
    }
    .combo {
      position: relative;
    }
    .combo input {
      padding-right: 40px;
    }
    .combo-toggle {
      position: absolute;
      top: 1px;
      right: 1px;
      width: 34px;
      min-width: 34px;
      height: calc(100% - 2px);
      padding: 0;
      border: 0;
      border-left: 1px solid var(--line);
      border-radius: 0 3px 3px 0;
      background: transparent;
      color: var(--muted);
      line-height: 1;
    }
    .combo-toggle:hover {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: var(--fg);
      border-color: var(--line);
    }
    .combo-menu {
      position: absolute;
      z-index: 30;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 220px;
      overflow: auto;
      border: 1px solid var(--accent);
      border-radius: 4px;
      background: var(--vscode-dropdown-background, var(--input));
      color: var(--vscode-dropdown-foreground, var(--fg));
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
    }
    .combo-option {
      padding: 7px 9px;
      min-height: 30px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    .combo-option:hover,
    .combo-option.active {
      background: color-mix(in srgb, var(--accent) 22%, var(--input));
      color: var(--fg);
    }
    .combo-option.empty {
      color: var(--muted);
      cursor: default;
    }
    .notice {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 9px;
      margin-top: 10px;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .notice.ready { border-color: color-mix(in srgb, var(--ready) 55%, var(--line)); color: var(--ready); }
    .notice.error { border-color: color-mix(in srgb, var(--danger) 55%, var(--line)); color: var(--danger); }
    .help {
      color: var(--muted);
      margin: 10px 0 0;
    }
    code { color: var(--accent); }
    @media (max-width: 640px) {
      .status-grid, .row, .actions { grid-template-columns: 1fr; }
      .profile-row { grid-template-columns: 1fr 1fr; }
      .profile-main { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Codex Relay Lite</h1>
        <p class="sub">极简 Codex 中转站配置器</p>
      </div>
      <button id="refreshBtn" type="button">刷新</button>
    </header>

    <section class="card">
      <h2>当前状态</h2>
      <div class="status-grid">
        <div class="status-item"><span>默认 profile</span><strong id="defaultProfile">-</strong></div>
        <div class="status-item"><span>Codex 配置</span><strong id="configPath">-</strong></div>
        <div class="status-item"><span>codex 命令</span><strong id="codexStatus">检测中</strong></div>
      </div>
    </section>

    <section class="card">
      <h2>Profile 切换</h2>
      <div id="profileList" class="profile-list"></div>
      <p class="help">“应用”中转站会写顶层 <code>profile = "..."</code>；“应用”ChatGPT 会删除顶层 profile，让账号登录走 Codex 原生路径。</p>
    </section>

    <section class="card">
      <h2>Provider 设置</h2>
      <label for="existingProfile">读取已有中转 profile</label>
      <select id="existingProfile">
        <option value="">新建配置</option>
      </select>

      <div class="row">
        <div>
          <label for="profileName">配置名称 / profile</label>
          <input id="profileName" value="deepseek" placeholder="joverna" spellcheck="false">
        </div>
        <div>
          <label for="providerKind">API 提供商</label>
          <select id="providerKind">
            <option value="deepseek">DeepSeek</option>
            <option value="openai-compatible">OpenAI Compatible</option>
            <option value="litellm-local">LiteLLM Local</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
      </div>

      <label for="baseUrl">Base URL</label>
      <input id="baseUrl" value="https://api.deepseek.com" placeholder="https://api.deepseek.com" spellcheck="false">

      <label for="apiKey">API Key</label>
      <input id="apiKey" type="password" placeholder="保存到插件密钥库和 Windows 用户环境变量，不写入 config.toml" spellcheck="false">
      <p id="keyHint" class="help">当前表单 key：未填写。</p>

      <div class="row">
        <div>
          <div class="field-head">
            <label for="model">模型</label>
            <button id="fetchModelsBtn" class="mini" type="button">刷新模型</button>
          </div>
          <div id="modelCombo" class="combo">
            <input id="model" value="deepseek-chat" placeholder="deepseek-chat" spellcheck="false" autocomplete="off">
            <button id="modelToggle" class="combo-toggle" type="button" title="选择模型" aria-label="选择模型">⌄</button>
            <div id="modelMenu" class="combo-menu" hidden></div>
          </div>
          <p id="modelHint" class="help">可手填模型名，也可以从中转站拉取列表。</p>
        </div>
        <div class="wire-field">
          <div class="field-head">
            <label for="wireApi">wire_api</label>
            <span class="field-spacer" aria-hidden="true"></span>
          </div>
          <select id="wireApi">
            <option value="responses">responses</option>
          </select>
        </div>
      </div>

      <label class="check">
        <input id="setDefault" type="checkbox">
        设为默认 profile
      </label>

      <div class="actions">
        <button id="testBtn" type="button">测试连接</button>
        <button id="saveBtn" class="primary" type="button">保存配置</button>
        <button id="copyBtn" type="button">复制命令</button>
        <button id="openBtn" type="button">打开 Codex</button>
      </div>

      <div id="notice" class="notice">API Key 会保存到 Windows 用户环境变量；保存前会备份 config.toml。</div>
    </section>

    <section class="card">
      <h2>说明</h2>
      <p class="help">写入格式示例：<code>[profiles.joverna]</code> 和 <code>[model_providers.joverna]</code>。</p>
      <p class="help">不会删除你现有的 <code>chatgpt</code> 账号登录 profile。</p>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let latestState = { profiles: {}, providers: {} };
    let modelOptions = [];
    const customSelects = new Map();

    const defaults = {
      "deepseek": { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", wireApi: "responses" },
      "openai-compatible": { baseUrl: "", model: "", wireApi: "responses" },
      "litellm-local": { baseUrl: "http://127.0.0.1:4000/v1", model: "", wireApi: "responses" },
      "ollama": { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b", wireApi: "responses" },
    };

    function collectProvider() {
      const apiKeyInput = $("apiKey");
      const isSavedMask = apiKeyInput.dataset.savedKey === "1" && apiKeyInput.value === "${SAVED_KEY_MASK}";
      return {
        profileName: $("profileName").value,
        displayName: $("profileName").value,
        providerKind: $("providerKind").value,
        baseUrl: $("baseUrl").value,
        apiKey: isSavedMask ? "" : apiKeyInput.value,
        model: $("model").value,
        wireApi: $("wireApi").value,
        setDefault: $("setDefault").checked,
      };
    }

    function commandProfile() {
      return ($("profileName").value || "").trim().replace(/\\s+/g, "-");
    }

    function notice(text, tone) {
      $("notice").textContent = text || "";
      $("notice").className = "notice " + (tone || "");
    }

    function installCustomSelect(id) {
      const select = $(id);
      if (!select || customSelects.has(id)) {
        return;
      }
      select.classList.add("native-select");
      const root = document.createElement("div");
      root.className = "selectbox";
      root.dataset.select = id;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "selectbox-button";
      button.setAttribute("aria-haspopup", "listbox");

      const value = document.createElement("span");
      value.className = "selectbox-value";
      const caret = document.createElement("span");
      caret.className = "selectbox-caret";
      caret.textContent = "⌄";
      button.appendChild(value);
      button.appendChild(caret);

      const menu = document.createElement("div");
      menu.className = "selectbox-menu";
      menu.hidden = true;

      root.appendChild(button);
      root.appendChild(menu);
      select.insertAdjacentElement("afterend", root);

      customSelects.set(id, { select, root, button, value, menu });

      button.addEventListener("click", () => toggleCustomSelect(id));
      button.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeCustomSelect(id);
        }
        if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCustomSelect(id);
        }
      });
      menu.addEventListener("mousedown", (event) => {
        const deleteButton = event.target.closest(".selectbox-delete[data-profile]");
        if (deleteButton) {
          event.preventDefault();
          event.stopPropagation();
          closeCustomSelect(id);
          requestDeleteProfile(deleteButton.dataset.profile);
          return;
        }
        const item = event.target.closest(".selectbox-option[data-value]");
        if (!item) {
          return;
        }
        event.preventDefault();
        select.value = item.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        refreshCustomSelect(id);
        closeCustomSelect(id);
      });
      select.addEventListener("change", () => refreshCustomSelect(id));
      refreshCustomSelect(id);
    }

    function refreshCustomSelect(id) {
      const item = customSelects.get(id);
      if (!item) {
        return;
      }
      const selected = item.select.selectedOptions && item.select.selectedOptions[0];
      item.value.textContent = selected ? selected.textContent : "";
      item.value.title = selected ? selected.textContent : "";
      item.menu.innerHTML = "";
      for (const option of Array.from(item.select.options)) {
        const row = document.createElement("div");
        row.className = "selectbox-option" + (option.value === item.select.value ? " active" : "");
        row.dataset.value = option.value;
        const label = document.createElement("span");
        label.className = "selectbox-option-label";
        label.textContent = option.textContent;
        row.appendChild(label);
        if (id === "existingProfile" && canDeleteProfile(option.value)) {
          row.appendChild(deleteProfileButton(option.value, "从配置列表删除", "selectbox-delete"));
        }
        item.menu.appendChild(row);
      }
    }

    function openCustomSelect(id) {
      for (const key of customSelects.keys()) {
        if (key !== id) {
          closeCustomSelect(key);
        }
      }
      const item = customSelects.get(id);
      if (!item) {
        return;
      }
      refreshCustomSelect(id);
      item.root.classList.add("open");
      item.menu.hidden = false;
    }

    function closeCustomSelect(id) {
      const item = customSelects.get(id);
      if (!item) {
        return;
      }
      item.root.classList.remove("open");
      item.menu.hidden = true;
    }

    function toggleCustomSelect(id) {
      const item = customSelects.get(id);
      if (!item) {
        return;
      }
      if (item.menu.hidden) {
        openCustomSelect(id);
      } else {
        closeCustomSelect(id);
      }
    }

    function closeAllCustomSelects() {
      for (const id of customSelects.keys()) {
        closeCustomSelect(id);
      }
    }

    function setModelOptions(models) {
      modelOptions = Array.from(new Set((models || []).map((item) => String(item || "").trim()).filter(Boolean)));
      renderModelMenu(false);
      $("modelHint").textContent = models && models.length ? "已加载 " + models.length + " 个模型，可搜索选择。" : "可手填模型名，也可以从中转站拉取列表。";
    }

    function filteredModelOptions() {
      const query = $("model").value.trim().toLowerCase();
      if (!query) {
        return modelOptions;
      }
      return modelOptions.filter((model) => model.toLowerCase().includes(query));
    }

    function renderModelMenu(open) {
      const menu = $("modelMenu");
      if (!menu) {
        return;
      }
      menu.innerHTML = "";
      const options = filteredModelOptions();
      if (!options.length) {
        const empty = document.createElement("div");
        empty.className = "combo-option empty";
        empty.textContent = modelOptions.length ? "没有匹配的模型" : "先点击刷新模型";
        menu.appendChild(empty);
      } else {
        for (const model of options) {
          const item = document.createElement("div");
          item.className = "combo-option" + (model === $("model").value ? " active" : "");
          item.dataset.value = model;
          item.textContent = model;
          menu.appendChild(item);
        }
      }
      menu.hidden = !open;
    }

    function openModelMenu() {
      renderModelMenu(true);
    }

    function closeModelMenu() {
      const menu = $("modelMenu");
      if (menu) {
        menu.hidden = true;
      }
    }

    function chooseModel(model) {
      $("model").value = model;
      closeModelMenu();
      $("model").focus();
    }

    function commandForProfile(profile) {
      const normalized = String(profile || "").trim().replace(/\\s+/g, "-");
      return normalized ? "codex -p " + normalized : "codex";
    }

    function canDeleteProfile(id, state = latestState) {
      if (!id || id === "chatgpt") {
        return false;
      }
      const profile = (state.profiles || {})[id];
      if (!profile || (profile.model_provider || "") === "openai") {
        return false;
      }
      const providerId = profile.model_provider || id;
      const provider = (state.providers || {})[providerId] || (state.providers || {})[id] || {};
      return Boolean(provider.base_url);
    }

    function deleteProfileButton(profile, title, className = "profile-delete") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = "×";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.dataset.profile = profile;
      if (className === "profile-delete") {
        button.dataset.action = "delete";
      }
      return button;
    }

    function requestDeleteProfile(profile) {
      if (!canDeleteProfile(profile)) {
        notice("账号登录 profile 不能删除，只能删除中转站 profile。", "error");
        return;
      }
      const ok = confirm("删除中转 profile：" + profile + "\n\n会从 config.toml 删除对应 [profiles] / [model_providers] 块，并自动备份。");
      if (!ok) {
        return;
      }
      notice("正在删除 profile：" + profile, "");
      vscode.postMessage({ type: "deleteProfile", profile });
    }

    function updateKeyHint() {
      const input = $("apiKey");
      if (input.dataset.savedKey === "1" && input.value === "${SAVED_KEY_MASK}") {
        const source = input.dataset.keySource || "已保存";
        const length = input.dataset.keyLength || "?";
        $("keyHint").textContent = "API Key 已保存（" + source + "，" + length + " 字符），不会写入 config.toml。";
        return;
      }
      const raw = input.value || "";
      const normalized = raw.trim().replace(/^Authorization\\s*:\\s*/i, "").replace(/^Bearer\\s+/i, "").trim();
      $("keyHint").textContent = normalized ? "当前表单 key 长度：" + normalized.length + " 字符。" : "当前表单 key：未填写。";
    }

    function inferProviderKind(baseUrl) {
      const text = String(baseUrl || "").toLowerCase();
      if (text.startsWith("https://api.deepseek.com")) return "deepseek";
      if (text.startsWith("http://127.0.0.1:4000") || text.startsWith("http://localhost:4000")) return "litellm-local";
      if (text.startsWith("http://127.0.0.1:11434") || text.startsWith("http://localhost:11434")) return "ollama";
      return "openai-compatible";
    }

    function populateExistingProfiles(state) {
      const select = $("existingProfile");
      const current = select.value;
      select.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "新建配置";
      select.appendChild(empty);
      const profiles = Object.keys(state.profiles || {}).sort();
      for (const id of profiles) {
        const profile = state.profiles[id] || {};
        const provider = (state.providers || {})[profile.model_provider] || (state.providers || {})[id] || {};
        if (!provider.base_url) {
          continue;
        }
        const option = document.createElement("option");
        option.value = id;
        option.textContent = provider.base_url ? id + " · " + provider.base_url : id;
        select.appendChild(option);
      }
      select.value = profiles.includes(current) ? current : "";
      refreshCustomSelect("existingProfile");
    }

    function renderProfileList(state) {
      const list = $("profileList");
      list.innerHTML = "";
      const profiles = Object.keys(state.profiles || {}).sort((a, b) => {
        if (a === state.defaultProfile) return -1;
        if (b === state.defaultProfile) return 1;
        if (a === "chatgpt") return -1;
        if (b === "chatgpt") return 1;
        return a.localeCompare(b);
      });
      if (!profiles.length) {
        const empty = document.createElement("div");
        empty.className = "notice";
        empty.textContent = "还没有读取到 Codex profile。";
        list.appendChild(empty);
        return;
      }
      for (const id of profiles) {
        const profile = state.profiles[id] || {};
        const providerId = profile.model_provider || "";
        const provider = (state.providers || {})[providerId] || (state.providers || {})[id] || {};
        const row = document.createElement("div");
        row.className = "profile-row";

        const main = document.createElement("div");
        main.className = "profile-main";

        const title = document.createElement("div");
        title.className = "profile-title";
        const name = document.createElement("strong");
        name.textContent = id;
        title.appendChild(name);

        if (id === state.defaultProfile) {
          const current = document.createElement("span");
          current.className = "pill current";
          current.textContent = "当前";
          title.appendChild(current);
        }

        const kind = document.createElement("span");
        kind.className = "pill";
        kind.textContent = profileKind(profile, provider);
        title.appendChild(kind);

        const keyState = (state.keyStates || {})[providerId] || (state.keyStates || {})[id] || {};
        if (provider && provider.base_url) {
          const key = document.createElement("span");
          key.className = "pill" + (keyState.hasKey ? " current" : "");
          key.textContent = keyState.hasKey ? "Key 已存" : "缺 Key";
          title.appendChild(key);
        }

        const meta = document.createElement("div");
        meta.className = "profile-meta";
        meta.textContent = profileSummary(profile, provider, keyState);

        main.appendChild(title);
        main.appendChild(meta);
        row.appendChild(main);

        row.appendChild(profileButton("应用", "apply", id, id === state.defaultProfile));
        row.appendChild(profileButton("复制", "copy", id, false));
        row.appendChild(profileButton("打开", "open", id, false));
        row.appendChild(profileButton("编辑", "edit", id, !provider.base_url));
        if (canDeleteProfile(id, state)) {
          row.appendChild(deleteProfileButton(id, "删除这个中转 profile"));
        }
        list.appendChild(row);
      }
    }

    function profileKind(profile, provider) {
      if ((profile.model_provider || "") === "openai") return "账号";
      if (provider && provider.base_url) return "中转";
      return "profile";
    }

    function profileSummary(profile, provider, keyState) {
      const model = profile.model ? "模型 " + profile.model : "未指定模型";
      if ((profile.model_provider || "") === "openai") {
        return model + " · ChatGPT/OpenAI 账号登录";
      }
      if (provider && provider.base_url) {
        const keyText = keyState && keyState.hasKey ? " · Key " + keyState.source : " · 缺少 " + (provider.env_key || "env_key");
        return model + " · " + provider.base_url + " · " + (provider.wire_api || "responses") + keyText;
      }
      return model + " · provider " + (profile.model_provider || "未指定");
    }

    function profileButton(text, action, profile, disabled) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.dataset.action = action;
      button.dataset.profile = profile;
      button.disabled = Boolean(disabled);
      return button;
    }

    function fillFromExistingProfile(id) {
      if (!id) return;
      const profile = (latestState.profiles || {})[id] || {};
      const providerId = profile.model_provider || id;
      const provider = (latestState.providers || {})[providerId] || (latestState.providers || {})[id] || {};
      const keyState = (latestState.keyStates || {})[providerId] || (latestState.keyStates || {})[id] || {};
      $("profileName").value = id;
      $("providerKind").value = inferProviderKind(provider.base_url);
      refreshCustomSelect("providerKind");
      $("baseUrl").value = provider.base_url || "";
      $("model").value = profile.model || "";
      setModelOptions(profile.model ? [profile.model] : []);
      $("wireApi").value = "responses";
      refreshCustomSelect("wireApi");
      $("setDefault").checked = latestState.defaultProfile === id;
      $("apiKey").dataset.savedKey = keyState.hasKey ? "1" : "0";
      $("apiKey").dataset.keyLength = keyState.length || "";
      $("apiKey").dataset.keySource = keyState.source || "";
      $("apiKey").value = keyState.hasKey ? "${SAVED_KEY_MASK}" : "";
      updateKeyHint();
      notice("已载入 " + id + (keyState.hasKey ? "；API Key 已保存，不会明文回显。" : "；尚未找到 API Key。"), keyState.hasKey ? "ready" : "");
    }

    $("apiKey").addEventListener("input", () => {
      if ($("apiKey").value !== "${SAVED_KEY_MASK}") {
        $("apiKey").dataset.savedKey = "0";
        $("apiKey").dataset.keyLength = "";
        $("apiKey").dataset.keySource = "";
      }
      updateKeyHint();
    });
    $("profileList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button || button.disabled) return;
      const action = button.dataset.action;
      const profile = button.dataset.profile;
      if (action === "apply") {
        notice("正在切换默认 profile：" + profile, "");
        vscode.postMessage({ type: "applyProfile", profile });
      } else if (action === "copy") {
        vscode.postMessage({ type: "copyCommand", profile });
      } else if (action === "open") {
        vscode.postMessage({ type: "openCodex", profile });
      } else if (action === "edit") {
        $("existingProfile").value = profile;
        fillFromExistingProfile(profile);
      } else if (action === "delete") {
        requestDeleteProfile(profile);
      }
    });
    $("existingProfile").addEventListener("change", () => fillFromExistingProfile($("existingProfile").value));
    $("model").addEventListener("input", () => {
      if (modelOptions.length) {
        openModelMenu();
      }
    });
    $("model").addEventListener("focus", () => {
      if (modelOptions.length) {
        openModelMenu();
      }
    });
    $("model").addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModelMenu();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openModelMenu();
      }
    });
    $("modelToggle").addEventListener("click", () => {
      if ($("modelMenu").hidden) {
        openModelMenu();
        $("model").focus();
      } else {
        closeModelMenu();
      }
    });
    $("modelMenu").addEventListener("mousedown", (event) => {
      const item = event.target.closest(".combo-option[data-value]");
      if (!item) {
        return;
      }
      event.preventDefault();
      chooseModel(item.dataset.value);
    });
    document.addEventListener("mousedown", (event) => {
      if (!event.target.closest("#modelCombo")) {
        closeModelMenu();
      }
      if (!event.target.closest(".selectbox")) {
        closeAllCustomSelects();
      }
    });
    $("providerKind").addEventListener("change", () => {
      const preset = defaults[$("providerKind").value];
      if (!preset) return;
      $("baseUrl").value = preset.baseUrl;
      $("model").value = preset.model;
      setModelOptions(preset.model ? [preset.model] : []);
      $("wireApi").value = preset.wireApi;
      refreshCustomSelect("wireApi");
      $("apiKey").dataset.savedKey = "0";
      $("apiKey").dataset.keyLength = "";
      $("apiKey").dataset.keySource = "";
      $("apiKey").value = "";
      updateKeyHint();
    });
    $("refreshBtn").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    $("testBtn").addEventListener("click", () => {
      notice("正在测试连接...", "");
      vscode.postMessage({ type: "testProvider", provider: collectProvider() });
    });
    $("fetchModelsBtn").addEventListener("click", () => {
      $("modelHint").textContent = "正在获取模型列表...";
      vscode.postMessage({ type: "fetchModels", provider: collectProvider() });
    });
    $("saveBtn").addEventListener("click", () => {
      notice("正在保存配置...", "");
      vscode.postMessage({ type: "saveProvider", provider: collectProvider() });
    });
    $("copyBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "copyCommand", profile: commandProfile() });
    });
    $("openBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "openCodex", profile: commandProfile() });
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "state") {
        const state = message.state || {};
        latestState = state;
        populateExistingProfiles(state);
        renderProfileList(state);
        $("defaultProfile").textContent = state.defaultProfile || "未设置";
        $("configPath").textContent = state.configPath || "-";
        $("configPath").title = state.configPath || "";
        $("codexStatus").textContent = state.codexFound && state.codexFound.ok ? "已检测到" : "未检测到";
        $("codexStatus").title = state.codexFound && state.codexFound.path ? state.codexFound.path : "";
        if (state.configError) {
          notice(state.configError, "error");
        }
      }
      if (message.type === "saveResult") {
        const result = message.result || {};
        notice((result.message || "已保存") + (result.command ? "\\n" + result.command : ""), result.ok ? "ready" : "error");
      }
      if (message.type === "testResult") {
        const result = message.result || {};
        notice(result.message || (result.ok ? "连接成功" : "连接失败"), result.ok ? "ready" : "error");
      }
      if (message.type === "modelsResult") {
        const result = message.result || {};
        if (result.ok) {
          setModelOptions(result.models || []);
          notice(result.message || "已获取模型列表。", "ready");
        } else {
          setModelOptions([]);
          notice(result.message || "获取模型列表失败。", "error");
        }
      }
      if (message.type === "notice") {
        notice(message.text || "", message.tone || "");
      }
    });

    installCustomSelect("existingProfile");
    installCustomSelect("providerKind");
    installCustomSelect("wireApi");
    vscode.postMessage({ type: "ready" });
    updateKeyHint();
  </script>
</body>
</html>`;
}

function makeNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return text;
}

module.exports = {
  activate,
  deactivate,
};
