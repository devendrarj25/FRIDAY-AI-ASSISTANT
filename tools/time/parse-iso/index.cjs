async function run({ text } = {}) {
  if (!text) return { ok: false, error: "A date string is required." };
  const ms = Date.parse(String(text));
  if (!Number.isFinite(ms)) return { ok: false, error: "That is not a date I can parse." };
  const date = new Date(ms);
  return { ok: true, ms, iso: date.toISOString(), utc: date.toUTCString() };
}
module.exports = { run };
