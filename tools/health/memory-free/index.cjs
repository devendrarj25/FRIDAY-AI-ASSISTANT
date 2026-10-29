const os = require("node:os");
async function run() {
  const free = os.freemem();
  const total = os.totalmem();
  return {
    ok: true,
    free,
    total,
    freeMiB: Math.round(free / 1048576),
    totalMiB: Math.round(total / 1048576),
  };
}
module.exports = { run };
