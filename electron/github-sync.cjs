// FRIDAY · GitHub update source.
//
// Connects the FRIDAY workspace to its own repository (public or private) so
// updates can arrive the same way any desktop app receives them: check the
// remote ref, download the source archive, hand it to the existing importer
// (electron/importer.cjs) which backs up, diffs and applies it, then record
// which ref is installed so the next check knows what changed.
//
// Nothing here writes into the workspace directly — the importer owns every
// write, backup and rollback. The GitHub token is NOT part of this config: it
// lives encrypted in the canonical credential store
// (<FRIDAY_ROOT>/security/credentials), handled by electron/credentials.cjs.
const fs = require("fs");
const path = require("path");
// One semver implementation for the whole release system (workflow + desktop).
const { compareBuilds } = require(path.resolve(__dirname, "..", "scripts", "release-engine.cjs"));

const credentials = require("./credentials.cjs");

const API = "https://api.github.com";

/** The one credential id used by the whole GitHub release/update system. */
const TOKEN_ID = "github.token";

const configFile = (root) => path.join(root, "config", "github.json");

/** owner/name, including when the owner pastes a github.com URL. */
function normalizeRepo(repo) {
  let value = String(repo || "").trim();
  value = value.replace(/^git@github\.com:/i, "");
  value = value.replace(/^ssh:\/\/git@github\.com\//i, "");
  value = value.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/\/+$/, "");
  const parts = value.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return value;
}

function sameRepo(a, b) {
  return (
    normalizeRepo(a).toLowerCase() === normalizeRepo(b).toLowerCase() && Boolean(normalizeRepo(a))
  );
}

function loadConfig(root, override = {}) {
  const cfg = { ...readConfig(root), ...override };
  cfg.repo = normalizeRepo(cfg.repo);
  return cfg;
}

const DEFAULTS = {
  repo: "", // "owner/name"
  branch: "main",
  channel: "branch", // "branch" | "release" — a packaged FRIDAY is forced to "release"
  // Update channel — the ONE switch that decides which published builds this
  // FRIDAY is even allowed to see:
  //   stable → official GitHub Releases only (default, production)
  //   test   → test/pre-release builds only, always labelled TEST
  // The two channels keep separate installed-ref state so switching back to
  // stable hides every test build again and never mixes the two histories.
  updateChannel: "stable",
  autoCheck: false,
  intervalHours: 6,
  autoApply: false, // when false FRIDAY asks before applying
  // FRIDAY never pushes source on her own. A push happens only when the owner
  // asks for it on Friday Hub; this stays false unless it is turned on
  // deliberately, and even then every push is an explicit action.
  autoPush: false,
  appliedRef: null, // sha or tag currently installed (stable channel)
  appliedAt: 0,
  testAppliedRef: null, // last test build installed — never touches stable state
  testAppliedAt: 0,
  lastCheck: 0,
  history: [],
};

/** Only these two values may ever reach disk as the update channel. */
const normalizeUpdateChannel = (value) =>
  String(value || "")
    .trim()
    .toLowerCase() === "test"
    ? "test"
    : "stable";

/**
 * Is this published release a TEST build rather than an official release?
 * A release counts as test when GitHub marks it pre-release, or when its tag,
 * name or artifacts identify it as a test/branch build.
 */
function isTestRelease(release = {}) {
  if (release.prerelease === true) return true;
  const text = `${release.tag_name || release.tag || ""} ${release.name || ""}`.toLowerCase();
  if (/(^|[-_/])(test|rc|beta|alpha|nightly|preview)([-_.0-9]|$)/.test(text)) return true;
  return (release.assets || []).some((a) => /friday-test/i.test(a.name || ""));
}

/** Read the stored config on disk (token excluded — it is never kept here). */
function readStored(root) {
  if (!root) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configFile(root), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Config + the decrypted token, for main-process use only.
 * A token found in a historical github.json is moved into the encrypted store
 * once and erased from the config file.
 */
function readConfig(root) {
  const stored = readStored(root);
  if (!root) return { ...stored, token: "" };
  if (stored.token) {
    credentials.adoptLegacySecret(root, TOKEN_ID, stored.token);
    delete stored.token;
    try {
      fs.writeFileSync(configFile(root), JSON.stringify(stored, null, 2));
    } catch {
      /* the credential store is authoritative from now on regardless */
    }
  }
  return { ...stored, token: credentials.getSecret(root, TOKEN_ID) };
}

function writeConfig(root, patch) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const { token, ...rest } = patch || {};
  // A token in the patch never reaches disk as plain config — it is encrypted.
  if (token !== undefined) {
    const saved = credentials.setSecret(root, TOKEN_ID, token || "");
    if (!saved.ok) return saved;
  }
  const next = { ...readStored(root), ...rest };
  delete next.token;
  if (Array.isArray(next.connections)) next.connections = sanitizeConnections(next.connections);
  // Anything unknown collapses to stable: the safe, official-releases-only side.
  next.updateChannel = normalizeUpdateChannel(next.updateChannel);

  if (typeof next.repo === "string") next.repo = normalizeRepo(next.repo);
  fs.mkdirSync(path.dirname(configFile(root)), { recursive: true });
  fs.writeFileSync(configFile(root), JSON.stringify(next, null, 2));
  return {
    ok: true,
    config: { ...publicConfig(next), hasToken: credentials.hasSecret(root, TOKEN_ID) },
  };
}

/** The renderer never receives the token itself, only whether one is stored. */
function publicConfig(cfg) {
  const { token, connections, selectedConnectionId, selfPrivate, ...rest } = cfg;
  return {
    ...rest,
    hasToken: Boolean(token) || (rest.tokenStored ?? false),
    encryptedStore: credentials.encryptionAvailable(),
  };
}

async function api(cfg, endpoint, { method = "GET", body } = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "FRIDAY",
    "x-github-api-version": "2022-11-28",
  };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (body) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`${API}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // No network, DNS or proxy failure — this is not an auth problem, so the
    // stored credential must never be discarded because of it.
    return {
      ok: false,
      status: 0,
      offline: true,
      error: "GitHub is unreachable — FRIDAY is offline or blocked by the network.",
      detail: String(error?.message || error),
    };
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const reason =
      res.status === 404
        ? "Repository not found — check the name, and add a token if it is private."
        : res.status === 401 || res.status === 403
          ? parsed?.message ||
            "GitHub rejected the token. A FRIDAY token needs fine-grained permissions Contents: Read and write, Actions: Read and write on this repository."
          : parsed?.message || `GitHub error ${res.status}`;
    return { ok: false, status: res.status, error: reason };
  }

  return { ok: true, status: res.status, body: parsed };
}

/** Verify the connection and report what FRIDAY can see. */
async function testConnection(root, override = {}) {
  const cfg = loadConfig(root, override);
  if (!cfg.repo) return { ok: false, error: "Enter a repository as owner/name." };
  const repo = await api(cfg, `/repos/${cfg.repo}`);
  if (!repo.ok) return repo;

  // A release needs more than read access: Contents (push) to tag and commit
  // the version, and Actions to start the Release / Build workflow.
  const perms = repo.body.permissions || {};
  const contents = Boolean(perms.push || perms.admin || perms.maintain);
  const workflow = cfg.token
    ? await api(cfg, `/repos/${cfg.repo}/actions/workflows/release.yml`)
    : { ok: false, status: 401 };
  const actions = Boolean(workflow.ok);

  return {
    ok: true,
    repo: repo.body.full_name,
    private: Boolean(repo.body.private),
    defaultBranch: repo.body.default_branch,
    pushedAt: repo.body.pushed_at,
    authenticated: Boolean(cfg.token),
    permissions: {
      contents,
      actions,
      releaseWorkflow: actions,
    },
    canRelease: Boolean(cfg.token) && contents && actions,
    warning: !cfg.token
      ? "Read-only: add a fine-grained token with Contents: Read and write and Actions: Read and write to release."
      : !contents
        ? "The token can read this repository but cannot write — set Contents: Read and write on the token."
        : !actions
          ? "The Release / Build workflow is not reachable — push .github/workflows/release.yml and set Actions: Read and write on the token."
          : "",
  };
}

// ------------------------------------------------------- persistent session
/**
 * FRIDAY is single-user and private: the owner enters the token once and it
 * stays. This is the one place that decides what "connected" means, so the
 * renderer never has to hold or re-ask for the credential.
 *
 *   connected        — repository reachable (public without a token, or with
 *                      the stored credential for private / rate-limited access)
 *   auth-failed      — GitHub rejected the stored token (401/403)
 *   reauth-required  — the repo is private or blocked and no usable token is stored
 *   offline          — GitHub could not be reached; the credential is kept
 *   not-configured   — no repository yet
 */
let session = {
  state: "unknown",
  repo: "",
  at: 0,
  message: "",
  canRelease: false,
  hasToken: false,
  private: false,
};

const sessionSnapshot = () => ({ ...session });

function setSession(next) {
  // Replace, do not merge: a later public connect must not keep private: true
  // from the previous session.
  session = {
    state: "unknown",
    repo: "",
    message: "",
    canRelease: false,
    hasToken: false,
    private: false,
    ...next,
    at: Date.now(),
  };
  return sessionSnapshot();
}

/**
 * Load the stored credential and verify the configured repository. Called at
 * startup and after any change; it never clears the token, not even on a
 * failure — only the owner may replace or remove it.
 */
async function connect(root, override = {}) {
  const cfg = loadConfig(root, override);
  if (!cfg.repo)
    return setSession({
      state: "not-configured",
      repo: "",
      message: "No repository is configured yet.",
      canRelease: false,
      hasToken: Boolean(cfg.token),
    });

  // Public repos are reachable without a token. Skipping the live check used to
  // mark every token-less repo as reauth-required, so a successful public
  // Test connection never persisted as CONNECTED across refresh or restart.
  const test = await testConnection(root, override);
  const hasToken = Boolean(cfg.token);
  if (test.ok)
    return setSession({
      state: "connected",
      repo: test.repo,
      private: test.private,
      message: test.warning || "",
      canRelease: Boolean(test.canRelease),
      hasToken,
    });
  if (test.offline || test.status === 0)
    return setSession({
      state: "offline",
      repo: cfg.repo,
      message: test.error || "GitHub is unreachable.",
      canRelease: false,
      hasToken,
    });
  if (!hasToken)
    return setSession({
      state: "reauth-required",
      repo: cfg.repo,
      message: test.error || "A GitHub token is required for this private repository.",
      canRelease: false,
      hasToken: false,
    });
  return setSession({
    state: test.status === 401 || test.status === 403 ? "auth-failed" : "reauth-required",
    repo: cfg.repo,
    message: test.error || "GitHub refused the stored credential.",
    canRelease: false,
    hasToken: true,
  });
}

/** Current session without touching the network (used by the settings UI). */
const connection = () => sessionSnapshot();

const API_ASSET_URL = /^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)/i;

/**
 * Normalize a GitHub release asset so later steps can use the API asset URL
 * (required for private repos) without inferring the channel from a filename.
 */
function mapReleaseAsset(a = {}) {
  const apiMatch = String(a.apiUrl || a.url || "").match(API_ASSET_URL);
  const apiUrl = a.apiUrl || (apiMatch ? apiMatch[0] : null);
  const browser =
    a.browser_download_url || (apiMatch && String(a.url || "") === apiMatch[0] ? "" : a.url) || "";
  const idNum = a.id != null ? Number(a.id) : apiMatch ? Number(apiMatch[1]) : Number.NaN;
  return {
    name: a.name || "",
    url: browser || String(a.url || a.browser_download_url || ""),
    apiUrl: apiUrl || null,
    id: Number.isFinite(idNum) ? idNum : null,
    bytes: Number(a.size ?? a.bytes ?? 0) || 0,
  };
}

/** Prefer the GitHub API asset endpoint; fall back to the browser download URL. */
function assetDownloadUrl(asset, repo) {
  if (!asset) return "";
  if (asset.apiUrl) return asset.apiUrl;
  if (asset.id && repo) return `${API}/repos/${repo}/releases/assets/${asset.id}`;
  return asset.url || "";
}

function isGithubApiUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase() === "api.github.com";
  } catch {
    return false;
  }
}

/**
 * Authorization is sent only to api.github.com. GitHub's CDN rejects a
 * forwarded Bearer token after the 302 to objects.githubusercontent.com.
 */
function downloadHeaders(url, token, extra = {}) {
  const headers = { "user-agent": "FRIDAY", accept: "application/octet-stream", ...extra };
  delete headers.authorization;
  if (token && isGithubApiUrl(url)) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function cancelBody(res) {
  if (res?.body && typeof res.body.cancel === "function") {
    try {
      await res.body.cancel();
    } catch {
      /* already consumed */
    }
  }
}

async function fetchFollowRedirects(url, { token = "", extraHeaders = {}, range = "" } = {}) {
  let current = url;
  for (let hop = 0; hop < 12; hop++) {
    const headers = downloadHeaders(current, token, extraHeaders);
    if (range) headers.range = range;
    const res = await fetch(current, { method: "GET", headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (location && res.status >= 300 && res.status < 400) {
      await cancelBody(res);
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error("GitHub redirected too many times while downloading the installer.");
}

function sha256File(file) {
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function looksLikeHtmlFile(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(96);
  let n = 0;
  try {
    n = fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const head = buf.subarray(0, n).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}

function downloadStatusError(status) {
  if (status === 404) {
    return "GitHub could not find that installer (404). If the repository is private, add a token with Contents: Read.";
  }
  if (status === 401 || status === 403) {
    return "GitHub rejected the download. Check the stored token has Contents: Read on this repository.";
  }
  return `Installer download failed (${status})`;
}

async function streamResponseToFile(res, file, { append = false, onChunk = () => {} } = {}) {
  const startSize = append && fs.existsSync(file) ? fs.statSync(file).size : 0;
  const fd = fs.openSync(file, append ? "a" : "w");
  let received = startSize;
  const addLength = Number(res.headers.get("content-length") || 0);
  const total = append && addLength ? startSize + addLength : addLength;
  try {
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        fs.writeSync(fd, chunk);
        received += chunk.length;
        onChunk(received, total);
      }
    } else {
      const chunk = Buffer.from(await res.arrayBuffer());
      fs.writeSync(fd, chunk);
      received += chunk.length;
      onChunk(received, total);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { received, total };
}

function commitPartFile(part, dest) {
  const verified = `${dest}.verified`;
  fs.rmSync(verified, { force: true });
  fs.renameSync(part, verified);
  fs.rmSync(dest, { force: true });
  fs.renameSync(verified, dest);
}

/**
 * The release manifest published beside the EXE (friday-update.json). It holds
 * the SHA-256 of every artifact, so an installed FRIDAY can prove the file it
 * downloaded is the file GitHub Actions built. A release without a manifest is
 * treated as unverified, never as trusted.
 */
async function releaseManifest(cfg, assets = []) {
  const asset = assets.find((a) => /friday-update\.json$/i.test(a.name || ""));
  if (!asset) return null;
  const url = assetDownloadUrl(asset, cfg.repo);
  if (!url) return null;
  try {
    const res = await fetchFollowRedirects(url, { token: cfg.token || "" });
    if (!res.ok) {
      await cancelBody(res);
      return null;
    }
    const body = await res.json();
    return body && Array.isArray(body.assets) ? body : null;
  } catch {
    return null;
  }
}

/** The published SHA-256 for one asset name, when the release carries one. */
const expectedChecksum = (manifest, name) =>
  (manifest?.assets || []).find((a) => a.name === name)?.sha256 || null;

/** Which remote ref is current, and is it different from what is installed? */
async function checkUpdate(root, override = {}) {
  const cfg = loadConfig(root, override);
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };

  if (cfg.channel === "release") {
    const wantTest = normalizeUpdateChannel(cfg.updateChannel) === "test";
    // ONE listing, then the channel decides what is even visible. A stable
    // FRIDAY can never see a test build, and a test channel never offers an
    // official release as if it were a test build.
    const list = await api(cfg, `/repos/${cfg.repo}/releases?per_page=30`);
    if (!list.ok) return list;
    const published = (list.body || []).filter((r) => !r.draft);
    // "Newest" is a BUILD ordering, not a publish date: 1.3.1 < 1.3.2-test.1 <
    // 1.3.2-test.2 < 1.3.2. Re-publishing an older iteration later can never
    // make it the offered update. The date only breaks exact ties.
    const newest = (rows) =>
      rows.sort((a, b) => {
        const byVersion = compareBuilds(b.tag_name, a.tag_name);
        if (byVersion !== 0) return byVersion;
        return (
          (Date.parse(b.published_at || b.created_at || "") || 0) -
          (Date.parse(a.published_at || a.created_at || "") || 0)
        );
      })[0];

    const visible = published.filter((r) => isTestRelease(r) === wantTest);
    const body = newest(visible);
    const appliedRef = wantTest ? cfg.testAppliedRef : cfg.appliedRef;

    // The other channel is never installed silently and never shown as "the"
    // update — but the owner may explicitly cross over (Stable ⇄ Test), so the
    // newest build over there is reported alongside, fully described.
    const otherRaw = newest(published.filter((r) => isTestRelease(r) !== wantTest));
    const describe = async (release, isTest) => {
      if (!release) return null;
      const ref = release.tag_name;
      const assets = (release.assets || []).map(mapReleaseAsset);
      const manifest = await releaseManifest(cfg, assets);
      return {
        ref,
        shortRef: ref,
        version: String(ref || "").replace(/^v/i, ""),
        testBuild: Boolean(isTest),
        updateChannel: isTest ? "test" : "stable",
        label: isTest ? "TEST BUILD" : "Official release",
        title: release.name || ref,
        notes: release.body || "",
        at: Date.parse(release.published_at || "") || Date.now(),
        author: release.author?.login || "",
        assets,
        manifest,
        verified: Boolean(manifest),
        requiresChannelSwitch: true,
      };
    };
    const otherChannel = await describe(otherRaw, !wantTest);

    if (!body) {
      writeConfig(root, { lastCheck: Date.now() });
      return {
        ok: true,
        channel: "release",
        updateChannel: wantTest ? "test" : "stable",
        testBuild: wantTest,
        updateAvailable: false,
        appliedRef,
        assets: [],
        currentVersion: String(cfg.currentVersion || "").trim() || null,
        title: wantTest
          ? "No test build has been published for this repository."
          : "No official release has been published yet.",
        notes: "",
        otherChannel,
      };
    }
    const ref = body.tag_name;
    // Releases are versions, not refs: an update exists only when the published
    // release is NEWER than the version running here. FRIDAY never downgrades
    // on her own — on either channel; a re-run of the same version is not an
    // update either.
    //
    // A TEST build is a real SemVer prerelease of the version it tests
    // (1.3.2-test.2), so the full build ordering decides on BOTH channels:
    //   1.3.1 < 1.3.2-test.1 < 1.3.2-test.2 < 1.3.2
    // TEST → newer TEST, TEST → the official build of the same line and
    // OFFICIAL → newer OFFICIAL are all upgrades; the same build, an older
    // iteration or an older line never is.
    const current = String(cfg.currentVersion || "").trim();
    const compared = current ? compareBuilds(ref, current) : 1;
    const newer = current ? compared > 0 : ref !== appliedRef;

    const assets = (body.assets || []).map(mapReleaseAsset);
    // The release manifest (scripts/release-manifest.cjs) carries the SHA-256
    // of every published artifact. Without it an update is "unverified" and the
    // installer is never run without the owner accepting that explicitly.
    const manifest = await releaseManifest(cfg, assets);
    const result = {
      ok: true,
      channel: "release",
      updateChannel: wantTest ? "test" : "stable",
      testBuild: wantTest,
      // A test build is only ever installed when the owner asks for it in the
      // TEST channel — nothing about it is automatic.
      requiresExplicitInstall: wantTest,
      label: wantTest ? "TEST BUILD" : "Official release",
      ref,
      shortRef: ref,
      version: String(ref || "").replace(/^v/i, ""),
      currentVersion: current || null,
      title: body.name || ref,
      notes: body.body || "",
      at: Date.parse(body.published_at || "") || Date.now(),
      author: body.author?.login || "",
      zipUrl: `${API}/repos/${cfg.repo}/zipball/${encodeURIComponent(ref)}`,
      assets,
      manifest,
      verified: Boolean(manifest),
      updateAvailable: newer && ref !== appliedRef,
      appliedRef,
      otherChannel,
    };
    writeConfig(root, { lastCheck: Date.now() });
    return result;
  }

  const branch = cfg.branch || "main";
  const head = await api(cfg, `/repos/${cfg.repo}/commits/${encodeURIComponent(branch)}`);
  if (!head.ok) return head;
  const ref = head.body.sha;
  let changedFiles = [];
  if (cfg.appliedRef && cfg.appliedRef !== ref) {
    const diff = await api(
      cfg,
      `/repos/${cfg.repo}/compare/${encodeURIComponent(cfg.appliedRef)}...${encodeURIComponent(ref)}`,
    );
    if (diff.ok) {
      changedFiles = (diff.body.files || []).map((f) => ({
        path: f.filename,
        state: f.status,
        changes: f.changes,
      }));
    }
  }
  writeConfig(root, { lastCheck: Date.now() });
  return {
    ok: true,
    channel: "branch",
    ref,
    shortRef: ref.slice(0, 7),
    title: (head.body.commit?.message || "").split("\n")[0],
    notes: head.body.commit?.message || "",
    at: Date.parse(head.body.commit?.committer?.date || "") || Date.now(),
    author: head.body.commit?.author?.name || head.body.author?.login || "",
    zipUrl: `${API}/repos/${cfg.repo}/zipball/${encodeURIComponent(ref)}`,
    assets: [],
    changedFiles,
    updateAvailable: ref !== cfg.appliedRef,
    appliedRef: cfg.appliedRef,
  };
}

/**
 * Download the archive for a ref and stage it through the normal importer, so
 * a GitHub update is reviewed, diffed and applied exactly like a manual ZIP.
 */
async function pullUpdate({ root, importer, ref, onProgress = () => {} }) {
  const cfg = loadConfig(root);
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };
  const target = ref || (await checkUpdate(root))?.ref;
  if (!target) return { ok: false, error: "Could not resolve a ref to download." };

  onProgress({ phase: "Downloading from GitHub" });
  const url = `${API}/repos/${cfg.repo}/zipball/${encodeURIComponent(target)}`;
  const download = await importer.downloadArchive({
    root,
    url,
    name: `github-${cfg.repo.replace("/", "-")}-${String(target).slice(0, 12)}`,
    token: cfg.token || undefined,
  });
  if (!download.ok) return download;

  onProgress({ phase: "Scanning update" });
  const scan = await importer.scanImport({ root, source: download.file, onProgress });
  if (!scan.ok) return scan;
  return { ...scan, githubRef: target, repo: cfg.repo, bytes: download.bytes };
}

/**
 * Remember which ref is installed once the importer reports success.
 * Stable and test keep separate installed refs, so a test build never claims to
 * be the installed stable version (and switching channels restores the right
 * baseline instead of mixing the two).
 */
function recordApplied(root, { ref, applied = 0, areas = [], backup = null, notes = "", channel }) {
  const cfg = readConfig(root);
  const target = normalizeUpdateChannel(channel ?? cfg.updateChannel);
  const entry = { ref, at: Date.now(), applied, areas, backup, notes, channel: target };
  const history = [entry, ...(cfg.history || [])].slice(0, 40);
  writeConfig(
    root,
    target === "test"
      ? { testAppliedRef: ref, testAppliedAt: entry.at, history }
      : { appliedRef: ref, appliedAt: entry.at, history },
  );
  return { ok: true, entry };
}

/**
 * Pick the Windows installer published with a release, so an installed EXE can
 * upgrade itself to the next EXE instead of only pulling source.
 */
function installerAsset(assets = []) {
  const list = Array.isArray(assets) ? assets : [];
  const score = (name = "") => {
    const n = String(name).toLowerCase();
    if (!n.endsWith(".exe")) return 0;
    if (n.includes("setup")) return 3;
    if (n.includes("portable")) return 2;
    return 1;
  };
  return (
    list
      .map((a) => ({ ...a, score: score(a.name) }))
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score)[0] || null
  );
}

/**
 * Download a release asset (normally FRIDAY-Setup-<version>.exe) into
 * <root>/updates/installers, then check it against the published SHA-256.
 *
 * Bytes go to a .part file and only become the destination after size +
 * checksum checks. A failure never replaces an already-valid installer.
 * Authorization is attached only for api.github.com; CDN redirects are anonymous.
 */
async function downloadInstaller({
  root,
  url,
  apiUrl,
  assetId,
  name,
  sha256: expected,
  bytes: expectedBytes,
  repo,
  onProgress = () => {},
} = {}) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const cfg = readConfig(root);
  const downloadUrl = assetDownloadUrl(
    { url, apiUrl, id: assetId, name, bytes: expectedBytes },
    normalizeRepo(repo || cfg.repo),
  );
  if (!downloadUrl) return { ok: false, error: "This release does not publish an installer." };

  const dir = path.join(root, "updates", "installers");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(name || "FRIDAY-Setup.exe").replace(/[^\w.\-]+/g, "-"));
  const part = `${file}.part`;
  const verified = `${file}.verified`;
  if (!fs.existsSync(file) && fs.existsSync(verified)) {
    try {
      fs.renameSync(verified, file);
    } catch {
      /* next attempt will download again */
    }
  }

  const discardPart = () => {
    fs.rmSync(part, { force: true });
    fs.rmSync(verified, { force: true });
  };

  try {
    onProgress({ phase: "Downloading installer", percent: 0, state: "DOWNLOADING" });
    let existing = 0;
    if (fs.existsSync(part)) {
      existing = fs.statSync(part).size;
      if (!expectedBytes || existing <= 0 || existing >= expectedBytes) {
        fs.rmSync(part, { force: true });
        existing = 0;
      }
    }

    let res = await fetchFollowRedirects(downloadUrl, {
      token: cfg.token || "",
      range: existing > 0 ? `bytes=${existing}-` : "",
    });
    if (existing > 0 && (res.status === 200 || res.status === 416)) {
      await cancelBody(res);
      fs.rmSync(part, { force: true });
      existing = 0;
      res = await fetchFollowRedirects(downloadUrl, { token: cfg.token || "" });
    }
    if (!res.ok && res.status !== 206) {
      const status = res.status;
      await cancelBody(res);
      return { ok: false, error: downloadStatusError(status), status };
    }

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) {
      await cancelBody(res);
      discardPart();
      return {
        ok: false,
        error:
          "GitHub returned a web page instead of the installer. Add a repository token if this repo is private.",
      };
    }

    let announced = 0;
    const append = existing > 0 && res.status === 206;
    await streamResponseToFile(res, part, {
      append,
      onChunk: (received, total) => {
        const percent = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
        if (percent >= announced + 2 || !total) {
          announced = percent;
          onProgress({
            phase: "Downloading installer",
            percent,
            received,
            total,
            state: "DOWNLOADING",
          });
        }
      },
    });

    const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size < 1024) {
      discardPart();
      return { ok: false, error: "The downloaded installer was empty." };
    }
    if (expectedBytes && size !== Number(expectedBytes)) {
      discardPart();
      return {
        ok: false,
        error: `Incomplete download (${size} bytes, expected ${expectedBytes}).`,
      };
    }
    if (looksLikeHtmlFile(part)) {
      discardPart();
      return {
        ok: false,
        error:
          "GitHub returned a web page instead of the installer. Add a repository token if this repo is private.",
      };
    }

    onProgress({ phase: "Verifying download", percent: 100, state: "VERIFYING" });
    const digest = sha256File(part);
    if (expected && digest.toLowerCase() !== String(expected).toLowerCase()) {
      discardPart();
      return {
        ok: false,
        error: "Checksum mismatch — the download does not match the published release.",
      };
    }
    commitPartFile(part, file);
    onProgress({ phase: "Installer ready", percent: 100, state: "STAGED" });
    return {
      ok: true,
      file,
      bytes: size,
      sha256: digest,
      verified: Boolean(expected),
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

// ------------------------------------------------------- Hub multi-repo list
// Updates still owns the primary `repo` + `github.token` (FRIDAY herself).
// Hub can attach additional repos; each extra token is `github.token.<id>`.
const SELF_CONNECTION_ID = "self";

const connectionTokenId = (id) =>
  !id || id === SELF_CONNECTION_ID ? TOKEN_ID : `${TOKEN_ID}.${id}`;

function relativeCheckout(repo, id) {
  const slug =
    normalizeRepo(repo)
      .replace(/[^\w.-]+/g, "-")
      .toLowerCase() || "repo";
  const prefix = id && id !== SELF_CONNECTION_ID ? `${id}-` : "";
  return `temporary/sessions/hub-repos/${prefix}${slug}`;
}

function sanitizeConnections(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && c.id && c.id !== SELF_CONNECTION_ID && c.repo)
    .map((c) => ({
      id: String(c.id),
      repo: normalizeRepo(c.repo),
      label: String(c.label || c.repo).slice(0, 80),
      role: "linked",
      defaultBranch: String(c.defaultBranch || "main"),
      private: Boolean(c.private),
      localPath: c.localPath
        ? String(c.localPath).replace(/\\/g, "/")
        : relativeCheckout(c.repo, c.id),
    }));
}

function publicConnection(root, conn) {
  const known = conn.private === true || conn.private === false;
  return {
    id: conn.id,
    repo: conn.repo || "",
    label: conn.label || conn.repo || "",
    role: conn.role || (conn.id === SELF_CONNECTION_ID ? "self" : "linked"),
    hasToken: credentials.hasSecret(root, connectionTokenId(conn.id)),
    private: known ? Boolean(conn.private) : false,
    visibility: known ? (conn.private ? "private" : "public") : "unknown",
    defaultBranch: conn.defaultBranch || "main",
    localPath: conn.localPath || null,
  };
}

function newConnectionId() {
  return `repo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Hub's saved repos. FRIDAY's own Updates repo is always the first, labelled self. */
function listConnections(root) {
  const cfg = readConfig(root);
  const stored = readStored(root);
  const self = {
    id: SELF_CONNECTION_ID,
    repo: cfg.repo || "",
    label: "FRIDAY (this app)",
    role: "self",
    defaultBranch: cfg.branch || "main",
    private: stored.selfPrivate,
    localPath: null,
  };
  const extras = sanitizeConnections(stored.connections);
  const selectedRaw = stored.selectedConnectionId || SELF_CONNECTION_ID;
  const selectedId =
    selectedRaw === SELF_CONNECTION_ID || extras.some((c) => c.id === selectedRaw)
      ? selectedRaw
      : SELF_CONNECTION_ID;
  return {
    ok: true,
    selectedId,
    connections: [self, ...extras].map((c) => publicConnection(root, c)),
  };
}

/**
 * Config + checkout directory for Hub actions. Never used by Settings → Updates
 * (`readConfig` stays the FRIDAY-self identity).
 */
function hubTarget(root) {
  const listed = listConnections(root);
  const selected =
    listed.connections.find((c) => c.id === listed.selectedId) || listed.connections[0];
  const cfg = readConfig(root);
  if (!selected || selected.role === "self") {
    return {
      ok: true,
      id: SELF_CONNECTION_ID,
      role: "self",
      label: selected?.label || "FRIDAY (this app)",
      repo: cfg.repo || "",
      token: cfg.token || "",
      hasToken: Boolean(cfg.token),
      defaultBranch: cfg.branch || "main",
      dir: null,
      cfg,
    };
  }
  const token = credentials.getSecret(root, connectionTokenId(selected.id)) || "";
  const rel = selected.localPath || relativeCheckout(selected.repo, selected.id);
  return {
    ok: true,
    id: selected.id,
    role: "linked",
    label: selected.label,
    repo: selected.repo,
    token,
    hasToken: Boolean(token),
    defaultBranch: selected.defaultBranch || "main",
    dir: path.join(root, rel),
    relativeDir: rel,
    cfg: {
      ...cfg,
      repo: selected.repo,
      token,
      branch: selected.defaultBranch || cfg.branch || "main",
    },
  };
}

async function addConnection(root, { repo, token, label } = {}) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const name = normalizeRepo(repo);
  if (!name) return { ok: false, error: "Enter a repository as owner/name." };
  const cfg = readConfig(root);
  if (cfg.repo && sameRepo(name, cfg.repo)) {
    writeConfig(root, { selectedConnectionId: SELF_CONNECTION_ID });
    return { ok: true, id: SELF_CONNECTION_ID, reused: true, ...listConnections(root) };
  }
  // Do not reuse FRIDAY's Updates token for an extra Hub repo — extras are
  // public without a token, or carry their own encrypted credential.
  const test = await testConnection(root, { repo: name, token: token || "" });
  if (!test.ok) return test;
  const stored = readStored(root);
  const extras = sanitizeConnections(stored.connections);
  const existing = extras.find((c) => sameRepo(c.repo, test.repo || name));
  const id = existing?.id || newConnectionId();
  if (token) {
    const saved = credentials.setSecret(root, connectionTokenId(id), token);
    if (!saved.ok) return saved;
  }
  const conn = {
    id,
    repo: test.repo || name,
    label: String(label || test.repo || name).slice(0, 80),
    role: "linked",
    defaultBranch: test.defaultBranch || "main",
    private: Boolean(test.private),
    localPath: existing?.localPath || relativeCheckout(test.repo || name, id),
  };
  const connections = [...extras.filter((c) => c.id !== id), conn];
  writeConfig(root, { connections, selectedConnectionId: id });
  return { ok: true, id, reused: Boolean(existing), ...listConnections(root) };
}

function removeConnection(root, id) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  if (!id || id === SELF_CONNECTION_ID) {
    return { ok: false, error: "FRIDAY's own repository cannot be removed from Hub." };
  }
  const stored = readStored(root);
  const connections = sanitizeConnections(stored.connections).filter((c) => c.id !== id);
  credentials.setSecret(root, connectionTokenId(id), "");
  const selectedConnectionId =
    stored.selectedConnectionId === id ? SELF_CONNECTION_ID : stored.selectedConnectionId;
  writeConfig(root, { connections, selectedConnectionId });
  return { ok: true, ...listConnections(root) };
}

function selectConnection(root, id) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const listed = listConnections(root);
  if (!listed.connections.some((c) => c.id === id)) {
    return { ok: false, error: "That repository is not in the Hub list." };
  }
  writeConfig(root, { selectedConnectionId: id });
  return { ok: true, ...listConnections(root) };
}

/** Test one saved Hub connection with that connection's own token (never the Updates token for extras). */
async function testHubConnection(root, id) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const listed = listConnections(root);
  const conn = listed.connections.find((c) => c.id === id);
  if (!conn) return { ok: false, error: "That repository is not in the Hub list." };
  const result =
    conn.id === SELF_CONNECTION_ID || conn.role === "self"
      ? await testConnection(root)
      : await testConnection(root, {
          repo: conn.repo,
          token: credentials.getSecret(root, connectionTokenId(conn.id)) || "",
        });
  if (result.ok) {
    if (conn.id === SELF_CONNECTION_ID || conn.role === "self") {
      writeConfig(root, { selfPrivate: Boolean(result.private) });
    } else {
      const stored = readStored(root);
      const extras = sanitizeConnections(stored.connections).map((item) =>
        item.id === id
          ? {
              ...item,
              repo: result.repo || item.repo,
              private: Boolean(result.private),
              defaultBranch: result.defaultBranch || item.defaultBranch,
            }
          : item,
      );
      writeConfig(root, { connections: extras });
    }
  }
  return result;
}

module.exports = {
  mapReleaseAsset,
  assetDownloadUrl,
  downloadHeaders,
  installerAsset,
  downloadInstaller,
  normalizeRepo,
  sameRepo,
  readConfig,

  writeConfig,
  publicConfig,
  testConnection,
  connect,
  connection,
  TOKEN_ID,
  SELF_CONNECTION_ID,
  connectionTokenId,
  listConnections,
  addConnection,
  removeConnection,
  selectConnection,
  testHubConnection,
  hubTarget,
  checkUpdate,
  pullUpdate,
  recordApplied,
  releaseManifest,
  expectedChecksum,
  isTestRelease,
  normalizeUpdateChannel,
  configFile,
  api,
};
