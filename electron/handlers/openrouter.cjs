"use strict";

const { defineCloudProvider } = require("../provider-module.cjs");

/**
 * Models list re-read 2026-10-21. Pricing strings are numbers only when they
 * parse. A :free id without a zero price is not proof. Provider routing options
 * are added only to tighten privacy or an owner price cap. The key stays out.
 */
function money(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normaliseModel(row) {
  const pricing = row?.pricing || null;
  return {
    nativeId: String(row?.id || ""),
    displayName: String(row?.name || row?.id || ""),
    canonicalSlug: row?.canonical_slug || null,
    limits: {
      context: Number.isFinite(Number(row?.context_length)) ? Number(row.context_length) : null,
      maxOutput: null,
      media: null,
    },
    pricing: {
      inputPerMTok: pricing ? money(pricing.prompt) : null,
      outputPerMTok: pricing ? money(pricing.completion) : null,
      currency: pricing ? "USD" : null,
    },
    endpointKinds: ["chat"],
    lifecycle: row?.expiration_date ? "deprecated" : "active",
    replacement: null,
  };
}

function routeBody(input) {
  if (!input || input.privacy !== true) return {};
  const provider = { data_collection: "deny", allow_fallbacks: false };
  if (typeof input.maxPrice === "number" && input.maxPrice >= 0) {
    provider.max_price = { prompt: input.maxPrice, completion: input.maxPrice };
  }
  return { provider };
}

module.exports = defineCloudProvider({
  id: "openrouter",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  mayTrain: true,
  privacyUrl: "https://openrouter.ai/settings/privacy",
  discovery: "documented",
  provenance: {
    sourceUrl:
      "https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  normaliseModel,
  routeBody,
  replacementMap: {},
});
