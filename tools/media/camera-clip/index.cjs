const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ frames } = {}) {
  try {
    const camera = require(path.join(ELECTRON, "camera.cjs"));
    return await camera.clip({ frames });
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
