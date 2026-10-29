async function run({ left, right } = {}) {
  const a = String(left || "").split(/\r?\n/);
  const b = String(right || "").split(/\r?\n/);
  const leftSet = new Set(a);
  const rightSet = new Set(b);
  const removed = a.filter((line) => !rightSet.has(line));
  const added = b.filter((line) => !leftSet.has(line));
  return { ok: true, added, removed, same: a.filter((line) => rightSet.has(line)).length };
}
module.exports = { run };
