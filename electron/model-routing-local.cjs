/**
 * Local side router. It marks runners that are not loaded.
 * The master router still applies selectEligible.
 */
"use strict";

function prepare(models) {
  const unavailable = [];
  for (const model of models || []) {
    const provider = String(model?.providerId || model?.meta?.providerId || "");
    if (provider === "lmstudio" && model?.meta?.loaded === false) {
      unavailable.push({ id: String(model.id || ""), reason: "not loaded" });
    }
  }
  return { models: models || [], unavailable };
}

module.exports = { prepare };
