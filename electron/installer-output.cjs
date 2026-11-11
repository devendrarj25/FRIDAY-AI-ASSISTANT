/**
 * Installer output fit for a log. winget and msiexec redraw one progress line with a carriage
 * return and print spinner frames (dash, backslash, bar, slash); read line by line that becomes dozens of lines of
 * noise. Shared by the Install Manager job and the setup scripts so both print the same thing.
 */
"use strict";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/**
 * One installer output line fit for a log, or "" for noise: spinner frames, progress bars that
 * winget redraws with a carriage return, bare sizes and blank frames. Pure.
 */
function tidyLine(raw) {
  const text = String(raw || "")
    .replace(ANSI, "")
    .split("\r")
    .pop()
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (/^[-\\|/*.\s]+$/.test(text)) return "";
  if (/[█▒▓░■□]/.test(text)) return "";
  if (/^\d+(\.\d+)?\s*[KMG]?i?B\s*\/\s*\d+(\.\d+)?\s*[KMG]?i?B$/i.test(text)) return "";
  if (/^\d{1,3}%$/.test(text)) return "";
  // winget's answers that our own next line already states, its licence notice, and the echo of the command we ran.
  if (
    /^(No available upgrade found\.|No newer package versions are available from the configured sources\.)$/.test(
      text,
    ) ||
    /^(This application is licensed to you by its owner\.|Microsoft is not responsible for, nor does it grant any licenses to, third-party packages\.)$/.test(
      text,
    ) ||
    /^\[(vendor installer|winget|chocolatey|scoop)\] /i.test(text)
  )
    return "";
  return text;
}

/** Every readable line of one output chunk: frames split on \r as well as \n, noise dropped, repeats once. */
function tidyChunk(chunk) {
  const out = [];
  for (const piece of String(chunk || "").split(/[\r\n]+/)) {
    const line = tidyLine(piece);
    if (line && out[out.length - 1] !== line) out.push(line);
  }
  return out;
}

module.exports = { tidyLine, tidyChunk };
