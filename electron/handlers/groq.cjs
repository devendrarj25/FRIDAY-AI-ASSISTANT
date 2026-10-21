"use strict";

const { defineCloudProvider } = require("../provider-module.cjs");

/**
 * List shape re-read 2026-10-21: object "list", data[] with id, owned_by,
 * active, context_window. A free tier was not re-proven from this list.
 * Replacement ids were not read, so the map stays empty.
 */
function normaliseModel(row) {
  const nativeId = String(row?.id || "");
  const audio = /whisper|distil-whisper/i.test(nativeId);
  const context = Number(row?.context_window);
  return {
    nativeId,
    displayName: nativeId,
    owner: row?.owned_by || null,
    active: row?.active === true ? true : row?.active === false ? false : null,
    limits: { context: Number.isFinite(context) ? context : null, maxOutput: null, media: null },
    endpointKinds: audio ? ["audio-transcription"] : ["chat"],
    lifecycle: row?.active === false ? "retired" : "active",
    replacement: null,
  };
}

module.exports = defineCloudProvider({
  id: "groq",
  protocol: "openai-compatible",
  endpointKinds: ["chat", "audio-transcription"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://console.groq.com/docs/api-reference",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  normaliseModel,
  replacementMap: {},
});
