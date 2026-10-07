const MAP = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  xml: "application/xml",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  js: "text/javascript",
  cjs: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
};
async function run({ name } = {}) {
  if (!name) return { ok: false, error: "A filename is required." };
  const ext = String(name).split(".").pop().toLowerCase();
  const mime = MAP[ext] || "application/octet-stream";
  return { ok: true, ext, mime, known: Boolean(MAP[ext]) };
}
module.exports = { run };
