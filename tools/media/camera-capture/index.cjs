const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ dataUrl } = {}) {
  try {
    const camera = require(path.join(ELECTRON, "camera.cjs"));
    return await camera.capture(dataUrl ? { dataUrl } : {});
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
