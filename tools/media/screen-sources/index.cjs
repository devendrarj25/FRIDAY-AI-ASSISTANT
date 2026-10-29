const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  try {
    const vision = require(path.join(ELECTRON, "screen-vision.cjs"));
    return await vision.sources();
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
