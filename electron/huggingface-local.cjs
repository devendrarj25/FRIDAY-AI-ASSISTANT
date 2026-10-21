/**
 * Hugging Face local weights. States move on the existing download manager.
 * This is not a handler id and it does not run a file.
 */
"use strict";

const hub = require("./huggingface-hub-client.cjs");

const STATES = ["discovered", "downloading", "paused", "installed", "loaded", "active"];

const NEXT = {
  discovered: { start: "downloading" },
  downloading: { pause: "paused", complete: "installed", fail: "discovered", cancel: "discovered" },
  paused: { resume: "downloading", cancel: "discovered" },
  installed: { load: "loaded" },
  loaded: { activate: "active", unload: "installed" },
  active: { unload: "installed" },
};

function nextState(state, event) {
  const from = STATES.includes(state) ? state : "discovered";
  return NEXT[from]?.[event] || from;
}

function planInstall(listing, prefs = {}) {
  const download = require("./model-download.cjs");
  const shape = hub.listingShape(listing);
  if (shape.gated) {
    return { ok: false, reason: "gated", state: "discovered", repo: shape.repo, file: null };
  }
  const names = shape.files
    .map((file) => (typeof file === "string" ? file : file?.path || ""))
    .filter(Boolean);
  const file = download.pickGguf(names, prefs.quants || ["Q4_K_M", "Q5_K_M", "Q8_0"]);
  if (!file)
    return { ok: false, reason: "no-gguf", state: "discovered", repo: shape.repo, file: null };
  const url = hub.fileUrl(shape.repo, file);
  return {
    ok: true,
    reason: null,
    state: "discovered",
    repo: shape.repo,
    runner: prefs.runner || "ollama",
    file,
    source: { kind: "hf-gguf", repo: shape.repo, url },
  };
}

function provenance() {
  return {
    sourceUrl: "https://huggingface.co/docs/hub/api",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    verifiedAt: null,
    confidence: "documented",
  };
}

function statusMatrix() {
  return {
    adapter: "download-manager",
    discovery: "documented",
    metadataNormalised: "yes",
    pricingVerified: "no",
    entitlementVerified: "no",
    requestResponseTested: "mocked",
    liveVerified: "no",
  };
}

module.exports = { STATES, nextState, planInstall, provenance, statusMatrix };
