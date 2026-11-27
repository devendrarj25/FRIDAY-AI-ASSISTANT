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

/** One GET with a hard deadline (abort signal AND a race, for a fetch that ignores the signal). */
async function httpGet(
  url,
  { fetchImpl = fetchCompat, timeout = SOURCE_TIMEOUT_MS, headers = {}, cond = null } = {},
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
        return { ...meta, notModified: false, text: await res.text() };
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  if (strip) return text.replace(new RegExp(strip), "");
  return text.replace(/^v(?=\d)/, "");
}

function parseGithubRelease(json, strip) {
  const tag = String(json?.tag_name || "");
  if (!tag) throw new Error("the release has no tag");
  return {
    version: stripTag(tag, strip),
    tag,
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

/** Readers return `{ value }` (a fresh answer) or `{ notModified: true }`, plus the validators to send next time. */
const SOURCE_READERS = {
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

const stores = new Map();
/** The one feed store of a data root (`<root>/cache/vendor-feeds.json`), shared by the catalogue and the installers. */
function storeFor(root, options = {}) {
  const file = nodePath.join(String(root), "cache", "vendor-feeds.json");
  if (options.fresh) stores.delete(file);
  if (!stores.has(file)) stores.set(file, createFeedStore({ file, fs: options.fs }));
  return stores.get(file);
}

/**
 * The newest version of one row, from the first source in `sources` that answers.
 * Order of fallbacks: each listed source; the last stored answer (marked `stale`); the `pinned` entry; an error.
 */
async function resolveLatest(rowId, sources, options = {}) {
  const {
    fetchImpl = fetchCompat,
    store = null,
    now = Date.now,
    timeoutMs = SOURCE_TIMEOUT_MS,
  } = options;
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && typeof s === "object");
  const attempts = [];
  const record = (entry) => attempts.push(entry);
  for (const spec of list) {
    if (spec.kind === "pinned") continue;
    const reader = SOURCE_READERS[spec.kind];
    if (!reader) {
      record({ source: spec.kind, ok: false, error: "unknown source kind" });
      continue;
    }
    const prior = store?.getSource(rowId, spec.kind) || null;
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
        if (!prior?.value) throw new Error("answered 304 but nothing is stored");
        value = prior.value;
      }
      if (!value?.version) throw new Error("answered without a version");
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
      if (prior?.value?.version && Number.isFinite(keptSince)) {
        if (prior.value.version === value.version) adoptedAt = keptSince;
        else if (
          cadenceMs &&
          compareVersions(value.version, prior.value.version) > 0 &&
          at - keptSince < cadenceMs
        ) {
          held = value.tag || value.version;
          value = prior.value;
          adoptedAt = keptSince;
        }
      }
      store?.putSource(rowId, spec.kind, {
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
  if (cached?.value?.version) {
    return {
      ok: true,
      ...cached.value,
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

/**
 * The source list for a catalogue row: its own `sources` when it names them, else built from the registry it already
 * records (`latest: { kind, ref }`), then a vendor feed when there is one, then its pin.
 */
function chainFor(row, { platform } = {}) {
  if (Array.isArray(row?.sources) && row.sources.length) return row.sources;
  const out = [];
  const latest = row?.latest;
  const plat = platform || row?.platform || null;
  const plain = (extra = {}) => ({ ...(plat ? { platform: plat } : {}), ...extra });
  if (latest?.kind === "pypi") {
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
  if (row?.id && hasFeed(row.id)) out.push({ kind: "feed", id: row.id });
  if (row?.pinnedLatest?.version) out.push({ kind: "pinned", ...row.pinnedLatest });
  return out;
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

/** SHA-256 of a file against the digest the vendor published ("sha256:" prefix and case ignored). */
function verifyFile(file, expected, { fs: fsApi = nodeFs } = {}) {
  const want = stripSha(expected);
  if (!isSha(want))
    return Promise.resolve({ ok: false, error: "no SHA-256 digest to check against" });
  return new Promise((resolve) => {
    const hash = nodeCrypto.createHash("sha256");
    const stream = fsApi.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () =>
      resolve({ ok: false, error: "the downloaded file could not be read" }),
    );
    stream.on("end", () => {
      const actual = hash.digest("hex");
      resolve(
        actual === want
          ? { ok: true, actual }
          : { ok: false, actual, error: "SHA-256 digest mismatch" },
      );
    });
  });
}

/**
 * Download one file from the first candidate that delivers exactly the published digest. A candidate is
 * `{ url, sha256, source }`; one without a digest is never fetched, a failed fetch moves to the next candidate, and
 * a file that hashes differently is deleted. Nothing is left in place unless the digest matched.
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
    if (!c?.url || !isSha(stripSha(c.sha256))) {
      failures.push({
        source,
        error: "no SHA-256 digest was published for this file; nothing was downloaded",
      });
      continue;
    }
    try {
      await download(c.url, dest, { sha256: stripSha(c.sha256), source });
    } catch (error) {
      drop();
      failures.push({ source, error: shortError(error) });
      continue;
    }
    const checked = await verify(dest, c.sha256);
    if (checked.ok) return { ok: true, file: dest, source, sha256: stripSha(c.sha256), failures };
    drop();
    failures.push({
      source,
      error: `SHA-256 digest mismatch${checked.actual ? ` (got ${checked.actual.slice(0, 12)}...)` : ""}; the file was discarded`,
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
  resolveLatest,
  chainFor,
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
