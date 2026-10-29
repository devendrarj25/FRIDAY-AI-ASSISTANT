/**
 * One provider module contract. The handler methods stay on the existing
 * cloud and local binders. This file only attaches the module record.
 */
"use strict";

const { cloudHandler } = require("./handlers/cloud-bind.cjs");
const { localHandler } = require("./handlers/local-bind.cjs");

function provenanceOf(spec) {
  const row = spec?.provenance || {};
  return {
    sourceUrl: row.sourceUrl || null,
    method: row.method || null,
    fetchedAt: row.fetchedAt || null,
    verifiedAt: row.verifiedAt || null,
    confidence: row.confidence || "unknown",
  };
}

function statusMatrixOf(spec) {
  return {
    adapter: "implemented",
    discovery: spec?.discovery || "existing-catalogue",
    metadataNormalised: "yes",
    pricingVerified: spec?.pricingVerified === true ? "yes" : "no",
    entitlementVerified: "no",
    requestResponseTested: "mocked",
    liveVerified: "no",
  };
}

function attach(handler, spec, kind) {
  handler.module = {
    id: spec.id,
    kind,
    protocol: spec.protocol || (kind === "local" ? "openai-compatible" : "openai-compatible"),
    endpointKinds: Array.isArray(spec.endpointKinds) ? spec.endpointKinds : ["chat"],
    provenance: provenanceOf(spec),
    normaliseModel: typeof spec.normaliseModel === "function" ? spec.normaliseModel : null,
    routeWithinProvider:
      typeof spec.routeWithinProvider === "function" ? spec.routeWithinProvider : null,
    replacementMap: spec.replacementMap || {},
    statusMatrix: statusMatrixOf(spec),
    native: spec.native || null,
    autoRoute: typeof spec.autoRoute === "function" ? spec.autoRoute : null,
  };
  return handler;
}

function defineCloudProvider(spec) {
  if (!spec || !spec.id) throw new Error("A cloud provider module needs an id");
  return attach(cloudHandler(spec.id, spec), spec, "cloud");
}

function defineLocalProvider(spec) {
  if (!spec || !spec.id) throw new Error("A local provider module needs an id");
  return attach(localHandler(spec.id, spec), spec, "local");
}

module.exports = { defineCloudProvider, defineLocalProvider, statusMatrixOf };
