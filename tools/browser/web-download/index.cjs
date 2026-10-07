// FRIDAY · tools/browser/web-download
//
// Delegates to electron/browser.cjs download() + friday-contract root.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

function workspaceRoot(input = {}) {
  const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
  return input.root || contract.rootFromEnv();
}

function needRoot(root) {
  if (root) return null;
  return {
    ok: false,
    error: "No FRIDAY folder is selected — choose the FRIDAY folder first.",
  };
}

async function run({ url, name, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  return browser.download(url, { root: dir, name });
}

module.exports = { run };
