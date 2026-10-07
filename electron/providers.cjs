// Detection only — nothing here installs or downloads anything.
// Used by the boot sequence, the AI provider panel and the Install Manager.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const run = (cmd, args, timeout = 4000) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout).trim());
      });
    } catch {
      resolve(null);
    }
  });

const which = async (cmd) => {
  const out = await run(process.platform === "win32" ? "where" : "which", [cmd]);
  return out ? out.split(/\r?\n/)[0].trim() : null;
};

async function fetchJson(url, timeout = 1500) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

// ------------------------------------------------------- base components ---
// category drives the Install Manager grouping; `required` marks the minimum
// FRIDAY runtime. Everything else is optional and installed on demand.
const COMPONENTS = [
  { id: "node", name: "Node.js", category: "CORE", required: true, cmd: "node", args: ["-v"] },
  { id: "npm", name: "npm", category: "CORE", required: true, cmd: "npm", args: ["-v"] },
  {
    id: "python",
    name: "Python",
    category: "CORE",
    required: true,
    cmd: process.platform === "win32" ? "python" : "python3",
    args: ["--version"],
  },
  { id: "git", name: "Git", category: "DEVELOPER", cmd: "git", args: ["--version"] },
  { id: "gh", name: "GitHub CLI", category: "DEVELOPER", cmd: "gh", args: ["--version"] },
  { id: "cmake", name: "CMake", category: "DEVELOPER", cmd: "cmake", args: ["--version"] },
  { id: "cargo", name: "Rust / Cargo", category: "DEVELOPER", cmd: "cargo", args: ["--version"] },
  { id: "pwsh", name: "PowerShell", category: "AUTOMATION", cmd: "powershell", args: ["-Version"] },
  { id: "7z", name: "7-Zip", category: "OPTIONAL", cmd: "7z", args: ["i"] },
  { id: "ffmpeg", name: "FFmpeg", category: "MEDIA", cmd: "ffmpeg", args: ["-version"] },
  { id: "ollama", name: "Ollama", category: "AI", cmd: "ollama", args: ["--version"] },
  {
    id: "vscode",
    name: "Visual Studio Code",
    category: "DEVELOPER",
    cmd: "code",
    args: ["--version"],
  },
  { id: "n8n", name: "n8n", category: "AUTOMATION", cmd: "n8n", args: ["--version"] },
  { id: "cuda", name: "CUDA Toolkit", category: "AI", cmd: "nvcc", args: ["--version"] },
  {
    id: "nvidia-smi",
    name: "NVIDIA GPU Driver",
    category: "AI",
    cmd: "nvidia-smi",
    args: ["--version"],
  },
  { id: "docker", name: "Docker", category: "OPTIONAL", cmd: "docker", args: ["--version"] },
];

const firstLine = (s) => (s ? s.split(/\r?\n/)[0].trim() : null);

async function detectComponents() {
  const results = await Promise.all(
    COMPONENTS.map(async (c) => {
      const found = await which(c.cmd);
      const version = found ? firstLine(await run(c.cmd, c.args)) : null;
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        required: Boolean(c.required),
        installed: Boolean(found),
        path: found,
        version,
        status: found ? (version ? "ok" : "installed") : "missing",
      };
    }),
  );

  // WebView2 and the VC++ runtime are file/registry checks, not CLI tools.
  if (process.platform === "win32") {
    const vc = exists(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vcruntime140.dll"),
    );
    results.push({
      id: "vcredist",
      name: "Visual C++ Runtime",
      category: "CORE",
      required: true,
      installed: vc,
      path: null,
      version: null,
      status: vc ? "ok" : "missing",
    });
    const webview =
      (await run("reg", [
        "query",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "/v",
        "pv",
      ])) || null;
    results.push({
      id: "webview2",
      name: "WebView2 Runtime",
      category: "CORE",
      required: true,
      installed: Boolean(webview),
      path: null,
      version: webview ? /pv\s+REG_SZ\s+(.+)/i.exec(webview)?.[1] || null : null,
      status: webview ? "ok" : "missing",
    });
  }

  return results;
}

// ---------------------------------------------------------- AI providers ---
async function detectOllama() {
  const bin = await which("ollama");
  const tags = await fetchJson("http://127.0.0.1:11434/api/tags");
  return {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    installed: Boolean(bin || tags),
    path: bin,
    endpoint: "http://127.0.0.1:11434",
    running: Boolean(tags),
    models: (tags?.models || []).map((m) => ({
      id: m.name,
      name: m.name,
      size: m.size ?? null,
      family: m.details?.family ?? null,
      parameters: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      modifiedAt: m.modified_at ?? null,
    })),
    status: tags ? "online" : bin ? "installed" : "missing",
  };
}

async function detectOpenAiCompatible({ id, name, endpoint, endpoints = [] }) {
  const candidates = [...new Set([...(endpoints || []), endpoint].filter(Boolean))];
  let resolvedEndpoint = candidates[0] || endpoint;
  let models = null;
  for (const candidate of candidates) {
    const result = await fetchJson(`${candidate}/v1/models`);
    if (!result) continue;
    resolvedEndpoint = candidate;
    models = result;
    break;
  }
  return {
    id,
    name,
    kind: "local",
    installed: Boolean(models),
    endpoint: resolvedEndpoint,
    running: Boolean(models),
    models: (models?.data || []).map((m) => ({ id: m.id, name: m.id })),
    status: models ? "online" : "offline",
  };
}

/**
 * Cloud providers come from the ONE canonical table in electron/models.cjs so
 * this panel can never drift from what the router can actually call. A
 * provider counts as configured when a key is stored in the workspace key
 * store OR present in the environment — the stored key is what the app really
 * uses, so detection must see it too.
 */
function cloudCatalog() {
  try {
    const { CLOUD } = require("./models.cjs");
    return Object.entries(CLOUD || {}).map(([id, spec]) => ({
      id,
      name: spec.name || id,
      env: spec.env || null,
    }));
  } catch {
    return [];
  }
}

function storedProviderKeys(keyStore) {
  if (!keyStore) return {};
  try {
    const { readKeys } = require("./models.cjs");
    return readKeys(keyStore) || {};
  } catch {
    return {};
  }
}

function detectCloudProviders(env = process.env, keyStore = null) {
  const stored = storedProviderKeys(keyStore);
  return cloudCatalog().map((p) => {
    const hasStored = Boolean(stored[p.id]);
    const hasEnv = Boolean(p.env && env[p.env]);
    const configured = hasStored || hasEnv;
    return {
      id: p.id,
      name: p.name,
      kind: "cloud",
      installed: configured,
      configured,
      keySource: hasStored ? "stored" : hasEnv ? "environment" : null,
      models: [],
      status: configured ? "configured" : "not-configured",
    };
  });
}

async function detectProviders(options = {}) {
  // Back-compat: older callers passed the env object directly.
  const opts =
    options && (options.env || options.keyStore !== undefined) ? options : { env: options };
  const env = opts.env && Object.keys(opts.env).length ? opts.env : process.env;
  const keyStore = opts.keyStore || null;

  const { LOCAL_ENGINES, localEndpointCandidates } = require("./models.cjs");
  const [ollama, ...locals] = await Promise.all([
    detectOllama(),
    ...Object.entries(LOCAL_ENGINES).map(([id, spec]) =>
      detectOpenAiCompatible({
        id,
        name: spec.name,
        endpoint: spec.endpoint,
        endpoints: localEndpointCandidates(id, keyStore),
      }),
    ),
  ]);
  return {
    detectedAt: Date.now(),
    providers: [ollama, ...locals, ...detectCloudProviders(env, keyStore)],
  };
}

/** Ollama model list on demand (never pulls anything). */
async function listOllamaModels() {
  const tags = await fetchJson("http://127.0.0.1:11434/api/tags", 3000);
  return { running: Boolean(tags), models: tags?.models || [] };
}

module.exports = {
  COMPONENTS,
  detectComponents,
  detectProviders,
  detectCloudProviders,
  listOllamaModels,
};
