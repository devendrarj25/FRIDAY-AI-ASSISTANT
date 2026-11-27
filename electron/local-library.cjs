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

/** A Response-like for the chain: a real response, a json-only one, or a bare payload a test stand-in returns. */
function asChainResponse(got) {
  if (got && typeof got.text === "function") return got;
  const json = got && typeof got.json === "function";
  const read = async () => JSON.stringify(json ? await got.json() : (got ?? {}));
  return {
    status: json ? Number(got.status) || (got.ok ? 200 : 0) : 200,
    ok: json ? got.ok !== false : true,
    headers: json && got.headers ? got.headers : { get: () => null },
    text: read,
  };
}

function chainStore(options, vendor) {
  if (options.store) return options.store;
  let root = options.root || null;
  if (!root) {
    try {
      root = require("./friday-paths.cjs").root();
    } catch {
      root = null;
    }
  }
  return root ? vendor.storeFor(root) : null;
}

/**
 * The newest official release of a repository through the one source chain (API, then the public feed, then the
 * last stored answer). Privacy mode and being offline send no request and answer from the stored one. The answer is
 * shaped like the GitHub release payload so the callers below read it unchanged.
 */
async function officialReleasePayload(repo, options = {}) {
  const vendor = require("./vendor-sources.cjs");
  const safety = require("./download-safety.cjs");
  const fetchImpl = async (url, init) => {
    safety.assertAllowedUrl(url);
    if (options.fetchImpl) return asChainResponse(await options.fetchImpl(url, init));
    const { res } = await safety.fetchAllowlisted(url, init);
    return asChainResponse(res);
  };
  const quiet = options.privacy === true || options.online === false;
  const sources = quiet ? [] : vendor.chainFor({ latest: { kind: "github", ref: repo } });
  const got = await vendor.resolveLatest(`release:${repo}`, sources, {
    fetchImpl,
    store: chainStore(options, vendor),
    now: () => Number(options.now) || Date.now(),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (!got.ok) return { ok: false, error: got.error };
  return {
    ok: true,
    stale: got.stale,
    payload: {
      tag_name: got.tag || got.version,
      assets: (got.assets || []).map((a) => ({
        name: a.name,
        browser_download_url: a.url,
        size: a.bytes,
        ...(a.sha256 ? { digest: `sha256:${a.sha256}` } : {}),
      })),
    },
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
  const answer = await officialReleasePayload(runner.release.repo, options);
  if (!answer.ok) {
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
      reason: answer.error,
    };
  }
  return assessOfficialRelease(runner, answer.payload, now);
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

/** The local chat models setup pulls through Ollama (config/local-runners.json): the light fast one first, then larger ones by memory. */
function ollamaModels(options = {}) {
  const runner = options.runner || runnerById("ollama");
  return (Array.isArray(runner?.models) ? runner.models : [])
    .filter((row) => row && typeof row.tag === "string" && row.tag)
    .map((row) => ({
      tag: row.tag,
      role: String(row.role || ""),
      // A larger model needs memory to run beside the light one, and never fails the setup when it cannot arrive.
      minRamGb: Number(row.minRamGb) > 0 ? Number(row.minRamGb) : 0,
      optional: row.optional === true,
    }));
}

/** Ollama writes a tag with no variant as `name:latest`; the two spellings are one model. */
const bareTag = (name) =>
  String(name || "")
    .trim()
    .toLowerCase()
    .replace(/:latest$/, "");

/**
 * The router's own voice-surface score for an installed tag (electron/model-router.cjs scoreModel), so the model the
 * Auto warm-up loads is the one the router ranks first for the voice turn. Zero for every row (plain quality order)
 * when the surface is chat, when no hardware facts are known, or when the router cannot score.
 */
function voiceScore(row, options) {
  if (!options.facts || options.surface === "chat") return 0;
  try {
    const router = require("./model-router.cjs");
    const { inferRole } = require("./models.cjs");
    const model = router.describe({
      id: `ollama:${row.name}`,
      type: "local",
      role: inferRole(row.name),
      contextK: 32,
      providerId: "ollama",
      meta: {
        providerId: "ollama",
        kind: "local",
        modelName: row.name,
        connected: true,
        ...(row.weightsGb ? { sizeGb: row.weightsGb } : {}),
      },
    });
    const score = router.scoreModel(model, {
      surface: "voice",
      hardware: options.facts,
      policy: "free-only",
    });
    return Number.isFinite(score) ? score : 0;
  } catch {
    return 0;
  }
}

/**
 * The chat model this PC really has in Ollama. The setup plan (electron/setup-plan.cjs) chooses the chat model by
 * this PC's memory, so the app must not assume one tag. Order: `options.prefer` (the tag in use) when installed; else
 * the installed chat model ranked best by the plan's `qualityOf`, among those whose weights plus margin fit the plan's
 * usable memory (`options.facts` = hardware facts; without them every installed chat model counts), the plan's own
 * tier tag winning a tie; else the default row of `ollamaModels()` (qwen3:4b), which is also what a PC with only
 * that model gets. With `facts`, the router's voice score orders first (`options.surface: "chat"` keeps quality
 * first), because the only caller is the Auto warm-up. `installed`: tag strings or `{ name|model, size }` rows. Pure; null only when nothing is configured.
 * Returns `{ tag, source: "prefer" | "installed" | "default" }`.
 */
function installedChatModel(installed, options = {}) {
  const fallback = () => {
    const tag = (options.runner ? ollamaModels({ runner: options.runner }) : ollamaModels())[0]
      ?.tag;
    return tag ? { tag, source: "default" } : null;
  };
  try {
    const plan = require("./setup-plan.cjs");
    const cfg = plan.loadTiers(options);
    const rows = [];
    const seen = new Set();
    for (const raw of Array.isArray(installed) ? installed : []) {
      const name = typeof raw === "string" ? raw : String(raw?.name || raw?.model || "");
      const key = bareTag(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({ name: name.trim(), key, bytes: Number(raw?.size) > 0 ? Number(raw.size) : 0 });
    }
    const wanted = bareTag(options.prefer);
    const preferred = wanted ? rows.find((row) => row.key === wanted) : null;
    if (preferred) return { tag: preferred.name, source: "prefer" };
    if (!cfg || !rows.length) return fallback();

    const pick = options.facts ? plan.chatModelFor(options.facts, { tiers: cfg }) : null;
    const usable = Number(pick?.memory?.usableGb);
    const margin = Number(cfg.rules?.weightsMargin) > 0 ? Number(cfg.rules.weightsMargin) : 1.2;
    const listed = new Map();
    for (const tier of cfg.tiers || []) {
      listed.set(bareTag(tier.tag), Number(tier.downloadGb) || null);
      for (const alt of tier.alternatives || [])
        listed.set(bareTag(alt.tag), Number(alt.downloadGb) || null);
    }
    const ranked = rows
      .map((row) => ({
        ...row,
        quality: plan.qualityOf(row.name, cfg),
        weightsGb: row.bytes ? row.bytes / 1024 ** 3 : (listed.get(row.key) ?? null),
      }))
      .filter((row) => row.quality !== null)
      .filter(
        (row) =>
          !Number.isFinite(usable) ||
          row.weightsGb === null ||
          row.weightsGb * margin <= usable + 1e-9,
      )
      .map((row) => ({ ...row, voice: voiceScore(row, options) }))
      .sort(
        (a, b) =>
          b.voice - a.voice ||
          b.quality - a.quality ||
          Number(b.key === bareTag(pick?.tag)) - Number(a.key === bareTag(pick?.tag)),
      );
    return ranked[0] ? { tag: ranked[0].name, source: "installed" } : fallback();
  } catch {
    return fallback();
  }
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
    const answer = await officialReleasePayload(pinned.repo, options);
    if (!answer.ok) return fallback;
    const payload = answer.payload;
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
  installedChatModel,
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
