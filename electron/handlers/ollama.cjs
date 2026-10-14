"use strict";
const { localHandler } = require("./local-bind.cjs");
module.exports = localHandler("ollama", {
  discoverModels(payload) {
    const rows = payload?.models || [];
    return rows.map((row) => row?.name || row?.model || row?.id).filter(Boolean);
  },
});
