function pick(block, tag) {
  const match = block.match(new RegExp("^" + tag + "[^:]*:(.*)$", "im"));
  return match ? match[1].trim() : "";
}
async function run({ text, limit = 40 } = {}) {
  if (!text) return { ok: false, error: "ICS text is required." };
  const blocks = String(text)
    .split(/BEGIN:VEVENT/i)
    .slice(1);
  const events = blocks.map((block) => ({
    summary: pick(block, "SUMMARY"),
    start: pick(block, "DTSTART"),
    end: pick(block, "DTEND"),
    location: pick(block, "LOCATION"),
  }));
  return { ok: true, count: events.length, events: events.slice(0, Number(limit) || 40) };
}
module.exports = { run };
