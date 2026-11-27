"use strict";

const os = require("os");

/**
 * An error text or a status field that goes to the renderer never carries a path of this PC (the user profile name
 * sits in it). Each of these becomes `<path>` and the rest of the line stays, so the cause is still read:
 *   this PC's home folder (also in its forward-slash form), a Windows profile path (a space in the name is fine),
 *   a drive path (spaces inside a folder name are fine, at most four words per folder), a file URL, a URL-encoded
 *   drive or system path (`C%3A%5CUsers`, `%2Fhome%2F`), a network share (`\\host\share` and `//host/share`), and a
 *   POSIX home or system path. A web address (`https://tmp.example.com/home/x`) is not a path and stays as it is.
 */
function scrubPaths(text) {
  let out = String(text ?? "");
  let home = "";
  try {
    home = os.homedir();
  } catch {
    /* no home folder: the patterns below still cover the shapes */
  }
  if (home && home.length > 3) {
    for (const form of new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])) {
      out = out.split(form).join("<home>");
    }
  }
  const tail = String.raw`(?:[\\/][^\s'"<>|)\]}]*)?`;
  const word = String.raw`[^\\/\s'"<>|:*?\r\n]+`;
  const folder = String.raw`${word}(?: ${word}){0,3}`;
  return out
    .replace(new RegExp(String.raw`\b[A-Za-z]%3A(?:%5C|%2F|[\\/])[^\s'"<>|)\]}]*`, "gi"), "<path>")
    .replace(
      new RegExp(
        String.raw`%2F(?:home|Users|root|tmp|var|opt|usr|etc|mnt|private)(?:%2F[^\s'"<>|)\]}]*)?`,
        "gi",
      ),
      "<path>",
    )
    .replace(
      new RegExp(
        String.raw`(?:<home>|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+Users[\\/]+[^\\/'"\r\n]+)${tail}`,
        "gi",
      ),
      "<path>",
    )
    .replace(new RegExp(String.raw`\\\\[^\s\\/'"]+${tail}`, "g"), "<path>")
    .replace(new RegExp(String.raw`(?<![\w.:/])//[^\s/'"]+/[^\s'"<>|)\]}]+`, "g"), "<path>")
    .replace(
      new RegExp(
        String.raw`(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+(?:${folder}[\\/]+)*[^\s'"<>|)\]}]*`,
        "g",
      ),
      "<path>",
    )
    .replace(
      new RegExp(
        String.raw`(?<![\w.:/])/(?:home|Users|root|tmp|var|opt|usr|etc|mnt|private)(?:/[^\s'"<>|)\]}]*)?`,
        "g",
      ),
      "<path>",
    );
}

module.exports = { scrubPaths };
