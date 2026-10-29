"use strict";

const { defineCloudProvider } = require("../provider-module.cjs");
const { normaliseListRow } = require("../protocol-openai-compatible.cjs");

/**
 * List fields re-read 2026-10-21: id, created, object, owned_by.
 * Prices were not re-read. An unknown access class is not an automatic route.
 * Chat stays on the existing compatible path. The Responses API is not the product path.
 */
module.exports = defineCloudProvider({
  id: "openai",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://developers.openai.com/api/reference/resources/models/methods/list/",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  normaliseModel: normaliseListRow,
  autoRoute(record) {
    const mode = record?.billingMode || record?.access?.class || record?.access;
    if (mode === "UNKNOWN" || mode === "unknown" || !mode) return false;
    const pricing = record?.pricing || {};
    const numbers = [
      pricing.inputPerMTok,
      pricing.outputPerMTok,
      pricing.prompt,
      pricing.completion,
      pricing.input,
      pricing.output,
    ];
    const hasPrice = numbers.some((value) => typeof value === "number" && Number.isFinite(value));
    if (!hasPrice) return false;
    return (
      mode === "ZERO_COST" ||
      mode === "FREE_QUOTA" ||
      mode === "PAID" ||
      mode === "free" ||
      mode === "paid"
    );
  },
  replacementMap: {},
});
