async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "A query string is required." };
  const raw = String(text).replace(/^[^?]*\?/, "");
  const params = new URLSearchParams(raw);
  const values = {};
  for (const [key, value] of params.entries()) {
    if (values[key] === undefined) values[key] = value;
    else values[key] = [].concat(values[key], value);
  }
  return { ok: true, values };
}
module.exports = { run };
