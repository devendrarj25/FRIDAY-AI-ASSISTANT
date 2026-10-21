/**
 * Local provider hub. The Hugging Face download path is a planner into the
 * existing runners. It is not a second inference provider.
 */
"use strict";

function ensureReady() {
  require("./huggingface-local.cjs");
  return require("./provider-registry.cjs").ensureHandlers();
}

function list() {
  ensureReady();
  const { LOCAL_IDS } = require("./handlers/index.cjs");
  const { getHandler } = require("./provider-handler.cjs");
  const rows = LOCAL_IDS.map((id) => {
    const handler = getHandler(id);
    const module = handler && handler.module ? handler.module : null;
    return {
      id,
      kind: "local",
      protocol: module ? module.protocol : null,
      provenance: module ? module.provenance : null,
      matrix: module ? module.statusMatrix : null,
    };
  });
  const local = require("./huggingface-local.cjs");
  rows.push({
    id: "huggingface-local",
    kind: "local-download",
    protocol: null,
    provenance: local.provenance(),
    matrix: local.statusMatrix(),
  });
  return rows;
}

module.exports = { ensureReady, list };
