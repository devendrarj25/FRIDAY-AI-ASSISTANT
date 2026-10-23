/**
 * Local runners and library parsers. Catalog rows are curated where a vendor
 * publishes no machine-readable list. Parsers read official JSON only.
 */
const fs = require("node:fs");
const path = require("node:path");
const resourcePaths = require("./resource-paths.cjs");

const FALLBACK_CATALOG = { checked: "", runners: [], curated: [] };

function catalog() {
  const value = resourcePaths.readConfigJson("local-runners.json", FALLBACK_CATALOG).value;
  const row = value && typeof value === "object" ? value : FALLBACK_CATALOG;
  return {
    checked: row.checked || "",
    runners: Array.isArray(row.runners) ? row.runners : [],
    curated: Array.isArray(row.curated) ? row.curated : [],
  };
}

function runners() {
  return catalog().runners.map((row) => ({ ...row }));
}

function runnerById(id) {
  return runners().find((row) => row.id === id) || null;
}

function curatedLibrary() {
  return catalog().curated.map((row) => ({
    ...row,
    status: "not-installed",
    source: "curated",
  }));
}

function parseHfModels(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.models || [];
  return rows.map((row) => {
    const gated = row?.gated;
    const siblings = Array.isArray(row?.siblings) ? row.siblings : [];
    return {
      id: String(row?.id || row?.modelId || ""),
      author: String(row?.author || ""),
      gated: gated === true || gated === "auto" || gated === "manual",
      license: row?.cardData?.license || row?.license || "",
      files: siblings.map((file) => ({
        name: String(file?.rfilename || file?.filename || ""),
        sha256: file?.lfs?.sha256 ? String(file.lfs.sha256) : "",
        bytes: Number(file?.lfs?.size || file?.size || 0),
      })),
      officialPage: row?.id ? `https://huggingface.co/${row.id}` : "",
    };
  });
}

function parseGithubRelease(payload, assetName) {
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  const want = String(assetName || "").toLowerCase();
  const asset =
    assets.find((item) => String(item?.name || "").toLowerCase() === want) ||
    assets.find((item) =>
      String(item?.name || "")
        .toLowerCase()
        .includes(want),
    ) ||
    null;
  if (!asset) return null;
  const digest = String(asset.digest || "");
  const sha256 = digest.startsWith("sha256:") ? digest.slice(7) : "";
  return {
    name: String(asset.name || ""),
    url: String(asset.browser_download_url || ""),
    bytes: Number(asset.size) || 0,
    sha256,
    tag: String(payload?.tag_name || ""),
  };
}

/**
 * What the owner sees before any installer runs. A Windows signature is
 * required before canRun. This process never starts the file.
 */
function installOffer(runner, check = {}) {
  const release = runner?.release || null;
  const hashPublished = Boolean(release?.sha256);
  const hashOk =
    hashPublished &&
    String(check.sha256 || "").toLowerCase() === String(release.sha256).toLowerCase();
  const publisher = String(check.authenticode?.publisher || "");
  const signed = check.authenticode?.ok === true && publisher.length > 0;
  const clicked = check.ownerClicked === true;
  let reason = "open the official page";
  if (!release?.url) reason = "no pinned installer; open the official page";
  else if (!hashPublished) reason = "the vendor did not publish a sha256 for this asset";
  else if (!hashOk) reason = "checksum did not match";
  else if (!signed) reason = "Windows signature has not been checked";
  else if (!clicked) reason = "waiting for an owner click";
  else reason = "the owner can run the installer";
  return {
    id: runner?.id || "",
    sourceUrl: release?.url || runner?.officialPage || "",
    bytes: release?.bytes || null,
    sha256: release?.sha256 || null,
    hashOk,
    signed,
    canRun: Boolean(release?.url) && hashPublished && hashOk && signed && clicked,
    reason,
  };
}

function pinAgeDays(checked, now = Date.now()) {
  const start = Date.parse(`${String(checked || "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((Number(now) - start) / 86_400_000));
}

function versionParts(tag) {
  const raw = String(tag || "")
    .trim()
    .replace(/^v/i, "");
  const build = /^b(\d+)$/i.exec(raw);
  if (build) return [Number(build[1])];
  return raw
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number(part));
}

function newerTag(latest, pinned) {
  const next = versionParts(latest);
  const current = versionParts(pinned);
  const width = Math.max(next.length, current.length);
  for (let i = 0; i < width; i += 1) {
    const delta = (next[i] || 0) - (current[i] || 0);
    if (delta > 0) return true;
    if (delta < 0) return false;
  }
  return false;
}

/**
 * Compare a pinned launcher with one official release payload.
 * This does not download, install, or rewrite the pin file.
 * A new sha256 is offered only when that release publishes one.
 */
function assessOfficialRelease(runner, payload, now = Date.now()) {
  const pinned = runner?.release || null;
  const ageDays = pinAgeDays(catalog().checked, now);
  const parsed = parseGithubRelease(payload, pinned?.asset || "");
  const latestTag = parsed?.tag || String(payload?.tag_name || "");
  const updateAvailable = Boolean(pinned?.tag && latestTag && newerTag(latestTag, pinned.tag));
  const published = String(parsed?.sha256 || "");
  const storedSha256 = pinned?.sha256 || null;
  const offeredSha256 = published || null;
  let label = ageDays == null ? "Pin age: unknown" : `Pin age: ${ageDays} days`;
  if (!pinned?.tag) label += " · no pinned release";
  else if (updateAvailable) label += " · update available";
  else if (latestTag) label += " · this pin is current";
  return {
    ok: true,
    id: runner?.id || "",
    updateAvailable,
    pinnedTag: pinned?.tag || "",
    latestTag,
    ageDays,
    label,
    storedSha256,
    offeredSha256,
    wouldReplaceSha256: Boolean(published),
    autoInstall: false,
    canRun: false,
  };
}

async function checkRunnerRelease(id, options = {}) {
  const runner = typeof id === "string" ? runnerById(id) : id;
  const now = options.now || Date.now();
  if (!runner) {
    return {
      ok: false,
      updateAvailable: false,
      autoInstall: false,
      canRun: false,
      reason: "unknown launcher",
    };
  }
  if (options.payload) return assessOfficialRelease(runner, options.payload, now);
  if (!runner.release?.repo) return assessOfficialRelease(runner, null, now);
  const url = `https://api.github.com/repos/${runner.release.repo}/releases/latest`;
  const safety = require("./download-safety.cjs");
  safety.assertAllowedUrl(url);
  if (!options.fetchImpl) {
    const { res } = await safety.fetchAllowlisted(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "FRIDAY" },
    });
    if (!res.ok) {
      const ageDays = pinAgeDays(catalog().checked, now);
      return {
        ok: false,
        id: runner.id,
        updateAvailable: false,
        ageDays,
        label: `Pin age: ${ageDays} days`,
        storedSha256: runner.release?.sha256 || null,
        offeredSha256: null,
        wouldReplaceSha256: false,
        autoInstall: false,
        canRun: false,
        reason: `release API HTTP ${res.status}`,
      };
    }
    return assessOfficialRelease(runner, await res.json(), now);
  }
  const payload = await options.fetchImpl(url);
  return assessOfficialRelease(runner, payload, now);
}

function launcherCard(runner, probe = {}) {
  const installed = probe.installed === true;
  const running = probe.running === true;
  let nextStep = "Download the launcher from the official page, then Install.";
  if (!installed)
    nextStep = "Not installed. Download shows the source URL, size, and checksum first.";
  else if (!running) nextStep = "Installed and stopped. Start when you want the local API.";
  else if (!probe.api) nextStep = "The process is up and the API is not answering yet.";
  else nextStep = probe.loaded ? `Active model: ${probe.loaded}` : "Running. No model is loaded.";
  const now = probe.now || Date.now();
  const ageDays = pinAgeDays(catalog().checked, now);
  const pinAgeLabel = ageDays == null ? "Pin age: unknown" : `Pin age: ${ageDays} days`;
  return {
    id: runner.id,
    name: runner.name,
    officialPage: runner.officialPage,
    detected: installed,
    version: probe.version || null,
    running,
    apiReachable: probe.api === true,
    loadedModel: probe.loaded || null,
    catalog: runner.catalog,
    catalogNote: runner.catalogNote,
    offer: installOffer(runner, probe.check || {}),
    nextStep,
    pinAgeDays: ageDays,
    pinAgeLabel,
    stopHint: runner.stopHint,
    uninstallHint: runner.uninstallHint,
  };
}

/** Standard places a per-user or per-machine Ollama lands on Windows. */
function ollamaLocations(env = process.env) {
  const exe = ["Ollama", "ollama.exe"];
  return [
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", ...exe),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, ...exe),
    env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], ...exe),
  ].filter(Boolean);
}

/**
 * The version `ollama --version` reports for the client. A running older
 * daemon prints its own line first and the client on a "client version is"
 * warning, and the client is what is installed.
 */
function ollamaClientVersion(text) {
  const out = String(text || "");
  const client = /client version is\s+v?(\d+(?:\.\d+)+)/i.exec(out);
  const plain = /version is\s+v?(\d+(?:\.\d+)+)/i.exec(out);
  return (client || plain || [])[1] || null;
}

/** The Ollama on this PC (PATH, then its standard folders): executable and version, or null. */
function findInstalledOllama({ env = process.env, exists = fs.existsSync, version } = {}) {
  const names = process.platform === "win32" ? ["ollama.exe"] : ["ollama"];
  const onPath = String(env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => path.join(dir, name)));
  const exe = [...onPath, ...ollamaLocations(env)].find((file) => exists(file));
  if (!exe) return null;
  const read =
    version ||
    ((file) => {
      try {
        return ollamaClientVersion(
          require("node:child_process").execFileSync(file, ["--version"], {
            encoding: "utf8",
            timeout: 8000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      } catch (err) {
        return ollamaClientVersion(`${err?.stdout || ""}${err?.stderr || ""}`);
      }
    });
  return { exe, version: read(exe) };
}

/** The local models setup pulls through Ollama, by tier (config/local-runners.json). */
function ollamaModels(options = {}) {
  const runner = options.runner || runnerById("ollama");
  return (Array.isArray(runner?.models) ? runner.models : [])
    .filter((row) => row && typeof row.tag === "string" && row.tag)
    .map((row) => ({
      tag: row.tag,
      tier: row.tier === "smart" ? "smart" : "fast",
      role: String(row.role || ""),
      minRamGb: Number(row.minRamGb) > 0 ? Number(row.minRamGb) : 0,
    }));
}

/**
 * The newest official installer for one launcher. A live GitHub release wins
 * only when it carries the asset and the sha256 GitHub itself computed for it
 * (the release `digest`), so a newer build is never run unverified. Offline,
 * a failed lookup, or a release without a digest falls back to the pin.
 */
async function latestOfficialRelease(id, options = {}) {
  const runner = runnerById(id);
  const pinned = runner?.release || null;
  if (!pinned?.url) return null;
  const fallback = {
    tag: pinned.tag,
    url: pinned.url,
    bytes: Number(pinned.bytes) || 0,
    sha256: pinned.sha256 || "",
    source: "pinned",
  };
  if (!pinned.repo) return fallback;
  try {
    const url = `https://api.github.com/repos/${pinned.repo}/releases/latest`;
    let payload;
    if (options.fetchImpl) payload = await options.fetchImpl(url);
    else {
      const safety = require("./download-safety.cjs");
      const { res } = await safety.fetchAllowlisted(url, {
        headers: { accept: "application/vnd.github+json", "user-agent": "FRIDAY" },
        signal: AbortSignal.timeout(options.timeoutMs || 8000),
      });
      if (!res.ok) return fallback;
      payload = await res.json();
    }
    const exact = (Array.isArray(payload?.assets) ? payload.assets : []).some(
      (item) => String(item?.name || "").toLowerCase() === String(pinned.asset || "").toLowerCase(),
    );
    const parsed = exact ? parseGithubRelease(payload, pinned.asset) : null;
    if (parsed?.url && parsed.sha256 && newerTag(parsed.tag, pinned.tag)) {
      return { ...parsed, source: "live" };
    }
  } catch {
    /* offline or blocked: the pin below is still verified */
  }
  return fallback;
}

module.exports = {
  ollamaLocations,
  ollamaClientVersion,
  findInstalledOllama,
  ollamaModels,
  latestOfficialRelease,
  runners,
  runnerById,
  curatedLibrary,
  parseHfModels,
  parseGithubRelease,
  installOffer,
  launcherCard,
  pinAgeDays,
  newerTag,
  assessOfficialRelease,
  checkRunnerRelease,
};
