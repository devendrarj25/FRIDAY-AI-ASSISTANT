// FRIDAY · skill: dev-decode-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Decode JWT and base64, inspect UUIDs, check hashes. Reads encoded values and checks hashes.
// It holds 3 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "dev-token-decode",
    gate: null,
    run: (() => {
      // FRIDAY · skill: dev-token-decode
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Decodes JWT, base64, base64url, hex, URL-encoded and \u-escaped text. A JWT is only decoded, never verified.

      const when = (s) => (Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);

      function b64urlToBytes(text) {
        const clean = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
        const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
        return Uint8Array.from(Buffer.from(padded, "base64"));
      }
      const utf8 = (bytes) => {
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return null;
        }
      };

      function jwt(text) {
        const parts = text.trim().split(".");
        if (parts.length !== 3 || !parts.slice(0, 2).every((p) => /^[A-Za-z0-9_-]+$/.test(p)))
          return null;
        try {
          const header = JSON.parse(utf8(b64urlToBytes(parts[0])));
          const payload = JSON.parse(utf8(b64urlToBytes(parts[1])));
          const now = Math.floor(Date.now() / 1000);
          const warnings = [
            "Decoded only. The signature was NOT verified, so nothing here proves the token is genuine.",
          ];
          if (String(header.alg).toLowerCase() === "none")
            warnings.push('alg is "none": the token is unsigned.');
          if (Number.isFinite(payload.exp))
            warnings.push(
              payload.exp < now
                ? `Expired at ${when(payload.exp)}.`
                : `Expires at ${when(payload.exp)}.`,
            );
          return {
            kind: "JWT",
            header,
            payload,
            times: {
              issuedAt: when(payload.iat),
              notBefore: when(payload.nbf),
              expires: when(payload.exp),
            },
            signatureBytes: b64urlToBytes(parts[2]).length,
            warnings,
          };
        } catch {
          return null;
        }
      }

      async function run(input = {}) {
        const text = String(input?.token ?? input?.text ?? input?.prompt ?? "").trim();
        const forced = String(input?.format ?? "").toLowerCase();
        const target =
          (text.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/) ?? [])[0] ??
          text.replace(/^(?:decode|decoded?|base64|hex|token)\s*[:\-]?\s*/i, "");
        if (!target) return { ok: false, error: "Paste the token or encoded text." };
        const tries = [];
        if (!forced || forced === "jwt") {
          const t = jwt(target);
          if (t)
            return {
              ok: true,
              ...t,
              answer: `JWT (${t.header.alg ?? "no alg"}). ${t.warnings.join(" ")}`,
            };
        }
        if ((!forced || forced === "hex") && /^(?:0x)?(?:[0-9a-f]{2}){2,}$/i.test(target)) {
          const bytes = Uint8Array.from(Buffer.from(target.replace(/^0x/i, ""), "hex"));
          const t = utf8(bytes);
          tries.push({ kind: "hex", bytes: bytes.length, text: t });
          if (t !== null)
            return { ok: true, kind: "hex", text: t, answer: `Hex -> ${t.slice(0, 200)}` };
        }
        if ((!forced || forced === "url") && /%[0-9a-f]{2}/i.test(target)) {
          try {
            const t = decodeURIComponent(target.replace(/\+/g, " "));
            return {
              ok: true,
              kind: "url-encoded",
              text: t,
              answer: `URL-decoded -> ${t.slice(0, 200)}`,
            };
          } catch {
            /* not valid percent-encoding */
          }
        }
        if ((!forced || forced === "unicode") && /\\u[0-9a-f]{4}/i.test(target)) {
          const t = target.replace(/\\u([0-9a-f]{4})/gi, (_, h) =>
            String.fromCharCode(parseInt(h, 16)),
          );
          return {
            ok: true,
            kind: "unicode escapes",
            text: t,
            answer: `Unescaped -> ${t.slice(0, 200)}`,
          };
        }
        if (
          (!forced || forced === "base64" || forced === "base64url") &&
          /^[A-Za-z0-9+/_-]{4,}={0,2}$/.test(target) &&
          target.length % 4 !== 1
        ) {
          const bytes = b64urlToBytes(target);
          const t = utf8(bytes);
          if (t !== null && /^[\s\S]*$/.test(t) && !/[\u0000-\u0008\u000e-\u001f]/.test(t)) {
            const nested = jwt(t);
            return {
              ok: true,
              kind: /[-_]/.test(target) ? "base64url" : "base64",
              text: t,
              ...(nested ? { nested } : {}),
              answer: `Base64 -> ${t.slice(0, 200)}`,
            };
          }
          tries.push({
            kind: "base64",
            bytes: bytes.length,
            note: "decodes to bytes that are not text",
          });
        }
        return {
          ok: false,
          error: "Could not recognise this as JWT, base64, hex, URL-encoded or \\u-escaped text.",
          tried: tries,
        };
      }

      return run;
    })(),
  },
  {
    id: "dev-uuid-inspect",
    gate: null,
    run: (() => {
      // FRIDAY · skill: dev-uuid-inspect
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Read a UUID: version, variant and, for time-based versions (1, 6, 7), the moment it was made.

      const RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
      const GREGORIAN_TO_UNIX_100NS = 122192928000000000n;

      function stamp(version, h) {
        const hex = h.replace(/-/g, "");
        let ms = null;
        if (version === 7) ms = Number.parseInt(hex.slice(0, 12), 16);
        else if (version === 1) {
          const t = BigInt("0x" + hex.slice(13, 16) + hex.slice(8, 12) + hex.slice(0, 8));
          ms = Number((t - GREGORIAN_TO_UNIX_100NS) / 10000n);
        } else if (version === 6) {
          const t =
            (BigInt("0x" + hex.slice(0, 8)) << 28n) |
            (BigInt("0x" + hex.slice(8, 12)) << 12n) |
            BigInt("0x" + hex.slice(13, 16));
          ms = Number((t - GREGORIAN_TO_UNIX_100NS) / 10000n);
        }
        if (ms == null || !Number.isFinite(ms)) return null;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      }

      const KIND = {
        1: "time-based (MAC and clock)",
        2: "DCE security",
        3: "name-based (MD5)",
        4: "random",
        5: "name-based (SHA-1)",
        6: "reordered time-based",
        7: "Unix-time ordered (sortable)",
        8: "custom",
      };

      async function run(input = {}) {
        const text = String(input?.uuid ?? input?.prompt ?? input?.text ?? "");
        const found = [...new Set(text.match(RE) ?? [])].slice(0, 20);
        if (!found.length) return { ok: false, error: "No UUID found in the text." };
        const items = found.map((raw) => {
          const h = raw.toLowerCase();
          if (h === "00000000-0000-0000-0000-000000000000")
            return { uuid: h, kind: "nil UUID", version: 0 };
          if (h === "ffffffff-ffff-ffff-ffff-ffffffffffff")
            return { uuid: h, kind: "max UUID", version: 15 };
          const version = Number.parseInt(h[14], 16);
          const v = Number.parseInt(h[19], 16);
          const variant =
            v >= 8 && v <= 11
              ? "RFC 4122 / 9562"
              : v >= 12 && v <= 13
                ? "Microsoft legacy"
                : v >= 14
                  ? "reserved"
                  : "NCS legacy";
          const createdAt = stamp(version, h);
          return {
            uuid: h,
            version,
            kind: KIND[version] ?? "unknown version",
            variant,
            createdAt,
          };
        });
        return {
          ok: true,
          count: items.length,
          items,
          answer: items
            .map(
              (i) =>
                `${i.uuid}: ${i.kind}${i.version ? ` (v${i.version})` : ""}${i.createdAt ? `, made ${i.createdAt}` : ""}`,
            )
            .join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-hash-check",
    gate: /hash|sha|checksum|digest|verify/,
    run: (() => {
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

      async function run(input = {}) {
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
          if (
            !out.matches &&
            HEX_LENGTH[expected.length] &&
            HEX_LENGTH[expected.length] !== algorithm
          )
            out.hint = `The expected value has ${expected.length} hex characters, which is ${HEX_LENGTH[expected.length]}, not ${algorithm}.`;
        } else out.answer = `${algorithm}: ${hex}`;
        out.note =
          "Text only, as UTF-8. A different line ending or a trailing newline gives a different hash. MD5 is not offered: it is broken for security use.";
        return out;
      }

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
