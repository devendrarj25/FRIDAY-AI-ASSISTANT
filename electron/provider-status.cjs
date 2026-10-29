/**
 * One status matrix for the docs engine. Live verified stays no until the
 * owner runs a keyed check on the Windows PC.
 */
"use strict";

function matrixRows() {
  const cloud = require("./provider-hub-cloud.cjs").list();
  const local = require("./provider-hub-local.cjs").list();
  const missing = require("./provider-coverage.cjs").notAdded();
  const rows = [];
  for (const item of [...cloud, ...local]) {
    const matrix = item.matrix || {};
    rows.push({
      id: item.id,
      adapter: matrix.adapter || "missing",
      discovery: matrix.discovery || "unknown",
      metadataNormalised: matrix.metadataNormalised || "no",
      pricingVerified: matrix.pricingVerified || "no",
      entitlementVerified: matrix.entitlementVerified || "no",
      requestResponseTested: matrix.requestResponseTested || "not-tested",
      liveVerified: "no",
    });
  }
  for (const item of missing) {
    rows.push({
      id: item.id,
      adapter: "not-added",
      discovery: "not-read",
      metadataNormalised: "no",
      pricingVerified: "no",
      entitlementVerified: "no",
      requestResponseTested: "not-tested",
      liveVerified: "no",
    });
  }
  return rows;
}

module.exports = { matrixRows };
