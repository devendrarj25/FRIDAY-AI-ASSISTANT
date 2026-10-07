const os = require("node:os");
async function run() {
  const cpus = os.cpus() || [];
  return { ok: true, count: cpus.length, model: cpus[0]?.model || null };
}
module.exports = { run };
