"use strict";

const { defineCloudProvider } = require("../provider-module.cjs");

/**
 * build.nvidia.com/llms.txt re-read 2026-10-21: integrate.api.nvidia.com/v1,
 * Bearer, OpenAI-compatible chat, and a free trial with no credit card.
 * The list payload is thin. A capability stays null unless the row has it.
 * A self-hosted NIM container is not this cloud catalogue.
 */
function normaliseModel(row) {
  const nativeId = String(row?.id || "");
  return {
    nativeId,
    displayName: nativeId,
    owner: row?.owned_by || null,
    limits: { context: null, maxOutput: null, media: null },
    endpointKinds: ["chat"],
    capabilities: {},
    lifecycle: "active",
    replacement: null,
  };
}

module.exports = defineCloudProvider({
  id: "nvidia",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://build.nvidia.com/llms.txt",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  normaliseModel,
  replacementMap: {},
});
