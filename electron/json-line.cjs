/**
 * The Python helpers print one JSON object per line, sometimes after log lines.
 * Take the last line that parses. Cutting the text at the last "{" breaks any
 * result that ends with a nested object (the STT status and the speech
 * self-test both do), which read as "no answer" from a working helper.
 */
"use strict";

function parseJsonLine(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object") return value;
    } catch {
      /* a partial or log line: try the one before it */
    }
  }
  return null;
}

module.exports = { parseJsonLine };
