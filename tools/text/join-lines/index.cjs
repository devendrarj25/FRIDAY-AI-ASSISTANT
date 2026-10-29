async function run({ lines, sep = "\n" } = {}) {
  const list = Array.isArray(lines) ? lines : String(lines || "").split(/\r?\n/);
  return { ok: true, text: list.map(String).join(sep == null ? "\n" : String(sep)) };
}
module.exports = { run };
