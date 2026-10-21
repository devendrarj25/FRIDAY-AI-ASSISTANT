"use strict";

const { defineCloudProvider } = require("../provider-module.cjs");

/**
 * Router list re-read 2026-10-21. providers[] carries status, context_length,
 * and pricing in USD per million tokens when the payload has them.
 * A suffix is applied only when the caller asks. A bare id stays bare.
 */
function money(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normaliseModel(row) {
  const providers = Array.isArray(row?.providers) ? row.providers : [];
  const live = providers.filter((item) => (item?.status || "live") === "live");
  const first = live[0] || null;
  const pricing = first?.pricing || null;
  const tools = first && typeof first.supports_tools === "boolean" ? first.supports_tools : null;
  return {
    nativeId: String(row?.id || ""),
    displayName: String(row?.id || ""),
    limits: {
      context: Number.isFinite(Number(first?.context_length)) ? Number(first.context_length) : null,
      maxOutput: null,
      media: null,
    },
    pricing: {
      inputPerMTok: pricing ? money(pricing.input) : null,
      outputPerMTok: pricing ? money(pricing.output) : null,
      currency: pricing ? "USD" : null,
    },
    capabilities: {
      tools: { value: tools, evidence: tools == null ? "unknown" : "documented" },
    },
    endpointKinds: ["chat"],
    lifecycle: "active",
    replacement: null,
  };
}

function routeWithinProvider(input) {
  const id = String(input?.model || input?.modelId || "");
  if (!id) return { model: "" };
  if (/:(?:fastest|cheapest|preferred|[A-Za-z0-9._-]+)$/.test(id)) return { model: id };
  if (input?.pin) return { model: `${id}:${String(input.pin)}` };
  if (input?.priceCeiling != null) return { model: `${id}:cheapest` };
  if (input?.throughput === "fastest") return { model: `${id}:fastest` };
  return { model: id };
}

module.exports = defineCloudProvider({
  id: "huggingface",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://huggingface.co/docs/inference-providers/main/en/index",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  normaliseModel,
  routeWithinProvider,
  replacementMap: {},
});
