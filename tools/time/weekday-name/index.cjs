async function run({ text, locale = "en-IN" } = {}) {
  const ms = text == null || text === "" ? Date.now() : Date.parse(String(text)) || Number(text);
  if (!Number.isFinite(ms)) return { ok: false, error: "Need a date." };
  const date = new Date(ms);
  return {
    ok: true,
    weekday: new Intl.DateTimeFormat(String(locale || "en-IN"), { weekday: "long" }).format(date),
    iso: date.toISOString(),
  };
}
module.exports = { run };
