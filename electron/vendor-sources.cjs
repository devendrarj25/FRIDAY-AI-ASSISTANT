/**
 * Official, machine-readable release feeds for the tools FRIDAY installs.
 *
 * One feed answers two questions from the vendor itself: "what is the newest
 * version?" (for the Install Manager's update check, even when winget has no
 * answer) and "where is the installer, and what is its SHA-256?" (the fallback
 * when winget is missing, broken or refused). A feed never guesses: an install
 * is offered only when the vendor published a digest for the exact file, and
 * the downloader refuses the file if the digest does not match.
 *
 * Feeds are read through the app's network stack (system proxy, Windows
 * certificates). Every feed result is cached for 30 minutes and every failure
 * reads as "no answer", never as an error that stops a scan.
 */
const { fetchCompat } = require("./net-fetch.cjs");

const TTL_MS = 30 * 60 * 1000;
const UA = { "user-agent": "FRIDAY-InstallManager", accept: "application/json, text/plain, */*" };
const cache = new Map(); // key -> { at, value }
const failures = new Map(); // key -> why the last lookup gave nothing

async function request(url, { timeout = 8000, fetchImpl = fetchCompat } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetchImpl(url, { headers: UA, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options) {
  const res = await request(url, options);
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

async function getText(url, options) {
  const res = await request(url, options);
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.text();
}

const stripSha = (digest) =>
  String(digest || "")
    .replace(/^sha256:/i, "")
    .trim()
    .toLowerCase();
const isSha = (value) => /^[a-f0-9]{64}$/.test(String(value || ""));

/**
 * `hash  filename` lines (SHASUMS256.txt, *.sha256) -> hash of one file. A digest file that
 * belongs to a single download (rustup-init.exe.sha256) holds the bare hash and no filename, so
 * with no filename asked for, a line that is only a hash counts too.
 */
function hashFromSums(text, filename) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && (m[2] === filename || !filename)) return m[1].toLowerCase();
    const bare = /^([a-f0-9]{64})$/i.exec(line.trim());
    if (bare && !filename) return bare[1].toLowerCase();
  }
  return null;
}

/* ------------------------------------------------------------------ GitHub */

/**
 * Newest GitHub release of a repo. The API gives assets and their digests; when
 * it is rate-limited or unreachable, the public /releases/latest redirect still
 * names the tag, so the version stays known (an install then needs the API).
 */
async function githubRelease(repo, options = {}) {
  try {
    const json = await getJson(`https://api.github.com/repos/${repo}/releases/latest`, options);
    return {
      tag: String(json.tag_name || ""),
      assets: (json.assets || []).map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        bytes: Number(a.size) || 0,
        sha256: stripSha(a.digest),
      })),
      viaApi: true,
    };
  } catch {
    try {
      const res = await request(`https://github.com/${repo}/releases/latest`, options);
      const tag = decodeURIComponent(String(res.url || "").split("/tag/")[1] || "").split("?")[0];
      return tag ? { tag, assets: [], viaApi: false } : null;
    } catch {
      return null;
    }
  }
}

/** A feed for one asset of a GitHub release. */
function githubFeed({ repo, asset, version, kind, installerArgs, bin, mirrors }) {
  return async (options) => {
    const release = await githubRelease(repo, options);
    if (!release?.tag) return null;
    const v = version ? version(release.tag) : release.tag.replace(/^v/, "");
    const hit = release.assets.find((a) => asset.test(a.name));
    const out = { version: v, source: `github.com/${repo}`, kind };
    if (hit && isSha(hit.sha256)) {
      Object.assign(out, {
        url: hit.url,
        sha256: hit.sha256,
        bytes: hit.bytes,
        ...(installerArgs ? { installerArgs } : {}),
        ...(bin ? { bin: typeof bin === "function" ? bin(hit.name, v) : bin } : {}),
        // The vendor's own site serves the same file, so the same digest checks every source.
        ...(mirrors ? { mirrors: mirrors(hit.name, v).filter(Boolean) } : {}),
      });
    }
    return out;
  };
}

/**
 * GitLab project releases (graphviz/graphviz is published there, not on GitHub). Only the newest version is
 * read: the project lists installers without digests, so an install is never offered from this feed.
 */
function gitlabVersionFeed({ project, source, kind }) {
  return async (options) => {
    const list = await getJson(
      `https://gitlab.com/api/v4/projects/${project}/releases?per_page=1`,
      options,
    );
    const tag = Array.isArray(list) ? list[0]?.tag_name : null;
    if (!tag || list[0]?.upcoming_release) return null;
    return { version: String(tag).replace(/^v/, ""), source, kind };
  };
}

/**
 * Docker Desktop publishes a Sparkle appcast; the newest <item> carries the marketing version in
 * `sparkle:shortVersionString`. Version only: no digest is published there, so no install is offered.
 */
function dockerFeed() {
  return async (options) => {
    const xml = await getText("https://desktop.docker.com/win/main/amd64/appcast.xml", options);
    const version = newestAppcastVersion(xml);
    return version ? { version, source: "desktop.docker.com", kind: "exe" } : null;
  };
}

function newestAppcastVersion(xml) {
  const found = [];
  const pattern = /sparkle:shortVersionString(?:="|>)\s*([\d.]+)/g;
  let m = pattern.exec(String(xml || ""));
  while (m) {
    found.push(m[1]);
    m = pattern.exec(String(xml || ""));
  }
  return found.sort(compareDotted).pop() || null;
}

function compareDotted(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * NVIDIA publishes one `redistrib_<version>.json` per CUDA release under /compute/cuda/redist/. The directory
 * page is read for the names and the highest version wins. Version only: the toolkit installer is large and
 * stays in the Install Manager.
 */
function cudaFeed() {
  return async (options) => {
    const html = await getText(
      "https://developer.download.nvidia.com/compute/cuda/redist/",
      options,
    );
    const versions = [...String(html || "").matchAll(/redistrib_(\d+\.\d+\.\d+)\.json/g)].map(
      (m) => m[1],
    );
    const newest = [...new Set(versions)].sort(compareDotted).pop();
    return newest
      ? { version: newest, source: "developer.download.nvidia.com", kind: "exe" }
      : null;
  };
}

/* ------------------------------------------------------------ vendor feeds */

/** nodejs.org: index.json lists releases; SHASUMS256.txt carries the digests. */
function nodeFeed({ major = null, kind }) {
  return async (options) => {
    const index = await getJson("https://nodejs.org/dist/index.json", options);
    const entry = (index || []).find(
      (e) => e.lts && (major === null || String(e.version).startsWith(`v${major}.`)),
    );
    if (!entry) return null;
    const v = entry.version;
    const file = kind === "zip" ? `node-${v}-win-x64.zip` : `node-${v}-x64.msi`;
    const out = { version: v.replace(/^v/, ""), source: "nodejs.org", kind };
    try {
      const sums = await getText(`https://nodejs.org/dist/${v}/SHASUMS256.txt`, options);
      const sha256 = hashFromSums(sums, file);
      if (sha256) {
        Object.assign(out, {
          url: `https://nodejs.org/dist/${v}/${file}`,
          mirrors: [
            `https://npmmirror.com/mirrors/node/${v}/${file}`,
            `https://mirrors.huaweicloud.com/nodejs/${v}/${file}`,
          ],
          sha256,
          ...(kind === "zip" ? { bin: `node-${v}-win-x64/node.exe` } : {}),
        });
      }
    } catch {
      /* the version is still known; an install needs the digest */
    }
    return out;
  };
}

/** go.dev/dl: the JSON feed lists every file with its SHA-256. */
async function goFeed(options) {
  const list = await getJson("https://go.dev/dl/?mode=json", options);
  const release = (list || []).find((r) => r.stable);
  if (!release) return null;
  const file = (release.files || []).find(
    (f) => f.os === "windows" && f.arch === "amd64" && f.kind === "installer",
  );
  const out = {
    version: String(release.version).replace(/^go/, ""),
    source: "go.dev",
    kind: "msi",
  };
  if (file && isSha(file.sha256)) {
    Object.assign(out, {
      url: `https://go.dev/dl/${file.filename}`,
      sha256: file.sha256.toLowerCase(),
      bytes: Number(file.size) || 0,
    });
  }
  return out;
}

/**
 * static.rust-lang.org: rustup-init has a .sha256 and the stable channel names the version.
 * The installer comes first and needs only the small digest file; the channel document is large
 * (about a megabyte) and on a slow line it can miss the short default timeout, so it gets a long
 * one and, failing that, the version is read from the compiler's own GitHub release. The install
 * must never depend on the version lookup.
 */
async function rustFeed(options) {
  const base = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe";
  // The digest is one small file; a slow line gets a longer wait and one more try before the
  // feed gives up, because without it no installer is offered at all.
  const digestOptions = { ...options, timeout: 20_000 };
  let digest = "";
  try {
    digest = await getText(`${base}.sha256`, digestOptions);
  } catch {
    digest = await getText(`${base}.sha256`, digestOptions);
  }
  const sha256 = hashFromSums(digest, "") || null;
  let version = null;
  try {
    const toml = await getText("https://static.rust-lang.org/dist/channel-rust-stable.toml", {
      ...options,
      timeout: 45_000,
    });
    version = /\[pkg\.rust\][\s\S]*?\nversion = "(\d+\.\d+\.\d+)/.exec(toml)?.[1] || null;
  } catch {
    /* the compiler's release below names it */
  }
  if (!version) {
    try {
      const tag = (await githubRelease("rust-lang/rust", options)).tag;
      version = /^(\d+\.\d+\.\d+)/.exec(tag)?.[1] || null;
    } catch {
      /* installed without a known newest version */
    }
  }
  if (!sha256 && !version) return null;
  const out = { version: version || "stable", source: "rust-lang.org", kind: "exe" };
  if (sha256) {
    Object.assign(out, {
      url: base,
      sha256,
      // rustup-init.exe carries no Authenticode signature; its integrity rests on this SHA-256
      // read over HTTPS from rust-lang.org. A signature that is present must still be valid.
      allowUnsigned: true,
      installerArgs: ["-y", "--default-toolchain", "stable", "--profile", "minimal"],
    });
  }
  return out;
}

/** update.code.visualstudio.com: one JSON document with the URL and SHA-256. */
async function vscodeFeed(options) {
  const info = await getJson(
    "https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest",
    options,
  );
  const version = String(info.productVersion || info.name || "");
  if (!version) return null;
  const out = { version, source: "code.visualstudio.com", kind: "exe" };
  if (info.url && isSha(info.sha256hash)) {
    Object.assign(out, {
      url: info.url,
      sha256: info.sha256hash.toLowerCase(),
      installerArgs: ["/VERYSILENT", "/NORESTART", "/MERGETASKS=!runcode"],
    });
  }
  return out;
}

/** api.adoptium.net: latest Temurin build with installer and zip checksums. */
function adoptiumFeed({ feature = 21, kind }) {
  return async (options) => {
    const list = await getJson(
      `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse`,
      options,
    );
    const entry = (list || [])[0];
    if (!entry) return null;
    const release = entry.release_name || "";
    const version = String(entry.version?.semver || "").replace(/\+.*$/, "") || release;
    const pick = kind === "zip" ? entry.binary?.package : entry.binary?.installer;
    const out = { version, source: "adoptium.net", kind };
    if (pick?.link && isSha(pick.checksum)) {
      Object.assign(out, {
        url: pick.link,
        sha256: pick.checksum.toLowerCase(),
        bytes: Number(pick.size) || 0,
        ...(kind === "zip" ? { bin: `${release}/bin/java.exe` } : {}),
      });
    }
    return out;
  };
}

const gitVersion = (tag) => tag.replace(/^v/, "");

/** Feeds by Install Manager tool id. */
const FEEDS = {
  "Node.js LTS": nodeFeed({ kind: "msi" }),
  "FRIDAY Node": nodeFeed({ major: 22, kind: "zip" }),
  Go: goFeed,
  Rust: rustFeed,
  "Visual Studio Code": vscodeFeed,
  "OpenJDK (Temurin)": adoptiumFeed({ kind: "msi" }),
  "Temurin JDK zip": adoptiumFeed({ kind: "zip" }),
  Git: githubFeed({
    repo: "git-for-windows/git",
    asset: /^Git-[\d.]+-64-bit\.exe$/,
    version: gitVersion,
    kind: "exe",
    installerArgs: ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"],
  }),
  MinGit: githubFeed({
    repo: "git-for-windows/git",
    asset: /^MinGit-[\d.]+-64-bit\.zip$/,
    version: gitVersion,
    kind: "zip",
    bin: "cmd/git.exe",
  }),
  "7-Zip": githubFeed({
    repo: "ip7z/7zip",
    asset: /^7z\d+-x64\.exe$/,
    kind: "exe",
    installerArgs: ["/S"],
  }),
  Pandoc: githubFeed({
    repo: "jgm/pandoc",
    asset: /^pandoc-[\d.]+-windows-x86_64\.msi$/,
    kind: "msi",
  }),
  "Tesseract OCR": githubFeed({
    repo: "UB-Mannheim/tesseract",
    asset: /^tesseract-ocr-w64-setup-[\d.]+\.exe$/,
    kind: "exe",
    installerArgs: ["/S"],
  }),
  Graphviz: gitlabVersionFeed({
    project: "4207231",
    source: "gitlab.com/graphviz/graphviz",
    kind: "exe",
  }),
  "Docker Desktop": dockerFeed(),
  "CUDA Toolkit": cudaFeed(),
  "LLVM / Clang": githubFeed({
    repo: "llvm/llvm-project",
    asset: /^LLVM-[\d.]+-win64\.exe$/,
    version: (tag) => tag.replace(/^llvmorg-/, ""),
    kind: "exe",
    installerArgs: ["/S"],
  }),
  aria2: githubFeed({
    repo: "aria2/aria2",
    asset: /^aria2-[\d.]+-win-64bit-build\d+\.zip$/,
    version: (tag) => tag.replace(/^release-/, ""),
    kind: "zip",
    bin: (name) => `${name.replace(/\.zip$/, "")}/aria2c.exe`,
  }),
  KoboldCpp: githubFeed({
    repo: "LostRuins/koboldcpp",
    asset: /^koboldcpp\.exe$/,
    version: (tag) => tag.replace(/^v/, ""),
    kind: "exe",
    bin: "koboldcpp.exe",
  }),
  // Portable zip feeds for the command-line tools an agent leans on. They are the
  // fallback when winget is missing or fails; the unpacked folder joins PATH.
  ripgrep: githubFeed({
    repo: "BurntSushi/ripgrep",
    asset: /^ripgrep-[\d.]+-x86_64-pc-windows-msvc\.zip$/,
    kind: "zip",
    bin: (name) => `${name.replace(/\.zip$/, "")}/rg.exe`,
  }),
  "uv (Python)": githubFeed({
    repo: "astral-sh/uv",
    asset: /^uv-x86_64-pc-windows-msvc\.zip$/,
    kind: "zip",
    bin: "uv.exe",
  }),
  CMake: githubFeed({
    repo: "Kitware/CMake",
    asset: /^cmake-[\d.]+-windows-x86_64\.zip$/,
    kind: "zip",
    bin: (name) => `${name.replace(/\.zip$/, "")}/bin/cmake.exe`,
    // cmake.org/files/v4.5/ holds every release file (Kitware's own download page links there).
    mirrors: (name, v) => {
      const minor = /^(\d+\.\d+)/.exec(v);
      return minor ? [`https://cmake.org/files/v${minor[1]}/${name}`] : [];
    },
  }),
  Ninja: githubFeed({
    repo: "ninja-build/ninja",
    asset: /^ninja-win\.zip$/,
    kind: "zip",
    bin: "ninja.exe",
  }),
  "FRIDAY GitHub CLI": githubFeed({
    repo: "cli/cli",
    asset: /^gh_[\d.]+_windows_amd64\.zip$/,
    kind: "zip",
    bin: "bin/gh.exe",
  }),
};

const hasFeed = (toolId) => Boolean(FEEDS[toolId]);
const feedIds = () => Object.keys(FEEDS);

/**
 * Resolve one tool's feed. Returns null when there is none or it did not answer.
 * `install` is set only when the vendor gave a digest for the installer.
 */
async function resolveFeed(toolId, options = {}) {
  const feed = FEEDS[toolId];
  if (!feed) return null;
  const now = options.now ? options.now() : Date.now();
  const hit = cache.get(toolId);
  if (hit && now - hit.at < TTL_MS && !options.force) return hit.value;
  let value = null;
  try {
    const result = await feed(options);
    if (result?.version) {
      const { url, sha256, ...rest } = result;
      value = { ...rest, version: result.version, install: url && sha256 ? { url, sha256 } : null };
    }
  } catch (err) {
    value = null;
    failures.set(toolId, String(err?.message || err));
  }
  if (value) {
    failures.delete(toolId);
    cache.set(toolId, { at: now, value });
  } else if (!failures.has(toolId)) failures.set(toolId, "the vendor feed gave no answer");
  return value;
}

/** Why the last lookup for a tool returned nothing, so an install can say it instead of going quiet. */
const feedFailure = (toolId) => failures.get(toolId) || "";

const clearFeedCache = () => cache.clear();

/* ------------------------------------------------------------------ winget */

/**
 * `winget upgrade` prints a table of installed packages that have a newer
 * version: Name, Id, Version, Available, Source. The columns are fixed-width, so
 * their start positions come from the header line. Returns Id -> available.
 */
function parseWingetUpgrade(text) {
  const lines = String(text || "").split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /\bId\b/.test(l) && /\bAvailable\b/.test(l));
  if (headerAt < 0) return {};
  const head = lines[headerAt];
  const col = {
    id: head.indexOf("Id"),
    version: head.indexOf("Version"),
    available: head.indexOf("Available"),
    source: head.indexOf("Source"),
  };
  if (col.id < 0 || col.available < 0) return {};
  const out = {};
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim() || /^-+$/.test(line.trim())) continue;
    if (/upgrades? available|^\d+ package/i.test(line)) break;
    const id = line.slice(col.id, col.version > col.id ? col.version : undefined).trim();
    const available = line
      .slice(col.available, col.source > col.available ? col.source : undefined)
      .trim();
    if (id && available && /^\S+$/.test(id) && /\d/.test(available)) out[id] = available;
  }
  return out;
}

/* ------------------------------------------------- ordered source chains */
/**
 * One row, several official places to ask. A chain is an ordered list of source specs; each is tried with its own
 * short timeout and the first that answers wins, so a rate limit, an outage or a slow host never blocks the catalogue.
 *
 *   github-api    api.github.com releases/latest      version, assets and their `digest`
 *   github-list   api.github.com releases?per_page=15  newest tag matching `tagPattern` whose `assetPattern` file has a
 *                 digest (a release whose file has none is skipped); for repos whose "latest" is not the build tag
 *   github-atom   github.com releases.atom            version only (no API quota, no digest); `tagPattern` filters
 *                 the entries and `requireDigest` makes the answer usable only with the pinned digest of that tag
 *   pypi-json     pypi.org/pypi/<pkg>/json            newest release with a wheel for the platform, sha256 per file
 *   pypi-simple   pypi.org/simple/<pkg>/ (PEP 691)    the same answer from the index itself
 *   npm, npm-mirror   registry.npmjs.org, registry.npmmirror.com
 *   hf-api        huggingface.co/api/models/<repo>    the revision and the LFS sha256 of each file
 *   feed          a vendor feed above (nodejs.org, go.dev, ...)
 *   pinned        the catalogue's own pin; used last, after the cached answer
 *
 * A source that sent an ETag or Last-Modified is asked again with If-None-Match / If-Modified-Since, so a 304 costs
 * no body (and no GitHub quota). Answers live in a small JSON file in the data root; with every source down the last
 * answer is served marked `stale`, never an empty row. Nothing here owns a timer: the daily pass is planned by
 * `planFeedRefresh` and started by the refresh scheduler that already runs.
 */
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeCrypto = require("node:crypto");

const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_FRESH_MS = DAY_MS;
const MANUAL_MIN_MS = 60 * 1000;
const SOURCE_TIMEOUT_MS = 6000;
const STORE_SCHEMA = 1;
/** The largest vendor page a reader accepts. A version page is a few kilobytes; anything near this is not one. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const shortError = (error) =>
  String(error?.message || error || "failed")
    .replace(/\s+/g, " ")
    .slice(0, 160);

/** Numeric dotted compare; a pre-release (1.0.0rc1, 2.0a3, 1.0.dev4) is older than its release. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(String(v ?? "").trim());
    if (!m) return { n: [], pre: false };
    return {
      n: m[1].split(".").map(Number),
      pre: /^[-._]?(a|b|c|rc|alpha|beta|dev|pre)/i.test(m[2]),
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i += 1) {
    const d = (x.n[i] || 0) - (y.n[i] || 0);
    if (d) return d;
  }
  return Number(y.pre) - Number(x.pre);
}
const isPrerelease = (version) => /\d[-._]?(a|b|c|rc|alpha|beta|dev|pre)\d*/i.test(String(version));

/**
 * One request with a hard deadline (abort signal AND a race, for a fetch that ignores the signal) and a size cap
 * (`maxBytes`, from the length header and again on the text). `bodyless` reads status and headers only and drops the
 * body unread (a redirect probe); `method` may be HEAD for that.
 */
async function httpGet(
  url,
  {
    fetchImpl = fetchCompat,
    timeout = SOURCE_TIMEOUT_MS,
    headers = {},
    cond = null,
    method = "GET",
    bodyless = false,
    maxBytes = MAX_BODY_BYTES,
    pathPrefix = "",
  } = {},
) {
  const host = new URL(url).hostname;
  const controller = new AbortController();
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${host} timed out after ${timeout} ms`));
    }, timeout);
  });
  const send = {
    ...UA,
    ...headers,
    ...(cond?.etag ? { "if-none-match": cond.etag } : {}),
    ...(cond?.lastModified ? { "if-modified-since": cond.lastModified } : {}),
  };
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(url, {
          headers: send,
          signal: controller.signal,
          redirect: "follow",
          ...(method === "GET" ? {} : { method }),
        });
        const status = Number(res.status) || 0;
        const header = (name) =>
          (typeof res.headers?.get === "function" ? res.headers.get(name) : null) || null;
        const meta = {
          status,
          etag: header("etag"),
          lastModified: header("last-modified"),
          url: res.url || url,
        };
        if (status === 304) return { ...meta, notModified: true, text: "" };
        if (!res.ok) throw new Error(`${host} answered ${status}`);
        if (bodyless) {
          try {
            await res.body?.cancel?.();
          } catch {
            /* the body was never wanted */
          }
          return { ...meta, notModified: false, text: "" };
        }
        // A page the request was sent on to must still be a place downloads may come from, and for the
        // community registries the path stays inside its own project.
        checkFinalUrl(url, meta.url, pathPrefix);
        if (Number(header("content-length")) > maxBytes)
          throw new Error(`${host} sent a page that is too large (over ${maxBytes} bytes)`);
        const text = await readCapped(res, maxBytes, host, () => controller.abort());
        return { ...meta, notModified: false, text };
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The body as text, counted while it streams: more than `maxBytes` aborts the request at once. */
async function readCapped(res, maxBytes, host, abort) {
  const tooLarge = () =>
    new Error(`${host} sent a page that is too large (over ${maxBytes} bytes)`);
  const reader = typeof res.body?.getReader === "function" ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) throw tooLarge();
    return text;
  }
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      abort();
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * A version page that the network sent on to another host is read only when that host is on the download
 * allowlist (`config/download-hosts.json`); `pathPrefix` pins the path of a registry page (Scoop) so a redirect
 * cannot swap in another project's manifest.
 */
function checkFinalUrl(requested, finalUrl, pathPrefix = "") {
  if (!finalUrl || finalUrl === requested) return;
  const from = new URL(requested);
  let to;
  try {
    to = new URL(finalUrl);
  } catch {
    throw new Error("the page was sent on to an address that is not a URL");
  }
  if (to.protocol !== "https:")
    throw new Error(`${from.hostname} sent the request on to a non-https address`);
  if (to.hostname !== from.hostname) {
    try {
      require("./download-safety.cjs").assertAllowedUrl(finalUrl, []);
    } catch {
      throw new Error(
        `${from.hostname} sent the request on to ${to.hostname}, which is not an allowed host`,
      );
    }
  }
  if (pathPrefix && !to.pathname.startsWith(pathPrefix))
    throw new Error(`${to.hostname} sent the request on to another project`);
}

const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} sent a document that is not JSON`);
  }
};

function stripTag(tag, strip) {
  const text = String(tag || "");
  if (strip) return text.replace(new RegExp(strip, "g"), "");
  return text.replace(/^v(?=\d)/, "");
}

function parseGithubRelease(json, strip) {
  const tag = String(json?.tag_name || "");
  if (!tag) throw new Error("the release has no tag");
  return {
    version: stripTag(tag, strip),
    tag,
    ...(json.published_at ? { publishedAt: String(json.published_at) } : {}),
    assets: (Array.isArray(json.assets) ? json.assets : []).map((a) => ({
      name: String(a.name || ""),
      url: String(a.browser_download_url || ""),
      bytes: Number(a.size) || 0,
      sha256: stripSha(a.digest),
    })),
  };
}

/** The newest atom entry (optionally the newest whose tag matches `tagPattern`). */
function parseAtomTag(xml, strip, tagPattern) {
  const want = tagPattern ? new RegExp(tagPattern) : null;
  const tags = [
    ...String(xml || "").matchAll(/<entry>[\s\S]*?href="[^"]*\/releases\/tag\/([^"]+)"/g),
  ]
    .map((m) => decodeURIComponent(m[1]))
    .filter((tag) => !want || want.test(tag));
  if (!tags.length) throw new Error("the feed lists no release");
  return { version: stripTag(tags[0], strip), tag: tags[0], assets: [] };
}

/**
 * The newest release of a `releases` list whose tag fits `tagPattern` and whose `assetPattern` file carries a digest.
 * Drafts and pre-releases are never taken; a release whose matching file has no digest is skipped for an older one.
 * The answer lists every file of that release (each with its own digest or none), so the caller plans CUDA or Vulkan
 * builds from it too and refuses a zip that has no digest.
 */
function parseGithubList(json, { tagPattern, assetPattern, strip } = {}) {
  if (!Array.isArray(json)) throw new Error("the release list is not a list");
  const tagRe = tagPattern ? new RegExp(tagPattern) : null;
  const fileRe = assetPattern ? new RegExp(assetPattern, "i") : null;
  for (const rel of json) {
    const tag = String(rel?.tag_name || "");
    if (!tag || rel.draft || rel.prerelease || (tagRe && !tagRe.test(tag))) continue;
    const parsed = parseGithubRelease(rel, strip);
    const gate = parsed.assets.find((a) => a.url && (!fileRe || fileRe.test(a.name)));
    if (gate && isSha(gate.sha256)) return parsed;
  }
  throw new Error("no recent release has the build file with a published digest");
}

const wheelVersion = (filename) => {
  const parts = String(filename)
    .replace(/\.(whl|tar\.gz|zip)$/i, "")
    .split("-");
  return parts.length >= 2 ? parts[1] : "";
};

/** The newest non-pre-release version in `byVersion` ({ version: files[] }) whose files satisfy `fits`. */
function newestWithFiles(byVersion, fits) {
  const versions = Object.keys(byVersion)
    .filter((v) => !isPrerelease(v))
    .filter((v) => (byVersion[v] || []).some(fits))
    .sort((a, b) => compareVersions(b, a));
  return versions[0] || null;
}

function parsePypiJson(json, platform) {
  const releases = json?.releases && typeof json.releases === "object" ? json.releases : {};
  const fits = (f) => !f.yanked && (!platform || String(f.filename).includes(platform));
  const version = platform ? newestWithFiles(releases, fits) : String(json?.info?.version || "");
  if (!version) throw new Error(`no ${platform || "release"} file is published`);
  return {
    version,
    assets: (releases[version] || []).filter(fits).map((f) => ({
      name: f.filename,
      url: f.url,
      bytes: Number(f.size) || 0,
      sha256: stripSha(f.digests?.sha256),
    })),
  };
}

function parsePypiSimple(json, platform) {
  const files = (Array.isArray(json?.files) ? json.files : []).filter((f) => !f.yanked);
  const byVersion = {};
  for (const f of files) {
    const v = wheelVersion(f.filename);
    if (v) (byVersion[v] ||= []).push(f);
  }
  const fits = (f) => !platform || String(f.filename).includes(platform);
  const version = newestWithFiles(byVersion, fits);
  if (!version) throw new Error(`no ${platform || "release"} file is published`);
  return {
    version,
    assets: byVersion[version].filter(fits).map((f) => ({
      name: f.filename,
      url: f.url,
      bytes: Number(f.size) || 0,
      sha256: stripSha(f.hashes?.sha256),
    })),
  };
}

function parseHfModel(json, repo) {
  const sha = String(json?.sha || "");
  if (!sha) throw new Error("the model page has no revision");
  return {
    version: sha,
    revision: sha,
    assets: (Array.isArray(json.siblings) ? json.siblings : []).map((s) => ({
      name: String(s.rfilename || ""),
      url: `https://huggingface.co/${repo}/resolve/${sha}/${s.rfilename}`,
      bytes: Number(s.lfs?.size ?? s.size) || 0,
      sha256: stripSha(s.lfs?.sha256),
    })),
  };
}

const pepName = (pkg) =>
  String(pkg)
    .toLowerCase()
    .replace(/[-_.]+/g, "-");

/* ------------------------------------------- data-driven readers (config/tool-sources) */

/**
 * A version string a reader may hand on: 1 to 64 characters of letters, digits and `. _ + -`, starting with a digit
 * (an optional `v` is removed) or with one to four letters and digits (`b12230`). A page, a word such as "latest",
 * or anything with a space, a slash or markup is not a version. `strip` is a regex removed first.
 */
function sanitizeVersion(raw, strip) {
  if (raw === null || raw === undefined || typeof raw === "object")
    throw new Error("the source gave no version");
  let text = String(raw).trim();
  if (strip) text = text.replace(new RegExp(strip, "g"), "").trim();
  else text = text.replace(/^v(?=\d)/, "");
  if (!/^(?:\d[0-9A-Za-z._+-]{0,63}|[A-Za-z]{1,4}\d[0-9A-Za-z._+-]{0,59})$/.test(text))
    throw new Error(`"${text.slice(0, 30)}" is not a version number`);
  return text;
}

/** An https URL without credentials; anything else is refused before a request is made. */
function httpsUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error("the source URL is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("the source URL must be a plain https address");
  return url.href;
}

const versionOnly = (version) => ({ version, assets: [] });
const hostOf = (url) => new URL(url).hostname;

/** `$.a.b[0].c`, `[0].version`, `$['a-b']`, or one filter `$[?(@.cycle=='3.14')].latest`, as a list of steps. */
function jsonPathSteps(path) {
  const src = String(path ?? "").trim();
  if (!src) throw new Error("the json path is empty");
  let i = src.startsWith("$") ? 1 : 0;
  const steps = [];
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = /^\.([A-Za-z0-9_-]+)/.exec(rest))) steps.push({ key: m[1] });
    else if ((m = /^\[(\d+)\]/.exec(rest))) steps.push({ index: Number(m[1]) });
    else if ((m = /^\[(['"])([^'"\]]+)\1\]/.exec(rest))) steps.push({ key: m[2] });
    else if ((m = /^\[\?\(@\.([A-Za-z0-9_-]+)\s*==\s*(['"])([^'"]*)\2\)\]/.exec(rest)))
      steps.push({ filterKey: m[1], filterValue: m[3] });
    else throw new Error(`the json path "${src.slice(0, 60)}" is not understood at position ${i}`);
    i += m[0].length;
    if (steps.length > 16) throw new Error("the json path is too long");
  }
  return steps;
}

const ownKey = (obj, key) =>
  key !== "__proto__" && obj !== null && typeof obj === "object" && Object.hasOwn(obj, key);

/** The one scalar a json path leads to, as text. A path that finds nothing, or finds a list or object, is an error. */
function queryJsonPath(doc, path) {
  let node = doc;
  for (const step of jsonPathSteps(path)) {
    if ("index" in step) {
      node = Array.isArray(node) ? node[step.index] : undefined;
    } else if ("filterKey" in step) {
      node = Array.isArray(node)
        ? node.find(
            (e) => ownKey(e, step.filterKey) && String(e[step.filterKey]) === step.filterValue,
          )
        : undefined;
    } else {
      node = ownKey(node, step.key) ? node[step.key] : undefined;
    }
    if (node === undefined || node === null)
      throw new Error(`the json path "${path}" found nothing`);
  }
  if (typeof node === "object")
    throw new Error(`the json path "${path}" leads to a list, not a version`);
  return node;
}

/** The most text a version pattern is run over; a version page is far smaller. */
const REGEX_TEXT_CAP = 512 * 1024;

/** A pattern that opens with `[\s\S]*`, `[^]*` or `.*` rescans the page from every start: quadratic, so refused. */
function assertLinearStart(text) {
  if (/^(?:\^)?(?:\[\\s\\S\]|\[\^\]|\.)[*+]/.test(text))
    throw new Error(
      "the pattern starts with an open-ended wildcard (it would scan the page quadratically)",
    );
}

/** The pattern of a text-line source: valid, not too long, no open-ended start. Never silently shortened. */
function textLineRegex(pattern) {
  const text = String(pattern ?? "");
  if (!text || text.length > 400) throw new Error("the pattern is empty or too long");
  assertLinearStart(text);
  try {
    return new RegExp(text);
  } catch {
    throw new Error(`the pattern "${text.slice(0, 40)}" is not a valid regular expression`);
  }
}

/** A regex with exactly one capture group (the version). Flags are limited to i, m, s, u and g. */
function oneGroupRegex(pattern, flags = "", forceGlobal = false) {
  const text = String(pattern ?? "");
  if (!text || text.length > 400) throw new Error("the pattern is empty or too long");
  assertLinearStart(text);
  if (!/^[gimsu]*$/.test(String(flags))) throw new Error("the pattern flags are not allowed");
  let probe;
  try {
    probe = new RegExp(`${text}|`, "");
  } catch {
    throw new Error(`the pattern "${text.slice(0, 40)}" is not a valid regular expression`);
  }
  if (probe.exec("").length !== 2)
    throw new Error(`the pattern "${text.slice(0, 40)}" must have exactly one capture group`);
  const all = new Set(String(flags));
  if (forceGlobal) all.add("g");
  return new RegExp(text, [...all].join(""));
}

/** The newest version of `matches` (first by default); text with no match is an error. */
function pickMatch(text, re, pick, strip) {
  const found = [];
  if (re.global) for (const m of text.matchAll(re)) found.push(m[1]);
  else {
    const m = re.exec(text);
    if (m) found.push(m[1]);
  }
  const versions = [];
  for (const raw of found) {
    try {
      versions.push(sanitizeVersion(raw, strip));
    } catch {
      /* a match that is not a version is skipped */
    }
  }
  if (!versions.length) throw new Error("the page has no version that fits the pattern");
  return pick === "highest" ? versions.sort((a, b) => compareVersions(b, a))[0] : versions[0];
}

/** Request headers of the readers that take whatever a vendor page answers. */
const PAGE_HEADERS = { accept: "text/html, application/json, text/plain;q=0.9, */*;q=0.5" };

/**
 * `ctx` is { fetchImpl, timeout, cond }. Each of these returns the same shape as the older readers (`{ value }`, or
 * `{ notModified }`) and the value is a version with NO files and NO digest: an answer like this may say "an update is
 * available" and may never authorise an install (see `authorisesInstall`).
 */
const DATA_READERS = {
  "json-path": async (s, ctx) => {
    const url = httpsUrl(s.url);
    const got = await httpGet(url, ctx);
    if (got.notModified) return got;
    const doc = parseJson(got.text, hostOf(url));
    return { ...got, value: versionOnly(sanitizeVersion(queryJsonPath(doc, s.path), s.strip)) };
  },
  "html-regex": async (s, ctx) => {
    const url = httpsUrl(s.url);
    const re = oneGroupRegex(s.pattern, s.flags, s.pick === "highest");
    const got = await httpGet(url, { ...ctx, headers: PAGE_HEADERS });
    if (got.notModified) return got;
    return {
      ...got,
      value: versionOnly(pickMatch(got.text.slice(0, REGEX_TEXT_CAP), re, s.pick, s.strip)),
    };
  },
  "text-line": async (s, ctx) => {
    const url = httpsUrl(s.url);
    const re = s.pattern ? textLineRegex(s.pattern) : null;
    const got = await httpGet(url, { ...ctx, headers: PAGE_HEADERS });
    if (got.notModified) return got;
    const lines = got.text
      .slice(0, REGEX_TEXT_CAP)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let raw;
    if (re) {
      for (const line of lines) {
        const m = re.exec(line);
        if (m) {
          raw = m[1] ?? m[0];
          break;
        }
      }
    } else raw = lines[Number(s.line) || 0];
    if (raw === undefined) throw new Error("the text has no line that fits");
    return { ...got, value: versionOnly(sanitizeVersion(raw, s.strip)) };
  },
  "redirect-regex": async (s, ctx) => {
    const url = httpsUrl(s.url);
    const re = oneGroupRegex(s.pattern, s.flags);
    const probe = { ...ctx, cond: null, bodyless: true };
    let got;
    try {
      got = await httpGet(url, { ...probe, method: "HEAD" });
    } catch (error) {
      if (!/answered (403|405|501)\b/.test(String(error?.message))) throw error;
      got = await httpGet(url, probe);
    }
    if (!got.url || got.url === url) throw new Error(`${hostOf(url)} did not redirect`);
    const m = re.exec(got.url);
    if (!m) throw new Error("the address it led to has no version that fits the pattern");
    return { ...got, value: versionOnly(sanitizeVersion(m[1], s.strip)) };
  },
  endoflife: async (s, ctx) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(s.product ?? "")))
      throw new Error("the endoflife product is not a plain name");
    const url = `https://endoflife.date/api/${s.product}.json`;
    const got = await httpGet(url, ctx);
    if (got.notModified) return got;
    const list = parseJson(got.text, "endoflife.date");
    if (!Array.isArray(list)) throw new Error("endoflife.date sent a document that is not a list");
    const entry =
      s.cycle !== undefined && s.cycle !== null
        ? list.find((e) => String(e?.cycle) === String(s.cycle))
        : list.find((e) => e && typeof e === "object" && e.latest);
    if (!entry?.latest)
      throw new Error(`endoflife.date has no release for ${s.cycle ?? s.product}`);
    return { ...got, value: versionOnly(sanitizeVersion(entry.latest, s.strip)) };
  },
  "scoop-manifest": async (s, ctx) => {
    const bucket = String(s.bucket || "Main");
    if (!/^[A-Za-z0-9._-]+$/.test(bucket) || !/^[A-Za-z0-9._@+-]+$/.test(String(s.name ?? "")))
      throw new Error("the scoop bucket or name is not a plain name");
    const url = `https://raw.githubusercontent.com/ScoopInstaller/${bucket}/master/bucket/${s.name}.json`;
    const got = await httpGet(url, { ...ctx, pathPrefix: "/ScoopInstaller/" });
    if (got.notModified) return got;
    const doc = parseJson(got.text, "raw.githubusercontent.com");
    return { ...got, value: versionOnly(sanitizeVersion(doc?.version, s.strip)) };
  },
};

/** Kinds that can appear twice in one row, so their stored validators are keyed by what they read. */
const storeKey = (spec) => {
  if (!DATA_READERS[spec.kind]) return spec.kind;
  const what = JSON.stringify([
    spec.url,
    spec.path,
    spec.pattern,
    spec.line,
    spec.product,
    spec.cycle,
    spec.name,
    spec.bucket,
  ]);
  return `${spec.kind}:${nodeCrypto.createHash("sha256").update(what).digest("hex").slice(0, 12)}`;
};

/** Only an answer that lists a file with a SHA-256 may start an install; a bare version may only notify. */
const authorisesInstall = (answer) =>
  Array.isArray(answer?.assets) && answer.assets.some((a) => a?.url && isSha(stripSha(a.sha256)));

/** Readers return `{ value }` (a fresh answer) or `{ notModified: true }`, plus the validators to send next time. */
const SOURCE_READERS = {
  ...DATA_READERS,
  // The pin is a kind of the table so every chain names only known kinds; `resolveLatest` reads it last, never live.
  pinned: async () => {
    throw new Error("the pinned version is not a live source");
  },
  "github-api": async (s, ctx) => {
    const got = await httpGet(`https://api.github.com/repos/${s.repo}/releases/latest`, {
      ...ctx,
      headers: { accept: "application/vnd.github+json" },
    });
    if (got.notModified) return got;
    return { ...got, value: parseGithubRelease(parseJson(got.text, "api.github.com"), s.strip) };
  },
  "github-atom": async (s, ctx) => {
    const got = await httpGet(`https://github.com/${s.repo}/releases.atom`, {
      ...ctx,
      headers: { accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
    });
    if (got.notModified) return got;
    return { ...got, value: parseAtomTag(got.text, s.strip, s.tagPattern) };
  },
  "github-list": async (s, ctx) => {
    const got = await httpGet(`https://api.github.com/repos/${s.repo}/releases?per_page=15`, {
      ...ctx,
      headers: { accept: "application/vnd.github+json" },
    });
    if (got.notModified) return got;
    return { ...got, value: parseGithubList(parseJson(got.text, "api.github.com"), s) };
  },
  "pypi-json": async (s, ctx) => {
    const got = await httpGet(`https://pypi.org/pypi/${s.pkg}/json`, ctx);
    if (got.notModified) return got;
    return { ...got, value: parsePypiJson(parseJson(got.text, "pypi.org"), s.platform) };
  },
  "pypi-simple": async (s, ctx) => {
    const got = await httpGet(`https://pypi.org/simple/${pepName(s.pkg)}/`, {
      ...ctx,
      headers: { accept: "application/vnd.pypi.simple.v1+json" },
    });
    if (got.notModified) return got;
    return { ...got, value: parsePypiSimple(parseJson(got.text, "pypi.org"), s.platform) };
  },
  npm: async (s, ctx) => {
    const got = await httpGet(`https://registry.npmjs.org/${s.pkg}/latest`, ctx);
    if (got.notModified) return got;
    return {
      ...got,
      value: {
        version: String(parseJson(got.text, "registry.npmjs.org").version || ""),
        assets: [],
      },
    };
  },
  "npm-mirror": async (s, ctx) => {
    const got = await httpGet(`https://registry.npmmirror.com/${s.pkg}/latest`, ctx);
    if (got.notModified) return got;
    return {
      ...got,
      value: {
        version: String(parseJson(got.text, "registry.npmmirror.com").version || ""),
        assets: [],
      },
    };
  },
  "hf-api": async (s, ctx) => {
    const got = await httpGet(`https://huggingface.co/api/models/${s.repo}?blobs=true`, ctx);
    if (got.notModified) return got;
    return { ...got, value: parseHfModel(parseJson(got.text, "huggingface.co"), s.repo) };
  },
  feed: async (s, ctx) => {
    const feed = await resolveFeed(s.id, {
      fetchImpl: ctx.fetchImpl,
      timeout: ctx.timeout,
      force: true,
    });
    if (!feed?.version) throw new Error(feedFailure(s.id) || "the vendor feed gave no answer");
    const install = feed.install;
    return {
      status: 200,
      value: {
        version: String(feed.version),
        assets: install
          ? [
              {
                name: decodeURIComponent(String(install.url).split("?")[0].split("/").pop() || ""),
                url: install.url,
                bytes: Number(feed.bytes) || 0,
                sha256: stripSha(install.sha256),
              },
            ]
          : [],
      },
    };
  },
};

/**
 * The answers kept between runs: `{ schema, rows: { id: { row, sources } } }` in one JSON file (the data root's
 * `cache/vendor-feeds.json`). Reads once, never throws, writes atomically and only when something changed.
 */
function createFeedStore({ file, fs: fsApi = nodeFs } = {}) {
  let data = null;
  let dirty = false;
  const load = () => {
    if (data) return data;
    data = { schema: STORE_SCHEMA, rows: {} };
    try {
      const parsed = JSON.parse(fsApi.readFileSync(file, "utf8"));
      if (parsed?.schema === STORE_SCHEMA && parsed.rows && typeof parsed.rows === "object")
        data = parsed;
    } catch {
      /* no file yet, or one that is damaged: start empty */
    }
    return data;
  };
  const slot = (id) => (load().rows[id] ||= { row: null, sources: {} });
  return {
    file,
    getRow: (id) => load().rows[id]?.row ?? null,
    putRow(id, row) {
      slot(id).row = row;
      dirty = true;
    },
    getSource: (id, key) => load().rows[id]?.sources?.[key] ?? null,
    putSource(id, key, entry) {
      slot(id).sources[key] = entry;
      dirty = true;
    },
    /** Oldest `checkedAt` over every row (the minimum), or null with no row: the age of the stalest row sets how old the whole catalogue is. */
    oldestCheckedAt() {
      const times = Object.values(load().rows)
        .map((r) => Number(r?.row?.checkedAt))
        .filter(Number.isFinite);
      return times.length ? Math.min(...times) : null;
    },
    ids: () => Object.keys(load().rows),
    flush() {
      if (!dirty || !file) return false;
      try {
        fsApi.mkdirSync(nodePath.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fsApi.writeFileSync(tmp, JSON.stringify(load()));
        fsApi.renameSync(tmp, file);
        dirty = false;
        return true;
      } catch {
        return false;
      }
    },
  };
}

const pinOf = (list) => list.find((s) => s?.kind === "pinned" && s.version) || null;

const stores = new Map();
/** The one feed store of a data root (`<root>/cache/vendor-feeds.json`), shared by the catalogue and the installers. */
function storeFor(root, options = {}) {
  const file = nodePath.join(String(root), "cache", "vendor-feeds.json");
  if (options.fresh) stores.delete(file);
  if (!stores.has(file)) stores.set(file, createFeedStore({ file, fs: options.fs }));
  return stores.get(file);
}

/**
 * A value read back from the store (a 304, a held version, the last answer when every source failed) is only trusted
 * again after a check: a plain version, https files, digests of the right shape, and, when the pin names the same
 * file for the same release, the same digest. A disagreement drops the files (the version may still be shown) and
 * a value that is not a version at all is dropped. Never throws.
 */
function trustStored(value, list = []) {
  if (!value || typeof value !== "object") return null;
  if (!/^[\w.+~:-]{1,128}$/.test(String(value.version ?? ""))) return null;
  const pin = list.find((s) => s?.kind === "pinned");
  const pinned = Array.isArray(pin?.assets) ? pin.assets : [];
  const sameRelease =
    Boolean(pin) &&
    (String(pin.version) === String(value.version) || Boolean(pin.tag && pin.tag === value.tag));
  const assets = [];
  let clash = false;
  for (const a of Array.isArray(value.assets) ? value.assets : []) {
    try {
      httpsUrl(a?.url);
    } catch {
      continue;
    }
    const digest = stripSha(a.sha256);
    if (digest && !isSha(digest)) continue;
    const mate = sameRelease ? pinned.find((p) => p?.name && p.name === a.name) : null;
    if (mate && isSha(stripSha(mate.sha256)) && stripSha(mate.sha256) !== digest) clash = true;
    assets.push({ ...a, sha256: digest });
  }
  return clash
    ? { ...value, assets: [], distrusted: "the stored digest differs from the pinned one" }
    : { ...value, assets };
}

/**
 * The newest version of one row, from the first source in `sources` that answers.
 * Order of fallbacks: each listed source; the last stored answer (marked `stale`); the `pinned` entry; an error.
 * `offline: true` skips the listed sources (cache, then pin only).
 */
async function resolveLatest(rowId, sources, options = {}) {
  const {
    fetchImpl = fetchCompat,
    store = null,
    now = Date.now,
    timeoutMs = SOURCE_TIMEOUT_MS,
    offline = false,
  } = options;
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && typeof s === "object");
  const attempts = [];
  const record = (entry) => attempts.push(entry);
  // Offline asks nobody: the stored answer, then the pin.
  for (const spec of offline ? [] : list) {
    if (spec.kind === "pinned") continue;
    const reader = SOURCE_READERS[spec.kind];
    if (!reader) {
      record({ source: spec.kind, ok: false, error: "unknown source kind" });
      continue;
    }
    const slot = storeKey(spec);
    const prior = store?.getSource(rowId, slot) || null;
    try {
      const got = await reader(spec, {
        fetchImpl,
        timeout: spec.timeoutMs ?? timeoutMs,
        cond:
          prior && !options.force ? { etag: prior.etag, lastModified: prior.lastModified } : null,
      });
      let value = got.value;
      const notModified = Boolean(got.notModified);
      if (notModified) {
        value = trustStored(prior?.value, list);
        if (!value) throw new Error("answered 304 but nothing trustworthy is stored");
      }
      if (!value?.version) throw new Error("answered without a version");
      // A source never takes the version back below what is stored or pinned (a stale mirror, a swapped page).
      const floor = [trustStored(prior?.value, list)?.version, pinOf(list)?.version]
        .filter(Boolean)
        .sort((a, b) => compareVersions(b, a))[0];
      if (!notModified && floor && compareVersions(value.version, floor) < 0)
        throw new Error(`answered ${value.version}, older than the known ${floor}`);
      const at = now();
      if (spec.requireDigest && !(value.assets || []).some((a) => isSha(a.sha256))) {
        // A version with no digest is usable only where the pin holds a digest for that exact tag.
        const pin = list.find((s2) => s2.kind === "pinned");
        if (pin?.tag && pin.tag === value.tag && pin.assets?.some((a) => isSha(a.sha256)))
          value = { ...value, assets: pin.assets };
        else throw new Error(`no SHA-256 is published for ${value.tag || value.version}`);
      }
      // Weekly cadence: a newer version is adopted at most once per `cadenceDays`; until then the adopted one stays.
      const cadenceMs = Number(spec.cadenceDays) > 0 ? Number(spec.cadenceDays) * DAY_MS : 0;
      const keptSince = Number(prior?.adoptedAt ?? prior?.at);
      let adoptedAt = at;
      let held = null;
      const kept = trustStored(prior?.value, list);
      if (kept && Number.isFinite(keptSince)) {
        if (kept.version === value.version) adoptedAt = keptSince;
        else if (
          cadenceMs &&
          compareVersions(value.version, kept.version) > 0 &&
          at - keptSince < cadenceMs
        ) {
          held = value.tag || value.version;
          value = kept;
          adoptedAt = keptSince;
        }
      }
      store?.putSource(rowId, slot, {
        etag: got.etag || (notModified ? prior?.etag : null) || null,
        lastModified: got.lastModified || (notModified ? prior?.lastModified : null) || null,
        value,
        at,
        adoptedAt,
      });
      store?.putRow(rowId, { value, source: spec.kind, checkedAt: at });
      store?.flush();
      return {
        ok: true,
        ...value,
        source: spec.kind,
        via: attempts.length ? "fallback" : "primary",
        stale: false,
        pinned: false,
        notModified,
        ...(held ? { held } : {}),
        checkedAt: at,
        attempts: [...attempts, { source: spec.kind, ok: true, status: got.status ?? 200 }],
      };
    } catch (error) {
      record({ source: spec.kind, ok: false, error: shortError(error) });
    }
  }
  const cached = store?.getRow(rowId);
  const cachedValue = trustStored(cached?.value, list);
  if (cachedValue) {
    return {
      ok: true,
      ...cachedValue,
      source: cached.source,
      via: "cache",
      stale: true,
      pinned: false,
      notModified: false,
      checkedAt: cached.checkedAt ?? null,
      attempts,
      error: "every source failed; this is the last answer",
    };
  }
  const pin = list.find((s) => s.kind === "pinned");
  if (pin?.version) {
    return {
      ok: true,
      version: String(pin.version),
      ...(pin.tag ? { tag: pin.tag } : {}),
      ...(pin.revision ? { revision: pin.revision } : {}),
      assets: Array.isArray(pin.assets) ? pin.assets : [],
      source: "pinned",
      via: "pinned",
      stale: false,
      pinned: true,
      notModified: false,
      checkedAt: null,
      attempts,
    };
  }
  const why = attempts.map((a) => `${a.source}: ${a.error}`).join("; ");
  return { ok: false, error: `no official source answered (${why || "none listed"})`, attempts };
}

/* ------------------------------------------------ the data files: config/tool-sources/*.json */

/** Hex length of each digest a data file may name. Only sha256 can start a download (`downloadVerified`). */
const DIGEST_LENGTH = { sha256: 64, sha512: 128 };
const TOOL_HOMES = ["friday-root", "machine", "npm-global"];
const TOOL_ARCHIVES = ["msi", "exe", "zip", "7z", "msix", "tar.gz", "tgz", "tar.xz"];
/** The fields a source of each reader kind must carry. */
const SOURCE_FIELDS = {
  "json-path": ["url", "path"],
  "html-regex": ["url", "pattern"],
  "text-line": ["url"],
  "redirect-regex": ["url", "pattern"],
  endoflife: ["product"],
  "scoop-manifest": ["name"],
  "github-api": ["repo"],
  "github-atom": ["repo"],
  "github-list": ["repo"],
  "pypi-json": ["pkg"],
  "pypi-simple": ["pkg"],
  npm: ["pkg"],
  "npm-mirror": ["pkg"],
  "hf-api": ["repo"],
  feed: ["id"],
};
const KNOWN_ROW_FIELDS = new Set([
  "home",
  "homeReason",
  "sources",
  "download",
  "silentInstall",
  "notifyOnly",
  "checked",
  "singleSourceReason",
]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "" && v.length <= 2000;

/** Why a source of a data file is not usable, or "" when it is. */
function sourceProblem(spec) {
  if (!isPlainObject(spec)) return "is not an object";
  const needs = SOURCE_FIELDS[spec.kind];
  if (!needs) {
    return `has an unknown reader kind "${String(spec.kind).slice(0, 40)}" (known: ${Object.keys(SOURCE_FIELDS).join(", ")})`;
  }
  for (const field of needs) if (!isText(spec[field])) return `(${spec.kind}) needs "${field}"`;
  if (spec.url !== undefined) {
    try {
      httpsUrl(spec.url);
    } catch (error) {
      return `(${spec.kind}) ${shortError(error)}`;
    }
  }
  if (spec.kind === "html-regex" || spec.kind === "redirect-regex") {
    try {
      oneGroupRegex(spec.pattern, spec.flags);
    } catch (error) {
      return `(${spec.kind}) ${shortError(error)}`;
    }
  }
  if (spec.kind === "text-line" && spec.pattern !== undefined) {
    try {
      textLineRegex(spec.pattern);
    } catch (error) {
      return `(text-line) ${shortError(error)}`;
    }
  }
  for (const field of ["strip", "tagPattern", "assetPattern"]) {
    if (spec[field] === undefined) continue;
    try {
      new RegExp(String(spec[field]));
    } catch {
      return `(${spec.kind}) "${field}" is not a valid regular expression`;
    }
  }
  if (spec.kind === "json-path") {
    try {
      jsonPathSteps(spec.path);
    } catch (error) {
      return `(json-path) ${shortError(error)}`;
    }
  }
  if (spec.kind === "feed" && !hasFeed(spec.id)) return `(feed) names no vendor feed "${spec.id}"`;
  return "";
}

/** Why a row of a data file is not usable, or "" when it is. */
function rowProblem(row) {
  if (!isPlainObject(row)) return "is not an object";
  if (!TOOL_HOMES.includes(row.home)) return `"home" must be one of ${TOOL_HOMES.join(", ")}`;
  if (!Array.isArray(row.sources) || !row.sources.length)
    return `"sources" must list at least one source`;
  for (const [i, spec] of row.sources.entries()) {
    const why = sourceProblem(spec);
    if (why) return `source ${i + 1} ${why}`;
  }
  if (row.download !== undefined) {
    const d = row.download;
    if (!isPlainObject(d)) return `"download" is not an object`;
    // A row may carry only how it is unpacked (the installer address comes from a vendor feed).
    if (d.urlTemplate !== undefined) {
      try {
        httpsUrl(String(d.urlTemplate).replace(/\{\w+\}/g, "x"));
      } catch {
        return `"download.urlTemplate" must be a plain https address`;
      }
    }
    if (d.digestAlgo !== undefined && !Object.hasOwn(DIGEST_LENGTH, d.digestAlgo))
      return `"download.digestAlgo" must be one of ${Object.keys(DIGEST_LENGTH).join(", ")}`;
    // `archive` is absent for a plain file (a model weight); when present it names how the file is unpacked.
    if (d.archive !== undefined && !TOOL_ARCHIVES.includes(d.archive))
      return `"download.archive" must be one of ${TOOL_ARCHIVES.join(", ")}`;
    if (d.digestUrl !== undefined) {
      try {
        httpsUrl(String(d.digestUrl).replace(/\{\w+\}/g, "x"));
      } catch {
        return `"download.digestUrl" must be a plain https address`;
      }
    }
    if (d.digestPath !== undefined && !isText(d.digestPath))
      return `"download.digestPath" must be text`;
  }
  for (const field of ["homeReason", "silentInstall", "checked", "singleSourceReason"]) {
    if (row[field] !== undefined && typeof row[field] !== "string")
      return `"${field}" must be text`;
  }
  if (row.notifyOnly !== undefined && typeof row.notifyOnly !== "boolean")
    return `"notifyOnly" must be true or false`;
  if (row.checked !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(row.checked))
    return `"checked" must be a date like 2026-11-27`;
  return "";
}

/**
 * One data file as plain rows. Never throws: a bad file or row becomes a plain message in `errors` and that row is
 * left out; the rest of the file still loads. `warnings` lists fields nobody reads (a likely typo).
 */
function validateToolSourceFile(doc, file = "file") {
  const rows = {};
  const errors = [];
  const warnings = [];
  if (!isPlainObject(doc) || doc.version !== 1 || !isPlainObject(doc.rows)) {
    errors.push(`${file}: must be {"version": 1, "rows": {...}}`);
    return { rows, errors, warnings };
  }
  for (const [id, row] of Object.entries(doc.rows)) {
    const why = rowProblem(row);
    if (why) {
      errors.push(`${file}: row "${id}" ${why}`);
      continue;
    }
    for (const field of Object.keys(row))
      if (!KNOWN_ROW_FIELDS.has(field))
        warnings.push(`${file}: row "${id}" has an unused field "${field}"`);
    // Without a digest source the file may be announced ("update available"), never installed from this row.
    if (row.download?.urlTemplate && !row.download.digestUrl && row.notifyOnly !== true)
      warnings.push(
        `${file}: row "${id}" has no digest source: it is not installable, only a notice`,
      );
    rows[id] = row;
  }
  return { rows, errors, warnings };
}

/** The folder of data files: next to the app when packaged, in the checkout in development. */
function defaultToolSourcesDir() {
  try {
    return require("./resource-paths.cjs").resolveResourceDir("config/tool-sources");
  } catch {
    return null;
  }
}

const toolSourcesCache = new Map();
const clearToolSources = () => toolSourcesCache.clear();

/**
 * Every row of `config/tool-sources/*.json`: `{ rows: { id: row }, errors, warnings, files }`. A missing folder is an
 * empty set; a file that cannot be read or parsed is one error. Rows with the same id in two files: the file that
 * sorts first wins and the second is reported. Read once per folder (`clearToolSources` forgets).
 */
function loadToolSources({ dir = defaultToolSourcesDir(), fs: fsApi = nodeFs } = {}) {
  const key = String(dir || "");
  if (toolSourcesCache.has(key)) return toolSourcesCache.get(key);
  const out = { rows: {}, errors: [], warnings: [], files: [] };
  let names = [];
  try {
    names = dir
      ? fsApi
          .readdirSync(dir)
          .filter((n) => n.endsWith(".json"))
          .sort()
      : [];
  } catch {
    names = [];
  }
  for (const name of names) {
    out.files.push(name);
    let doc;
    try {
      doc = JSON.parse(fsApi.readFileSync(nodePath.join(dir, name), "utf8"));
    } catch (error) {
      out.errors.push(`${name}: cannot be read as JSON (${shortError(error)})`);
      continue;
    }
    const got = validateToolSourceFile(doc, name);
    out.errors.push(...got.errors);
    out.warnings.push(...got.warnings);
    for (const [id, row] of Object.entries(got.rows)) {
      if (Object.hasOwn(out.rows, id))
        out.errors.push(`${name}: row "${id}" is already defined in an earlier file`);
      else out.rows[id] = row;
    }
  }
  toolSourcesCache.set(key, out);
  return out;
}

const sourcesOf = (options) => options?.toolSources || loadToolSources();

/** What a data file says about one row (home, download, silentInstall, notifyOnly, ...), or null when it has none. */
function rowSpec(id, options = {}) {
  const row = sourcesOf(options).rows[id];
  if (!row) return null;
  return {
    home: row.home,
    homeReason: row.homeReason || "",
    download: row.download || null,
    silentInstall: row.silentInstall || "",
    notifyOnly: row.notifyOnly === true,
    checked: row.checked || "",
    singleSourceReason: row.singleSourceReason || "",
    sources: row.sources,
  };
}

/** The home a tool row declares itself, else its data file does (`friday-root`, `machine`, `npm-global`), else null. */
function declaredHome(tool, options = {}) {
  if (!tool) return null;
  if (TOOL_HOMES.includes(tool.home)) return tool.home;
  return tool.id ? (rowSpec(tool.id, options)?.home ?? null) : null;
}

/** `{v}`, `{version}`, `{versionNoDots}`, `{major}`, `{minor}`, `{majorMinor}`, `{patch}` and any `extra` filled into a template. */
function expandTemplate(template, version, extra = {}) {
  const parts = String(version).split(".");
  const vars = {
    v: version,
    version,
    major: parts[0] ?? "",
    minor: parts[1] ?? "",
    majorMinor: parts.slice(0, 2).join("."),
    patch: parts[2] ?? "",
    versionNoDots: String(version).replace(/\./g, ""),
    ...extra,
  };
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    Object.hasOwn(vars, k) ? String(vars[k]) : m,
  );
}

/** The digest in a document: `sha256:` / `sha512:` prefixes and case ignored. */
const bareDigest = (value) =>
  String(value ?? "")
    .replace(/^sha\d+:/i, "")
    .trim()
    .toLowerCase();

/** The hash of `file` in a `hash  filename` list, else the first hex token of the right length in a plain text. */
function digestFromText(text, file, length) {
  const token = new RegExp(`^([a-f0-9]{${length}})(?:\\s+\\*?(.+?))?\\s*$`, "i");
  let first = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = token.exec(line.trim());
    if (m && file && m[2] === file) return m[1].toLowerCase();
    const loose = new RegExp(`(?:^|[^a-f0-9])([a-f0-9]{${length}})(?![a-f0-9])`, "i").exec(line);
    if (!first && loose && !m?.[2]) first = loose[1].toLowerCase();
  }
  return first;
}

/** Registries run by volunteers: their digests are a cross-check, never the only gate of an install. */
const isScoopUrl = (raw) => {
  try {
    const u = new URL(String(raw).replace(/\{\w+\}/g, "x"));
    return u.hostname === "raw.githubusercontent.com" && u.pathname.startsWith("/ScoopInstaller/");
  } catch {
    return false;
  }
};
const COMMUNITY_HOSTS = new Set(["community.chocolatey.org", "formulae.brew.sh", "endoflife.date"]);
const isCommunityUrl = (raw) => {
  if (isScoopUrl(raw)) return true;
  try {
    return COMMUNITY_HOSTS.has(new URL(String(raw).replace(/\{\w+\}/g, "x")).hostname);
  } catch {
    return false;
  }
};

/** A Scoop manifest only counts when its `version` and its 64-bit (or only) file are the ones being downloaded. */
function assertScoopManifest(doc, version, url) {
  const bare = (u) => String(u).split("#")[0].trim().toLowerCase();
  if (String(doc?.version ?? "").replace(/^v(?=\d)/, "") !== String(version))
    throw new Error(
      `the Scoop manifest is for ${String(doc?.version).slice(0, 30)}, not ${version}`,
    );
  const listed = [doc?.architecture?.["64bit"]?.url ?? doc?.url].flat().filter(Boolean);
  if (!listed.some((u) => bare(u) === bare(url)))
    throw new Error("the Scoop manifest names another file than the one being downloaded");
}

/**
 * The file URL and its digest for one version of a row's `download`. The digest comes from `digestUrl`: a JSON
 * document read with `digestPath` (an API, a scoop manifest), a `hash  filename` list, or a plain text whose first hex
 * token of the right length is the digest. `digestAlgo` is sha256 (default) or sha512. With no digest source, or no
 * digest found, the answer is `{ ok: false }` and nothing may be installed from it. `sha256` is set only for sha256.
 * A digest that only a community registry (Scoop, Chocolatey, Homebrew) holds carries `community: true`: a Scoop
 * manifest must name this version and this file, and the caller needs a signature check, not the digest, to install.
 */
async function resolveDownloadDigest(download, version, options = {}) {
  const { fetchImpl = fetchCompat, timeout = SOURCE_TIMEOUT_MS } = options;
  try {
    const v = sanitizeVersion(version);
    if (!download?.urlTemplate) throw new Error("the row has no download address");
    const url = httpsUrl(expandTemplate(download.urlTemplate, v));
    if (/\{\w+\}/.test(url)) throw new Error("the download address still has an unfilled field");
    const base = { url };
    if (!download.digestUrl)
      return {
        ok: false,
        ...base,
        error: "no digest source is listed for this file; it may only notify",
      };
    const algo = download.digestAlgo || "sha256";
    const length = DIGEST_LENGTH[algo];
    if (!length) throw new Error(`the digest kind "${algo}" is not supported`);
    const file = decodeURIComponent(url.split("?")[0].split("/").pop() || "");
    const digestUrl = httpsUrl(expandTemplate(download.digestUrl, v, { file }));
    const got = await httpGet(digestUrl, { fetchImpl, timeout, headers: PAGE_HEADERS });
    const community = isCommunityUrl(digestUrl);
    let doc = null;
    if (download.digestPath || isScoopUrl(digestUrl)) doc = parseJson(got.text, hostOf(digestUrl));
    // A registry kept by volunteers is a second opinion: its manifest must describe this very version and file.
    if (isScoopUrl(digestUrl)) assertScoopManifest(doc, v, url);
    const digest = download.digestPath
      ? bareDigest(queryJsonPath(doc, expandTemplate(download.digestPath, v, { file })))
      : digestFromText(got.text, file, length);
    if (!new RegExp(`^[a-f0-9]{${length}}$`).test(digest))
      throw new Error("the digest source has no digest of the right kind for this file");
    return {
      ok: true,
      ...base,
      algo,
      digest,
      ...(algo === "sha256" ? { sha256: digest } : {}),
      ...(community ? { community: true } : {}),
    };
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}

/**
 * The source list for a catalogue row: its own `sources` when it names them; else the sources of its data file
 * (`config/tool-sources`); else built from the registry it already records (`latest: { kind, ref }`). Then a vendor
 * feed when there is one (unless the file already lists it), then its pin.
 */
function chainFor(row, { platform, toolSources } = {}) {
  if (Array.isArray(row?.sources) && row.sources.length) return row.sources;
  const out = [];
  const latest = row?.latest;
  const plat = platform || row?.platform || null;
  const plain = (extra = {}) => ({ ...(plat ? { platform: plat } : {}), ...extra });
  const filed = row?.id ? sourcesOf({ toolSources }).rows[row.id] : null;
  if (filed) {
    out.push(...filed.sources.map((s) => ({ ...s })));
  } else if (latest?.kind === "pypi") {
    out.push(
      { kind: "pypi-json", pkg: latest.ref, ...plain() },
      { kind: "pypi-simple", pkg: latest.ref, ...plain() },
    );
  } else if (latest?.kind === "github") {
    const strip = latest.strip ? { strip: latest.strip } : {};
    out.push(
      { kind: "github-api", repo: latest.ref, ...strip },
      { kind: "github-atom", repo: latest.ref, ...strip },
    );
  } else if (latest?.kind === "npm") {
    out.push({ kind: "npm", pkg: latest.ref }, { kind: "npm-mirror", pkg: latest.ref });
  } else if (latest?.kind === "hf") {
    out.push({ kind: "hf-api", repo: latest.ref });
  }
  if (row?.id && hasFeed(row.id) && !out.some((x) => x.kind === "feed" && x.id === row.id))
    out.push({ kind: "feed", id: row.id });
  if (row?.pinnedLatest?.version) out.push({ kind: "pinned", ...row.pinnedLatest });
  return out;
}

/** Archives whose Windows signature can be checked after the download (Authenticode). */
const SIGNED_ARCHIVES = new Set(["exe", "msi", "msix"]);
/** One silent-install argument: letters, digits and `_ . : = + , / \\ -` only; no quote, redirect, pipe or variable. */
const SILENT_ARG = /^[A-Za-z0-9_.:=+,!/\\-]+$/;

/**
 * The silent-install switches of a row as an argument list (never one command line): the words after the program
 * name, each limited to `SILENT_ARG` after `{version}` and friends are filled. `null` when the text is empty or any
 * word is not plain (a `<dir>` placeholder, a `&`, a quote): then nothing is composed and nothing runs.
 */
function silentArgv(text, version) {
  // The program name may be quoted (it holds spaces); it is dropped, only the words after it are kept.
  const rest = String(text ?? "")
    .trim()
    .replace(/^"[^"]*"\s*/, "x ");
  const words = rest
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => expandTemplate(w, version));
  if (!words.length) return null;
  const args = /^[/-]/.test(words[0]) ? words : words.slice(1);
  if (!args.length || args.length > 16) return null;
  return args.every((a) => SILENT_ARG.test(a)) ? args : null;
}

/**
 * Whether a row's own download can start an install, without any network: `{ installable, reason }`. It needs an
 * address, a digest source (not only a community registry, unless the archive is signed), and for an `.exe` or
 * `.msix` plain silent switches. A row that is not installable may still say "update available".
 */
function downloadReadiness(spec) {
  const d = spec?.download;
  if (!d?.urlTemplate) return { installable: false, reason: "no download address" };
  if (spec.notifyOnly) return { installable: false, reason: "bundled: shows a newer version only" };
  if (!d.digestUrl) return { installable: false, reason: "no digest source is listed" };
  if (isCommunityUrl(d.digestUrl) && !SIGNED_ARCHIVES.has(d.archive))
    return { installable: false, reason: "only a community registry lists a digest" };
  if (d.archive === "exe" && !silentArgv(spec.silentInstall, "1.0"))
    return { installable: false, reason: "no plain silent-install switches" };
  return { installable: true, reason: "" };
}

/**
 * The verified download of one row's newest version from its data file: the version from the row's source chain
 * (stored answer when offline), the address from `download.urlTemplate`, the digest from `digestUrl` (read again, never
 * the cache), and the catalogue's pin must agree for the same version. Never installs anything; the caller downloads
 * the candidate with `downloadVerified`. `{ ok: false }` always says why, and `notifyOnly` rows never plan.
 *
 * options: { toolSources, sources (the chain; default chainFor), store, fetchImpl, now, pin: { version, sha256 } }
 */
async function planRowDownload(rowId, options = {}) {
  const spec = rowSpec(rowId, options);
  if (!spec?.download?.urlTemplate)
    return { ok: false, error: "the row has no download address in its data file" };
  if (spec.notifyOnly)
    return { ok: false, notifyOnly: true, error: "bundled: shows a newer version only" };
  const ready = downloadReadiness(spec);
  if (!ready.installable) return { ok: false, notifyOnly: true, error: ready.reason };
  const sources = options.sources || chainFor({ id: rowId }, { toolSources: options.toolSources });
  const answer = await resolveLatest(rowId, sources, {
    store: options.store,
    fetchImpl: options.fetchImpl,
    now: options.now,
    offline: options.offline,
  });
  if (!answer.ok) return { ok: false, error: answer.error };
  let version;
  try {
    version = sanitizeVersion(answer.version);
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
  const got = await resolveDownloadDigest(spec.download, version, {
    fetchImpl: options.fetchImpl,
  });
  if (!got.ok) return { ok: false, version, notifyOnly: true, error: got.error };
  if (got.community && !SIGNED_ARCHIVES.has(spec.download.archive))
    return {
      ok: false,
      version,
      notifyOnly: true,
      error: "only a community registry lists this file's digest; it may only notify",
    };
  const agreed = agreeOnDigest(options.pin, { version, sha256: got.sha256 });
  if (!agreed.ok) return { ok: false, version, error: agreed.error };
  const archive = spec.download.archive || "";
  let args = null;
  if (archive === "exe") {
    args = silentArgv(spec.silentInstall, version);
    if (!args) return { ok: false, version, error: "the row has no plain silent-install switches" };
  }
  return {
    ok: true,
    version,
    url: got.url,
    algo: got.algo,
    digest: got.digest,
    ...(got.sha256 ? { sha256: got.sha256 } : {}),
    archive,
    home: spec.home,
    source: hostOf(got.url),
    ...(args ? { args } : {}),
    ...(got.community ? { community: true, needsSignature: true } : {}),
  };
}

/**
 * Whether and when to ask the feeds again. Pure: the caller owns the clock, the jitter and the network state.
 * Daily (24 h) with a start delay under a minute so a fleet never asks at once; privacy and offline keep to the cache;
 * a manual refresh is immediate but not more often than once a minute.
 */
function planFeedRefresh({
  trigger = "startup",
  ageMs = null,
  jitterMs = 0,
  privacy = false,
  online = true,
  sinceManualMs = null,
} = {}) {
  const manual = trigger === "manual" || trigger === "foreground";
  if (privacy)
    return { refresh: false, delayMs: 0, reason: "privacy mode keeps the cached versions" };
  if (online === false)
    return {
      refresh: false,
      delayMs: 0,
      reason: "offline: the cached versions are shown, marked stale",
    };
  if (manual) {
    const since = Number(sinceManualMs);
    if (sinceManualMs !== null && Number.isFinite(since) && since >= 0 && since < MANUAL_MIN_MS) {
      return {
        refresh: false,
        delayMs: 0,
        retryInMs: MANUAL_MIN_MS - since,
        reason: "refreshed a moment ago; wait before asking again",
      };
    }
    return { refresh: true, delayMs: 0, reason: "the owner asked for a refresh" };
  }
  const age = Number(ageMs);
  if (ageMs !== null && Number.isFinite(age) && age < FEED_FRESH_MS) {
    return { refresh: false, delayMs: 0, reason: "the versions were checked within 24 hours" };
  }
  return {
    refresh: true,
    delayMs: Math.abs(Number(jitterMs) || 0) % 60_000,
    reason: "the versions are missing or older than 24 hours",
  };
}

/* ------------------------------------------------------- digest checks */

/** A digest the vendor published, as `{ algo, hex }`: 64 hex is SHA-256, 128 hex is SHA-512, anything else is none. */
function digestParts(value) {
  const hex = String(value ?? "")
    .replace(/^sha(?:256|512):/i, "")
    .trim()
    .toLowerCase();
  if (/^[a-f0-9]{64}$/.test(hex)) return { algo: "sha256", hex };
  if (/^[a-f0-9]{128}$/.test(hex)) return { algo: "sha512", hex };
  return null;
}

/** SHA-256 or SHA-512 of a file against the digest the vendor published (prefix and case ignored; the length says which). */
function verifyFile(file, expected, { fs: fsApi = nodeFs } = {}) {
  const want = digestParts(expected);
  if (!want)
    return Promise.resolve({ ok: false, error: "no SHA-256 or SHA-512 digest to check against" });
  const label = want.algo === "sha256" ? "SHA-256" : "SHA-512";
  return new Promise((resolve) => {
    const hash = nodeCrypto.createHash(want.algo);
    const stream = fsApi.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () =>
      resolve({ ok: false, error: "the downloaded file could not be read" }),
    );
    stream.on("end", () => {
      const actual = hash.digest("hex");
      resolve(
        actual === want.hex
          ? { ok: true, actual, algo: want.algo }
          : { ok: false, actual, algo: want.algo, error: `${label} digest mismatch` },
      );
    });
  });
}

/**
 * Download one file from the first candidate that delivers exactly the published digest. A candidate is
 * `{ url, sha256 | sha512, source }`; one without a digest is never fetched, a failed fetch moves to the next
 * candidate, and a file that hashes differently is deleted. Nothing is left in place unless the digest matched.
 * The downloader is told the SHA-256 when there is one; a SHA-512 is checked here, after the file arrived.
 */
async function downloadVerified(
  candidates,
  { download, dest, verify = verifyFile, fs: fsApi = nodeFs } = {},
) {
  const failures = [];
  const drop = () => {
    try {
      fsApi.rmSync(dest, { force: true });
    } catch {
      /* nothing to drop */
    }
  };
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const source = c?.source || "unknown";
    const want = digestParts(c?.sha256) || digestParts(c?.sha512);
    if (!c?.url || !want) {
      failures.push({
        source,
        error: "no SHA-256 digest was published for this file; nothing was downloaded",
      });
      continue;
    }
    try {
      await download(c.url, dest, {
        ...(want.algo === "sha256" ? { sha256: want.hex } : { sha512: want.hex }),
        source,
      });
    } catch (error) {
      drop();
      failures.push({ source, error: shortError(error) });
      continue;
    }
    const checked = await verify(dest, want.hex);
    if (checked.ok)
      return {
        ok: true,
        file: dest,
        source,
        algo: want.algo,
        digest: want.hex,
        sha256: want.algo === "sha256" ? want.hex : "",
        failures,
      };
    drop();
    failures.push({
      source,
      error: `${want.algo === "sha256" ? "SHA-256" : "SHA-512"} digest mismatch${checked.actual ? ` (got ${checked.actual.slice(0, 12)}...)` : ""}; the file was discarded`,
    });
  }
  const why = failures.map((f) => `${f.source}: ${f.error}`).join("; ");
  return {
    ok: false,
    error: `no source delivered a verified file (${why || "none listed"})`,
    failures,
  };
}

/** The official digest and the catalogue's pin must agree when they describe the same version. */
function agreeOnDigest(pinned, official) {
  if (!pinned?.sha256 || !official?.sha256 || String(pinned.version) !== String(official.version))
    return { ok: true };
  if (stripSha(pinned.sha256) === stripSha(official.sha256)) return { ok: true };
  return {
    ok: false,
    error: `the vendor's digest for ${official.version} differs from the pinned one; refusing the download`,
  };
}

module.exports = {
  FEEDS,
  hasFeed,
  feedIds,
  resolveFeed,
  clearFeedCache,
  githubRelease,
  feedFailure,
  hashFromSums,
  parseWingetUpgrade,
  newestAppcastVersion,
  compareDotted,
  // ordered source chains
  FEED_FRESH_MS,
  MANUAL_MIN_MS,
  SOURCE_TIMEOUT_MS,
  compareVersions,
  createFeedStore,
  storeFor,
  MAX_BODY_BYTES,
  SOURCE_READERS,
  resolveLatest,
  chainFor,
  rowSpec,
  declaredHome,
  loadToolSources,
  clearToolSources,
  validateToolSourceFile,
  authorisesInstall,
  resolveDownloadDigest,
  planRowDownload,
  downloadReadiness,
  silentArgv,
  digestParts,
  isCommunityUrl,
  trustStored,
  sanitizeVersion,
  queryJsonPath,
  planFeedRefresh,
  verifyFile,
  downloadVerified,
  agreeOnDigest,
  parsePypiJson,
  parsePypiSimple,
  parseGithubRelease,
  parseAtomTag,
  parseGithubList,
  parseHfModel,
};
