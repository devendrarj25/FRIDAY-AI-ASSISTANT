/**
 * Local side router. It marks local models that cannot serve a turn right now:
 * a model the engine reports as not loaded (LM Studio), and a model a failed
 * call delisted (any local engine). The trace shows why; the master router
 * still applies selectEligible, which is what actually skips them.
 */
"use strict";

const modelAccess = require("./model-access.cjs");

function providerOf(model) {
  return String(
    model?.providerId || model?.meta?.providerId || model?.provider || "",
  ).toLowerCase();
}

function reasonFor(model) {
  const notLoaded = model?.meta?.loaded === false;
  if (!notLoaded && model?.status !== "unavailable") return "";
  // LM Studio holds downloads it has not loaded; other engines are delisted after a failed call.
  return notLoaded && providerOf(model) === "lmstudio" ? "not loaded" : "not available";
}

function prepare(models) {
  const unavailable = [];
  for (const model of models || []) {
    if (!model || !modelAccess.isLocalModel(model)) continue;
    const reason = reasonFor(model);
    if (reason) unavailable.push({ id: String(model.id || ""), reason });
  }
  return { models: models || [], unavailable };
}

module.exports = { prepare };
