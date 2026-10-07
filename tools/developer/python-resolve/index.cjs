const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
async function run({ root } = {}) {
  try {
    const python = require(path.join(ELECTRON, "python.cjs"));
    const resolved = await python.resolvePython(root || null);
    if (!resolved) return { ok: false, error: "No supported Python interpreter was found." };
    return { ok: true, ...resolved };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
