// FRIDAY · tools/system/credential-vault
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const credentials = require(path.join(ELECTRON, "credentials.cjs"));
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));

function rootOf(input = {}) {
  return input.root || contract.rootFromEnv();
}

async function run(input = {}) {
  const root = rootOf(input);
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const action = String(input.action || "list").toLowerCase();
  if (action === "list") {
    const ids = credentials.listSecretIds(root);
    return { ok: true, count: ids.length, ids };
  }
  if (action === "has") {
    const id = String(input.id || "").trim();
    if (!id) return { ok: false, error: "id is required" };
    return { ok: true, id, present: credentials.hasSecret(root, id) };
  }
  if (action === "get") {
    const id = String(input.id || "").trim();
    if (!id) return { ok: false, error: "id is required" };
    const value = credentials.getSecret(root, id);
    if (!value) return { ok: false, error: "No secret stored for that id.", id };
    return { ok: true, id, value };
  }
  if (action === "set") {
    const id = String(input.id || "").trim();
    if (!id) return { ok: false, error: "id is required" };
    return {
      ...credentials.setSecret(root, id, input.value == null ? "" : String(input.value)),
      id,
    };
  }
  if (action === "delete") {
    const id = String(input.id || "").trim();
    if (!id) return { ok: false, error: "id is required" };
    return { ...credentials.setSecret(root, id, ""), id, deleted: true };
  }
  return { ok: false, error: `Unknown vault action: ${action}` };
}

module.exports = { run };
