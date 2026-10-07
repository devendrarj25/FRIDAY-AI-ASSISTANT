async function run() {
  const ms = Date.now();
  return { ok: true, ms, seconds: Math.floor(ms / 1000), iso: new Date(ms).toISOString() };
}
module.exports = { run };
