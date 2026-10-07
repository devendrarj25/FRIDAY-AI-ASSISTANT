/**
 * FRIDAY · packaged renderer loader (single authoritative implementation).
 *
 * Why this exists
 * ---------------
 * The desktop bundle (vite.electron.config.ts -> dist-desktop/) is an ES-module
 * build with code-split route chunks. Chromium refuses to evaluate module
 * scripts and dynamic `import()` over `file://` (origin `null` fails the CORS
 * check), so `win.loadFile('.../dist-desktop/index.html')` produced a document
 * that either stayed blank or mounted the shell and then failed on every route
 * chunk. Nothing was missing from app.asar — the *protocol* was wrong.
 *
 * The fix is one privileged, standard scheme, `friday://app/...`, served from
 * `path.join(app.getAppPath(), 'dist-desktop')`. That path is correct both in
 * development (project root) and packaged (inside app.asar), asar reads work
 * through fs, and module scripts / dynamic imports / CSS / images all load with
 * a real origin. Development with FRIDAY_DEV_URL is unchanged.
 */
const { app, protocol, net } = require("electron");
const fs = require("fs");
const path = require("path");

const SCHEME = "friday";
const ORIGIN = `${SCHEME}://app`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** Directory holding the built renderer, inside app.asar when packaged. */
function rendererDir() {
  return path.join(app.getAppPath(), "dist-desktop");
}

function rendererIndex() {
  return path.join(rendererDir(), "index.html");
}

function rendererExists() {
  try {
    return fs.existsSync(rendererIndex());
  } catch {
    return false;
  }
}

/**
 * Must run before `app.whenReady()` — privileged schemes cannot be registered
 * afterwards. `standard` gives the page a real origin, which is what makes ES
 * modules and dynamic imports work.
 */
function registerScheme() {
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
          corsEnabled: true,
        },
      },
    ]);
  } catch {
    // Already registered (second call in a test harness) — harmless.
  }
}

let handlerInstalled = false;

/** Install the file server for `friday://app/...`. Safe to call more than once. */
function registerHandler(log = () => {}) {
  if (handlerInstalled) return;
  handlerInstalled = true;
  const dir = rendererDir();

  protocol.handle(SCHEME, async (request) => {
    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      pathname = "/";
    }
    if (!pathname || pathname === "/") pathname = "/index.html";

    // Resolve inside the bundle only: no traversal out of dist-desktop.
    const target = path.join(dir, path.normalize(pathname).replace(/^([/\\])+/, ""));
    const withinBundle = target === dir || target.startsWith(dir + path.sep);
    let file = withinBundle ? target : rendererIndex();

    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // Client-routed URLs (no file on disk) fall back to the shell document,
      // exactly like a static web host. Missing asset requests must NOT be
      // rewritten to HTML, or the failure becomes a confusing parse error.
      if (path.extname(file)) {
        log(`renderer asset missing: ${pathname}`);
        return new Response("Not found", { status: 404 });
      }
      file = rendererIndex();
    }

    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "cache-control": "no-cache",
        },
      });
    } catch (error) {
      log(`renderer read failed for ${pathname}: ${String(error && error.message)}`);
      return new Response("Read error", { status: 500 });
    }
  });
}

/**
 * Load the interface into a window.
 * @param {object} [options]
 * @param {string|null} [options.route] client route to open (defaults to "/").
 * @returns {{mode:string, target:string}} what was loaded, for diagnostics.
 */
function load(win, { devUrl = null, log = () => {}, onFailure = () => {}, route = null } = {}) {
  const appPath = app.getAppPath();
  const index = rendererIndex();
  const exists = rendererExists();
  const suffix = route && route !== "/" ? `/${String(route).replace(/^\/+/, "")}` : "";
  log(
    `renderer: packaged=${app.isPackaged} appPath=${appPath} resources=${process.resourcesPath} renderer=${index} rendererExists=${exists}`,
  );

  if (devUrl) {
    const target = suffix ? `${devUrl.replace(/\/+$/, "")}${suffix}` : devUrl;
    win.loadURL(target).catch((err) => onFailure(String(err)));
    return { mode: "dev-server", target };
  }

  if (!exists) {
    onFailure(
      `The FRIDAY interface bundle is missing.\n\nExpected: ${index}\n\nRun "npm run build:desktop" before packaging.`,
    );
    return { mode: "missing", target: index };
  }

  registerHandler(log);
  const url = suffix ? `${ORIGIN}${suffix}` : `${ORIGIN}/index.html`;
  win.loadURL(url).catch((err) => onFailure(String(err)));
  return { mode: "packaged", target: url };
}

module.exports = {
  SCHEME,
  ORIGIN,
  rendererDir,
  rendererIndex,
  rendererExists,
  registerScheme,
  registerHandler,
  load,
  // exported for tooling/tests that need the raw fetcher
  net,
};
