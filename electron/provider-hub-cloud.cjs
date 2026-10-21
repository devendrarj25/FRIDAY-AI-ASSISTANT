/**
 * Cloud provider hub. Registry, refresh description, and the status matrix.
 * Keys stay in the existing key store. This hub does not fetch.
 */
"use strict";

function ensureReady() {
  return require("./provider-registry.cjs").ensureHandlers();
}

function list() {
  ensureReady();
  const { CLOUD_IDS } = require("./handlers/index.cjs");
  const { getHandler } = require("./provider-handler.cjs");
  return CLOUD_IDS.map((id) => {
    const handler = getHandler(id);
    const module = handler && handler.module ? handler.module : null;
    return {
      id,
      kind: "cloud",
      protocol: module ? module.protocol : null,
      provenance: module ? module.provenance : null,
      matrix: module ? module.statusMatrix : null,
      connect: "models:test-provider",
      test: "models:health",
      disconnect: "models:set-key",
    };
  });
}

module.exports = { ensureReady, list };
