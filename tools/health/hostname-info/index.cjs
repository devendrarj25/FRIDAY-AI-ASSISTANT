const os = require("node:os");
async function run() {
  return {
    ok: true,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
  };
}
module.exports = { run };
