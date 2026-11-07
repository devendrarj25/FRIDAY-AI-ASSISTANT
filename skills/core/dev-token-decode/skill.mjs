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
        payload.exp < now ? `Expired at ${when(payload.exp)}.` : `Expires at ${when(payload.exp)}.`,
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

export async function run(input = {}) {
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
    if (t !== null) return { ok: true, kind: "hex", text: t, answer: `Hex -> ${t.slice(0, 200)}` };
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
    const t = target.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
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
    tries.push({ kind: "base64", bytes: bytes.length, note: "decodes to bytes that are not text" });
  }
  return {
    ok: false,
    error: "Could not recognise this as JWT, base64, hex, URL-encoded or \\u-escaped text.",
    tried: tries,
  };
}

export default run;
