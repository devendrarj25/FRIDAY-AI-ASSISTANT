/**
 * Local runners and library parsers. Catalog rows are curated where a vendor
 * publishes no machine-readable list. Parsers read official JSON only.
 */
const RUNNERS = require("../config/local-runners.json");

function runners() {
  return RUNNERS.runners.map((row) => ({ ...row }));
}

function runnerById(id) {
  return runners().find((row) => row.id === id) || null;
}

function curatedLibrary() {
  return (RUNNERS.curated || []).map((row) => ({
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

function launcherCard(runner, probe = {}) {
  const installed = probe.installed === true;
  const running = probe.running === true;
  let nextStep = "Download the launcher from the official page, then Install.";
  if (!installed)
    nextStep = "Not installed. Download shows the source URL, size, and checksum first.";
  else if (!running) nextStep = "Installed and stopped. Start when you want the local API.";
  else if (!probe.api) nextStep = "The process is up and the API is not answering yet.";
  else nextStep = probe.loaded ? `Active model: ${probe.loaded}` : "Running. No model is loaded.";
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
    stopHint: runner.stopHint,
    uninstallHint: runner.uninstallHint,
  };
}

module.exports = {
  runners,
  runnerById,
  curatedLibrary,
  parseHfModels,
  parseGithubRelease,
  installOffer,
  launcherCard,
};
