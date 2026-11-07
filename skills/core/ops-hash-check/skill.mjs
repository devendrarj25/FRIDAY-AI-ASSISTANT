// FRIDAY · skill: ops-hash-check
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// SHA hash of pasted text, and a check against a hash someone published. It reads text only, never a file:
// for a download use  Get-FileHash <file> -Algorithm SHA256  (PowerShell) or  certutil -hashfile <file> SHA256.

const ALGORITHMS = {
  "sha-1": "SHA-1",
  sha1: "SHA-1",
  "sha-256": "SHA-256",
  sha256: "SHA-256",
  "sha-384": "SHA-384",
  sha384: "SHA-384",
  "sha-512": "SHA-512",
  sha512: "SHA-512",
};
const HEX_LENGTH = { 40: "SHA-1", 64: "SHA-256", 96: "SHA-384", 128: "SHA-512" };

const toHex = (bytes) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export async function run(input = {}) {
  const text = input?.text ?? input?.content;
  const prompt = String(input?.prompt ?? "");
  const expected = String(
    input?.expected ?? input?.hash ?? (prompt.match(/\b[a-f0-9]{40,128}\b/i) ?? [""])[0],
  )
    .trim()
    .toLowerCase()
    .replace(/^(?:sha-?\d+:)/, "")
    .replace(/\s+/g, "");
  let algorithm = ALGORITHMS[String(input?.algorithm ?? "").toLowerCase()];
  if (!algorithm)
    algorithm = (prompt.toLowerCase().match(/sha-?(?:1|256|384|512)/) ?? [""])[0]
      ? ALGORITHMS[prompt.toLowerCase().match(/sha-?(?:1|256|384|512)/)[0]]
      : undefined;
  if (!algorithm && expected) algorithm = HEX_LENGTH[expected.length];
  algorithm ||= "SHA-256";
  if (text === undefined || text === null || text === "") {
    if (expected && /^[a-f0-9]+$/.test(expected)) {
      return {
        ok: true,
        answer: `That looks like a ${HEX_LENGTH[expected.length] ?? "hex"} hash (${expected.length} hex characters). To check a downloaded file on Windows run: Get-FileHash <file> -Algorithm ${(HEX_LENGTH[expected.length] ?? "SHA-256").replace("-", "")}  and compare it with this value. Paste the file's text here to hash text instead.`,
        looksLike: HEX_LENGTH[expected.length] ?? null,
      };
    }
    return {
      ok: false,
      error:
        "Give the text to hash. To hash a file, run Get-FileHash <file> -Algorithm SHA256 in PowerShell.",
    };
  }
  const bytes = new TextEncoder().encode(String(text));
  const digest = await globalThis.crypto.subtle.digest(algorithm, bytes);
  const hex = toHex(digest);
  const out = { ok: true, algorithm, utf8Bytes: bytes.length, hex, base64: toBase64(digest) };
  if (expected) {
    out.expected = expected;
    out.matches = hex === expected;
    out.answer = out.matches
      ? `${algorithm} matches the expected hash.`
      : `${algorithm} does NOT match the expected hash.`;
    if (!out.matches && HEX_LENGTH[expected.length] && HEX_LENGTH[expected.length] !== algorithm)
      out.hint = `The expected value has ${expected.length} hex characters, which is ${HEX_LENGTH[expected.length]}, not ${algorithm}.`;
  } else out.answer = `${algorithm}: ${hex}`;
  out.note =
    "Text only, as UTF-8. A different line ending or a trailing newline gives a different hash. MD5 is not offered: it is broken for security use.";
  return out;
}

export default run;
