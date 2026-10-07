/**
 * FRIDAY · Flow Studio registry.
 *
 * One scan of the checkout. docs:sync writes the generated module.
 * The canvas reads that module. It does not scan the disk again.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = "src/lib/friday/flow-registry.gen.ts";

const STRUCTURES = [
  { id: "voice.wake", label: "Wake", module: "electron/wake-engine.cjs", group: "voice" },
  { id: "voice.stt", label: "Speech to text", module: "kernel/stt.py", group: "voice" },
  { id: "voice.vad", label: "Voice runtime", module: "kernel/voice_runtime.py", group: "voice" },
  {
    id: "voice.session",
    label: "Voice session",
    module: "src/lib/friday/voice-session.ts",
    group: "voice",
  },
  { id: "voice.speak", label: "Speech", module: "electron/neural-voice.cjs", group: "voice" },
  {
    id: "auto.mode",
    label: "Manual and Auto",
    module: "src/lib/friday/assistant-mode.ts",
    group: "auto",
  },
  {
    id: "privacy.firewall",
    label: "Privacy firewall",
    module: "electron/privacy-firewall.cjs",
    group: "privacy",
  },
  {
    id: "billing.firewall",
    label: "Billing firewall",
    module: "electron/billing-firewall.cjs",
    group: "billing",
  },
  {
    id: "memory.fabric",
    label: "Memory fabric",
    module: "src/lib/friday/brain/memory-fabric.ts",
    group: "memory",
  },
  {
    id: "memory.engine",
    label: "Memory store",
    module: "src/lib/friday/self/memory-engine.ts",
    group: "memory",
  },
  { id: "storage.db", label: "Local database", module: "kernel/db.py", group: "storage" },
  {
    id: "notify.bus",
    label: "Notifications",
    module: "src/lib/friday/notifications.ts",
    group: "notification",
  },
  { id: "route.models", label: "Model router", module: "kernel/router.py", group: "routing" },
  {
    id: "workflow.engine",
    label: "Workflow engine",
    module: "src/lib/friday/brain/workflow-forge.ts",
    group: "workflow",
  },
  {
    id: "update.safety",
    label: "Update safety",
    module: "electron/update-safety.cjs",
    group: "install",
  },
  {
    id: "doctor.engine",
    label: "Doctor",
    module: "src/lib/friday/doctor-engine.ts",
    group: "doctor",
  },
  {
    id: "governance.queue",
    label: "Approval queue",
    module: "src/lib/friday/self/governance.ts",
    group: "governance",
  },
];

const CAPABILITY_TREES = ["skills", "tools", "agents", "plugins", "modules", "workflows"];
const KIND = {
  skills: "skill",
  tools: "tool",
  agents: "agent",
  plugins: "plugin",
  modules: "module",
  workflows: "workflow",
};
const SKIP_DIR = new Set(["node_modules", ".git", "__pycache__", "tests"]);
const SKIP_JSON = new Set(["package.json", "tsconfig.json", "jsconfig.json"]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(rel, accept) {
  const out = [];
  const base = path.join(ROOT, rel);
  if (!fs.existsSync(base)) return out;
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIR.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (accept(entry.name, full))
        out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  };
  visit(base);
  return out.sort();
}

function keysAtIndent(source, marker, indent) {
  const at = source.indexOf(marker);
  if (at < 0) return [];
  const brace = source.indexOf("{", at);
  if (brace < 0) return [];
  let depth = 0;
  let end = brace;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(brace + 1, end);
  const pad = " ".repeat(indent);
  const keys = [];
  for (const line of body.split("\n")) {
    const match = new RegExp(`^${pad}([A-Za-z_][A-Za-z0-9_]*)\\s*:`).exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}

function preferenceKeys(source) {
  const start = source.indexOf("export const DEFAULT_PREFERENCES");
  const slice = start < 0 ? source : source.slice(start);
  const toggles = keysAtIndent(slice, "toggles:", 4);
  const fields = keysAtIndent(slice, "fields:", 4);
  const voice = keysAtIndent(slice, "voice:", 4);
  return [
    "theme",
    ...toggles.map((key) => `toggles.${key}`),
    ...fields.map((key) => `fields.${key}`),
    ...voice.map((key) => `voice.${key}`),
  ].sort();
}

function featureMap(source) {
  const start = source.indexOf("export const FLOW_PAGE_FEATURES");
  const slice = start < 0 ? "" : source.slice(start, source.indexOf("};", start));
  const map = {};
  const re = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
  let match = re.exec(slice);
  while (match) {
    map[match[1]] = match[2];
    match = re.exec(slice);
  }
  return map;
}

function exemptions(source) {
  const start = source.indexOf("export const ROUTE_FLOW_EXEMPTIONS");
  if (start < 0) return [];
  const slice = source.slice(start, source.indexOf("];", start));
  const out = [];
  const re = /path:\s*["']([^"']+)["'][\s\S]*?reason:\s*["']([^"']+)["']/g;
  let match = re.exec(slice);
  while (match) {
    out.push({ path: match[1], reason: match[2] });
    match = re.exec(slice);
  }
  return out;
}

function routesFrom(file, text) {
  const out = [];
  const re = /createFileRoute\(\s*["']([^"']+)["']\s*\)/g;
  let match = re.exec(text);
  while (match) {
    out.push({ path: match[1], file });
    match = re.exec(text);
  }
  return out;
}

function channelsFrom(file, text) {
  const out = [];
  const re = /(?:ipcRenderer|ipcMain)\.(?:invoke|send|handle|on)\(\s*["']([^"']+)["']/g;
  let match = re.exec(text);
  while (match) {
    out.push({ channel: match[1], file });
    match = re.exec(text);
  }
  return out;
}

function joinRoute(prefix, route) {
  if (!prefix) return route || "/";
  if (route === "") return prefix;
  if (!route || route === "/") return prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${prefix.replace(/\/$/, "")}/${String(route).replace(/^\//, "")}`;
}

function kernelFrom(file, text) {
  const prefix = /APIRouter\(\s*prefix\s*=\s*["']([^"']*)["']/.exec(text)?.[1] || "";
  const routes = [];
  const re = /@(app|router)\.(get|post|put|delete|patch|websocket)\(\s*["']([^"']*)["']/g;
  let match = re.exec(text);
  while (match) {
    const raw = match[3];
    const pathName = match[1] === "app" ? raw || "/" : joinRoute(prefix, raw);
    routes.push({ method: match[2].toUpperCase(), path: pathName, file });
    match = re.exec(text);
  }
  const messages = [];
  const kinds = /kind == ["']([^"']+)["']/g;
  let kind = kinds.exec(text);
  while (kind) {
    messages.push({ kind: kind[1], file });
    kind = kinds.exec(text);
  }
  return { routes, messages };
}

function connectorIds(text) {
  const start = text.indexOf("const CONNECTORS = {");
  if (start < 0) return [];
  const ids = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.startsWith("};") || line === "}") break;
    const match = /^ {2}([A-Za-z0-9_-]+): \{$/.exec(line);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

function catalogModels(text) {
  const out = [];
  const re = /\bM\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
  let match = re.exec(text);
  while (match) {
    out.push({ id: match[1], name: match[2] });
    match = re.exec(text);
  }
  return out;
}

function topKeys(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return [];
  const ids = [];
  for (const line of text.slice(at).split("\n").slice(1)) {
    if (line.startsWith("};") || line === "}") break;
    const match = /^ {2}([A-Za-z0-9_-]+): \{$/.exec(line);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

function capabilities() {
  const rows = [];
  for (const tree of CAPABILITY_TREES) {
    const files = walk(tree, (name) => name.endsWith(".json") && !SKIP_JSON.has(name));
    for (const file of files) {
      let name = path.posix.basename(file, ".json");
      try {
        const parsed = JSON.parse(read(file));
        if (parsed && typeof parsed.name === "string" && parsed.name.trim())
          name = parsed.name.trim();
      } catch {
        name = path.posix.basename(file, ".json");
      }
      rows.push({
        id: file.replace(/\.json$/, ""),
        kind: KIND[tree] || "module",
        name,
        file,
      });
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function buildRegistry(root = ROOT) {
  void root;
  const routeFiles = walk("src/routes", (name) => name.endsWith(".tsx"));
  const routes = [];
  for (const file of routeFiles) routes.push(...routesFrom(file, read(file)));
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.file.localeCompare(b.file));

  const adapters = read("src/lib/friday/flow-adapters.ts");
  const features = featureMap(adapters);
  const exempt = exemptions(adapters);
  const exemptPaths = new Set(exempt.map((item) => item.path));
  const missingRoutes = routes
    .map((item) => item.path)
    .filter((item) => !features[item] && !exemptPaths.has(item));

  const electronFiles = walk("electron", (name) => name.endsWith(".cjs"));
  const ipcSeen = new Map();
  for (const file of electronFiles) {
    for (const hit of channelsFrom(file, read(file))) {
      if (!ipcSeen.has(hit.channel)) ipcSeen.set(hit.channel, hit.file);
    }
  }
  const ipc = [...ipcSeen.entries()]
    .map(([channel, file]) => ({ channel, file }))
    .sort((a, b) => a.channel.localeCompare(b.channel));

  const pyFiles = walk("kernel", (name) => name.endsWith(".py"));
  const kernel = [];
  const messageSeen = new Map();
  for (const file of pyFiles) {
    const parsed = kernelFrom(file, read(file));
    kernel.push(...parsed.routes);
    for (const message of parsed.messages) {
      if (!messageSeen.has(message.kind)) messageSeen.set(message.kind, message.file);
    }
  }
  kernel.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const messages = [...messageSeen.entries()]
    .map(([kind, file]) => ({ kind, file }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  const workflows = walk(
    ".github/workflows",
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  ).map((file) => file.slice(file.lastIndexOf("/") + 1).replace(/\.ya?ml$/, ""));
  workflows.sort();

  const connectors = connectorIds(read("electron/connectors.cjs"))
    .map((id) => ({ id, file: "electron/connectors.cjs" }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const models = catalogModels(read("src/lib/friday/model-catalog.ts")).map((item) => ({
    id: item.id,
    kind: "model",
    name: item.name,
    file: "src/lib/friday/model-catalog.ts",
  }));
  const modelText = read("electron/models.cjs");
  for (const id of [
    ...topKeys(modelText, "const CLOUD = {"),
    ...topKeys(modelText, "const LOCAL_ENGINES = {"),
  ]) {
    models.push({
      id: `provider.${id}`,
      kind: "model",
      name: id,
      file: "electron/models.cjs",
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  const packs = capabilities();
  const capabilityRows = [
    ...packs,
    ...connectors.map((item) => ({
      id: `connector.${item.id}`,
      kind: "connector",
      name: item.id,
      file: item.file,
    })),
    ...models,
  ].sort((a, b) => a.id.localeCompare(b.id));

  const options = preferenceKeys(read("src/lib/friday/preferences.ts"));
  const structures = STRUCTURES.map((item) => ({
    ...item,
    present: fs.existsSync(path.join(ROOT, item.module)),
  }));

  const routeMapped = routes.length - missingRoutes.length;
  return {
    routes: routes.map((item) => ({
      path: item.path,
      feature: features[item.path] || "",
      file: item.file,
      exempt: exemptPaths.has(item.path),
    })),
    exemptions: exempt,
    missingRoutes,
    options,
    ipc,
    kernel,
    messages,
    workflows,
    capabilities: capabilityRows,
    structures,
    counts: {
      routes: { mapped: routeMapped, total: routes.length },
      options: { mapped: options.length, total: options.length },
      capabilities: { mapped: capabilityRows.length, total: capabilityRows.length },
      ipc: { mapped: ipc.length, total: ipc.length },
      kernel: { mapped: kernel.length, total: kernel.length },
      workflows: { mapped: workflows.length, total: workflows.length },
    },
  };
}

const TYPE =
  "{ routes: { path: string; feature: string; file: string; exempt: boolean }[]; exemptions: { path: string; reason: string }[]; missingRoutes: string[]; options: string[]; ipc: { channel: string; file: string }[]; kernel: { method: string; path: string; file: string }[]; messages: { kind: string; file: string }[]; workflows: string[]; capabilities: { id: string; kind: string; name: string; file: string }[]; structures: { id: string; label: string; module: string; group: string; present: boolean }[]; counts: { routes: { mapped: number; total: number }; options: { mapped: number; total: number }; capabilities: { mapped: number; total: number }; ipc: { mapped: number; total: number }; kernel: { mapped: number; total: number }; workflows: { mapped: number; total: number } } }";

function render(registry) {
  return `/**\n * Generated by scripts/flow-registry.cjs. Do not edit by hand.\n */\nexport const FLOW_REGISTRY = ${JSON.stringify(registry, null, 2)} as ${TYPE};\n`;
}

function writeRegistry() {
  const registry = buildRegistry();
  const file = path.join(ROOT, OUT);
  fs.writeFileSync(file, render(registry));
  const bin = path.join(ROOT, "node_modules", "prettier", "bin", "prettier.cjs");
  if (fs.existsSync(bin)) {
    spawnSync(process.execPath, [bin, "--write", file], { cwd: ROOT, stdio: "ignore" });
  }
  return registry;
}

function readGenerated() {
  const script = `
    import { FLOW_REGISTRY } from "./src/lib/friday/flow-registry.gen.ts";
    process.stdout.write(JSON.stringify(FLOW_REGISTRY));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "Could not read the generated flow registry.");
  }
  return JSON.parse(result.stdout);
}

function registryStale() {
  if (!fs.existsSync(path.join(ROOT, OUT))) return true;
  const fresh = buildRegistry();
  const saved = readGenerated();
  return JSON.stringify(fresh) !== JSON.stringify(saved);
}

module.exports = {
  ROOT,
  OUT,
  STRUCTURES,
  buildRegistry,
  writeRegistry,
  readGenerated,
  registryStale,
};

if (require.main === module) {
  const registry = writeRegistry();
  console.log(
    `flow registry: routes ${registry.counts.routes.mapped}/${registry.counts.routes.total}, options ${registry.counts.options.mapped}/${registry.counts.options.total}, capabilities ${registry.counts.capabilities.mapped}/${registry.counts.capabilities.total}, ipc ${registry.counts.ipc.mapped}/${registry.counts.ipc.total}, kernel ${registry.counts.kernel.mapped}/${registry.counts.kernel.total}, workflows ${registry.counts.workflows.mapped}/${registry.counts.workflows.total}`,
  );
  if (registry.missingRoutes.length) {
    console.log(`missing routes: ${registry.missingRoutes.join(", ")}`);
    process.exitCode = 1;
  }
  if (registry.structures.some((item) => !item.present)) {
    console.log(
      `missing structure files: ${registry.structures
        .filter((item) => !item.present)
        .map((item) => item.module)
        .join(", ")}`,
    );
    process.exitCode = 1;
  }
}
