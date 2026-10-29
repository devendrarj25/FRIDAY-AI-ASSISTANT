const os = require("node:os");
async function run() {
  const seconds = os.uptime();
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return { ok: true, seconds, label: hours + "h " + minutes + "m" };
}
module.exports = { run };
