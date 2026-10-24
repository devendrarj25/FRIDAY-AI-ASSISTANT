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

/** `hash  filename` lines (SHASUMS256.txt, *.sha256) -> hash of one file. */
function hashFromSums(text, filename) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && (m[2] === filename || !filename)) return m[1].toLowerCase();
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
function githubFeed({ repo, asset, version, kind, installerArgs, bin }) {
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
      });
    }
    return out;
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

/** static.rust-lang.org: the stable channel names the version; rustup-init has a .sha256. */
async function rustFeed(options) {
  const toml = await getText("https://static.rust-lang.org/dist/channel-rust-stable.toml", options);
  const m = /\[pkg\.rust\][\s\S]*?\nversion = "(\d+\.\d+\.\d+)/.exec(toml);
  if (!m) return null;
  const out = { version: m[1], source: "rust-lang.org", kind: "exe" };
  const base = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe";
  try {
    const sha256 = hashFromSums(await getText(`${base}.sha256`, options), "") || null;
    if (sha256) {
      Object.assign(out, {
        url: base,
        sha256,
        installerArgs: ["-y", "--default-toolchain", "stable", "--profile", "minimal"],
      });
    }
  } catch {
    /* version only */
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
  } catch {
    value = null;
  }
  if (value) cache.set(toolId, { at: now, value });
  return value;
}

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

module.exports = {
  FEEDS,
  hasFeed,
  feedIds,
  resolveFeed,
  clearFeedCache,
  githubRelease,
  hashFromSums,
  parseWingetUpgrade,
};
