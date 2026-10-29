/**
 * FRIDAY · local diagram OCR.
 *
 * Runs the Tesseract binary from Install Manager when it is on PATH.
 * A missing engine is an honest error. This process never calls a cloud OCR.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function recognize(bytes) {
  if (!bytes || !bytes.length) return { ok: false, error: "no image" };
  const bin = process.platform === "win32" ? "tesseract.exe" : "tesseract";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ocr-"));
  const file = path.join(dir, "page.png");
  try {
    fs.writeFileSync(file, bytes);
    const run = spawnSync(bin, [file, "stdout", "-l", "eng", "--psm", "6", "tsv"], {
      timeout: 20000,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.error && run.error.code === "ENOENT") {
      return { ok: false, error: "Tesseract OCR is not installed" };
    }
    if (run.status !== 0) {
      const detail = String(run.stderr || run.error || "tesseract failed").trim();
      return { ok: false, error: detail.slice(0, 240) || "tesseract failed" };
    }
    return { ok: true, tsv: run.stdout || "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function recognizeDataUrl(dataUrl) {
  const text = String(dataUrl || "");
  const comma = text.indexOf(",");
  if (comma < 0) return { ok: false, error: "no image" };
  let bytes;
  try {
    bytes = Buffer.from(text.slice(comma + 1), "base64");
  } catch {
    return { ok: false, error: "no image" };
  }
  return recognize(bytes);
}

module.exports = { recognize, recognizeDataUrl };
