const os = require("node:os");
async function run() {
  const [one, five, fifteen] = os.loadavg();
  return { ok: true, one, five, fifteen, platform: os.platform() };
}
module.exports = { run };
