// FRIDAY · connectivity graph.
//
// One canonical answer to "is every feature actually wired to FRIDAY?".
//
// The graph is derived from real files on disk — nothing is declared by hand,
// so a feature added tomorrow appears here automatically:
//
//   main handler (ipcMain.handle/on)  ->  preload bridge key  ->  renderer call
//   kernel dispatch method            ->  kernelCall / bridge call site
//   route file                        ->  sidebar navigation entry
//   capability tree folder            ->  discovery source
//
// Any link that is missing on one side is reported as an issue, which is what
// keeps FRIDAY connected as the project grows: the same scan runs in the
// desktop app (IPC + watcher refresh) and in the test suite (drift guard).
const fs = require("fs");
const path = require("path");

const SCHEMA = 1;
const CACHE_FILE = path.join("database", "connectivity-graph.json");

const SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs"]);

const norm = (p) => String(p || "").replace(/\\/g, "/");

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Every source file under a folder (shallow-safe, skips node_modules/dist). */
function collect(root, rel, out = []) {
  const dir = path.join(root, rel);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (/^(node_modules|dist|dist-desktop|release|__pycache__|\.)/.test(entry.name)) continue;
      collect(root, child, out);
    } else if (SRC_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(norm(child));
    }
  }
  return out;
}

function matchAll(text, regex, group = 1) {
  const found = [];
  let m;
  const rx = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  while ((m = rx.exec(text))) if (m[group]) found.push(m[group]);
  return found;
}

/* ------------------------------------------------------------------ IPC */

const HANDLE = /ipcMain\.handle\(\s*["'`]([^"'`]+)["'`]/g;
const LISTEN = /ipcMain\.on\(\s*["'`]([^"'`]+)["'`]/g;
// preload.cjs exposes channels directly (ipcRenderer.invoke/send/sendSync) and
// through its own `on("channel")` subscription helper.
const PRELOAD =
  /(?:ipcRenderer\.(?:invoke|sendSync|send|on)|(?:^|[^.\w])on)\(\s*["'`]([\w-]+:[\w-]+|[\w-]+)["'`]/g;
// Main -> renderer pushes. `send("area:event", …)` is the shared helper in
// main.cjs; every module that owns a window pushes through some receiver
// (`webContents.send`, `this.overlay?.send`, `tray.send`, …), so any
// identifier — with or without optional chaining — counts as an emitter.
const WEBCONTENTS_SEND =
  /(?:^|[^\w.$])(?:[\w$]+(?:\??\.[\w$]+)*\??\.)?(?:send|emit|sendToRenderer|broadcast)\(\s*["'`]([\w-]+:[\w-]+)["'`]/g;

function scanIpc(root) {
  const mainFiles = collect(root, "electron").filter(
    (f) => !f.endsWith("preload.cjs") && !f.endsWith("connectivity.cjs"),
  );
  const handlers = new Map(); // channel -> file
  const events = new Map(); // main -> renderer pushes
  for (const file of mainFiles) {
    const text = read(path.join(root, file));
    for (const ch of matchAll(text, HANDLE)) if (!handlers.has(ch)) handlers.set(ch, file);
    for (const ch of matchAll(text, LISTEN)) if (!handlers.has(ch)) handlers.set(ch, file);
    for (const ch of matchAll(text, WEBCONTENTS_SEND)) if (!events.has(ch)) events.set(ch, file);
  }

  const preloadText = read(path.join(root, "electron", "preload.cjs"));
  const exposed = new Set(matchAll(preloadText, PRELOAD));

  return { handlers, events, exposed, files: mainFiles.length };
}

/* --------------------------------------------------------------- kernel */

const KERNEL_METHOD = /method\s*==\s*["']([\w.]+)["']/g;
const KERNEL_CALL =
  /(?:kernelCall|callKernel|bridgeCall|call)\s*(?:<[^()]*>)?\(\s*["']([\w]+\.[\w]+)["']/g;
const HTTP_ROUTE = /@(?:app|router)\.(get|post|put|delete|websocket)\(\s*["']([^"']+)["']/g;

function scanKernel(root) {
  const kernelDir = path.join(root, "kernel");
  let pyFiles = [];
  try {
    pyFiles = fs.readdirSync(kernelDir).filter((f) => f.endsWith(".py"));
  } catch {
    pyFiles = [];
  }

  const methods = new Set();
  const routes = [];
  for (const file of pyFiles) {
    const text = read(path.join(kernelDir, file));
    for (const m of matchAll(text, KERNEL_METHOD)) methods.add(m);
    const rx = new RegExp(HTTP_ROUTE.source, "g");
    let hit;
    while ((hit = rx.exec(text))) {
      routes.push({ verb: hit[1].toUpperCase(), path: hit[2], file: `kernel/${file}` });
    }
  }

  const callers = new Map(); // method -> [files]
  const sources = [...collect(root, "src"), ...collect(root, "electron")];
  for (const file of sources) {
    const text = read(path.join(root, file));
    for (const m of matchAll(text, KERNEL_CALL)) {
      if (!methods.has(m)) continue; // only real bridge methods, not `call("x.y")` noise
      const list = callers.get(m) || [];
      if (!list.includes(file)) list.push(file);
      callers.set(m, list);
    }
  }
  return { methods, routes, callers };
}

/* ------------------------------------------------------------------- UI */

function scanUi(root) {
  const routesDir = path.join(root, "src", "routes");
  let files = [];
  try {
    files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".tsx"));
  } catch {
    files = [];
  }
  const pages = [];
  const aliases = [];
  for (const file of files) {
    if (file.startsWith("__")) continue;
    const routePath =
      file === "index.tsx" ? "/" : `/${file.replace(/\.tsx$/, "").replace(/\./g, "/")}`;
    // A route whose only job is `throw redirect({ to })` keeps an old link
    // alive; it is not a page that needs its own navigation entry.
    const text = read(path.join(routesDir, file));
    if (/throw\s+redirect\(/.test(text)) aliases.push(routePath);
    else pages.push(routePath);
  }

  // Navigation covers the sidebar list plus every other in-app <Link to="…">.
  const shellFiles = [
    ...collect(root, "src/components"),
    ...collect(root, "src/routes"),
    ...collect(root, "src/lib"),
  ];
  const nav = new Set();
  for (const file of shellFiles) {
    const text = read(path.join(root, file));
    for (const to of matchAll(text, /to:\s*"(\/[^"]*)"/g)) nav.add(to);
    for (const to of matchAll(text, /to="(\/[^"]*)"/g)) nav.add(to);
  }
  return { pages, aliases, nav };
}

/* --------------------------------------------------------- capabilities */

const CAP_TREES = ["agents", "skills", "tools", "modules", "plugins", "workflows", "models"];

function scanCapabilities(root) {
  const trees = [];
  for (const tree of CAP_TREES) {
    let segments = [];
    try {
      segments = fs
        .readdirSync(path.join(root, tree), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      segments = [];
    }
    const barrel = fs.existsSync(path.join(root, tree, "index.ts"));
    trees.push({ tree, segments, barrel, registered: barrel && segments.length > 0 });
  }
  return trees;
}

/* ----------------------------------------------------------- the graph */

function buildGraph(root) {
  const ipc = scanIpc(root);
  const kernel = scanKernel(root);
  const ui = scanUi(root);
  const capabilities = scanCapabilities(root);

  const rendererFiles = collect(root, "src");
  const rendererText = rendererFiles.map((f) => read(path.join(root, f))).join("\n");

  const issues = [];
  const add = (severity, kind, id, detail) => issues.push({ severity, kind, id, detail });

  // 1. Every main-process channel must be reachable from the renderer.
  for (const [channel, file] of ipc.handlers) {
    if (!ipc.exposed.has(channel)) {
      add("error", "ipc", channel, `handled in ${file} but not exposed by electron/preload.cjs`);
    }
  }
  // 2. Every preload channel must have a handler (otherwise the button hangs).
  for (const channel of ipc.exposed) {
    if (ipc.handlers.has(channel) || ipc.events.has(channel)) continue;
    add("error", "ipc", channel, "exposed by preload but no main-process handler or emitter");
  }
  // 3. Push events must be consumed somewhere in the preload surface.
  for (const [channel, file] of ipc.events) {
    if (!ipc.exposed.has(channel)) {
      add("warning", "ipc-event", channel, `emitted from ${file} but no preload subscription`);
    }
  }
  // 4. Kernel bridge methods with no caller are dead API surface.
  for (const method of kernel.methods) {
    if (!kernel.callers.has(method)) {
      add("warning", "kernel", method, "kernel bridge method has no caller in the app");
    }
  }
  // 5. Every page must be reachable from the sidebar.
  for (const page of ui.pages) {
    if (!ui.nav.has(page)) add("warning", "route", page, "route file has no sidebar entry");
  }
  for (const entry of ui.nav) {
    if (ui.pages.includes(entry) || ui.aliases.includes(entry)) continue;
    add("error", "route", entry, "navigation links to a missing route");
  }
  // 6. Capability trees must stay discoverable.
  for (const tree of capabilities) {
    if (!tree.barrel) add("error", "capability", tree.tree, "tree has no index.ts registration");
  }

  const linked = {
    ipc: ipc.handlers.size,
    ipcExposed: ipc.exposed.size,
    ipcEvents: ipc.events.size,
    kernelMethods: kernel.methods.size,
    kernelCalled: kernel.callers.size,
    kernelRoutes: kernel.routes.length,
    pages: ui.pages.length,
    navEntries: ui.nav.size,
    capabilityTrees: capabilities.filter((t) => t.registered).length,
    rendererFiles: rendererFiles.length,
  };

  const errors = issues.filter((i) => i.severity === "error").length;
  return {
    schema: SCHEMA,
    at: Date.now(),
    root: norm(root),
    ok: errors === 0,
    summary: linked,
    channels: [...ipc.handlers.entries()].map(([id, file]) => ({
      id,
      file,
      exposed: ipc.exposed.has(id),
    })),
    kernel: {
      methods: [...kernel.methods].sort().map((id) => ({
        id,
        callers: kernel.callers.get(id) || [],
      })),
      routes: kernel.routes,
    },
    ui: {
      pages: ui.pages.map((p) => ({ path: p, inNav: ui.nav.has(p) })),
      aliases: ui.aliases,
    },
    capabilities,
    issues,
    // Kept for the renderer: how much of the surface is genuinely connected.
    coverage: {
      ipc: ipc.handlers.size
        ? [...ipc.handlers.keys()].filter((c) => ipc.exposed.has(c)).length / ipc.handlers.size
        : 1,
      kernel: kernel.methods.size ? kernel.callers.size / kernel.methods.size : 1,
      routes: ui.pages.length ? ui.pages.filter((p) => ui.nav.has(p)).length / ui.pages.length : 1,
    },
    rendererUsesBridge: /window\.friday|desktopApi\(/.test(rendererText),
  };
}

/* --------------------------------------------------------------- runtime */

let cached = null;

function graphFile(root) {
  return path.join(root, CACHE_FILE);
}

/** Live graph, recomputed on demand (and by the watcher when files change). */
function connectivity(root, { refresh = false } = {}) {
  if (!refresh && cached && cached.root === norm(root) && Date.now() - cached.at < 60_000) {
    return cached;
  }
  cached = buildGraph(root);
  try {
    fs.mkdirSync(path.dirname(graphFile(root)), { recursive: true });
    fs.writeFileSync(graphFile(root), `${JSON.stringify(cached, null, 2)}\n`, "utf8");
  } catch {
    /* the graph is still valid in memory even if the cache cannot be written */
  }
  return cached;
}

function invalidate() {
  cached = null;
}

module.exports = {
  SCHEMA,
  buildGraph,
  connectivity,
  invalidate,
  scanIpc,
  scanKernel,
  scanUi,
  scanCapabilities,
};
