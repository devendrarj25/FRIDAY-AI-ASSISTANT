// FRIDAY · skill: saf-url-risk
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Look for phishing signals in a link by reading it only; the link is never opened.

const BRANDS = [
  "google",
  "microsoft",
  "paypal",
  "amazon",
  "apple",
  "facebook",
  "instagram",
  "whatsapp",
  "netflix",
  "paytm",
  "phonepe",
  "sbi",
  "hdfc",
  "icici",
  "flipkart",
  "github",
  "linkedin",
  "twitter",
  "youtube",
  "gmail",
];
const SHORTENERS = new Set([
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "goo.gl",
  "is.gd",
  "cutt.ly",
  "rb.gy",
  "ow.ly",
  "buff.ly",
  "shorturl.at",
]);
const BAD_TLDS = new Set([
  "zip",
  "mov",
  "tk",
  "ml",
  "ga",
  "cf",
  "gq",
  "top",
  "click",
  "country",
  "kim",
  "work",
]);
const TWO_LEVEL = new Set([
  "co.uk",
  "co.in",
  "com.au",
  "org.in",
  "gov.in",
  "net.in",
  "ac.in",
  "co.jp",
  "com.br",
]);
const LOOK = { 0: "o", 1: "l", 3: "e", 5: "s", 4: "a" };

const squash = (s) =>
  [...s]
    .map((c) => LOOK[c] ?? c)
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w");

function analyse(raw) {
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(raw);
  if (!m) return null;
  const scheme = (m[1] ?? "").toLowerCase();
  let authority = m[2];
  const userinfo = authority.includes("@");
  if (userinfo) authority = authority.slice(authority.lastIndexOf("@") + 1);
  const host = authority
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!host) return null;
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  const last2 = labels.slice(-2).join(".");
  const registrable = TWO_LEVEL.has(last2) ? labels.slice(-3) : labels.slice(-2);
  const label = registrable[0] ?? host;
  const subs = labels.slice(0, labels.length - registrable.length);
  const signals = [];
  let score = 0;
  const hit = (points, text) => {
    score += points;
    signals.push(text);
  };
  if (scheme && scheme !== "https") hit(1, `uses ${scheme} instead of https`);
  if (!scheme) hit(0, "no scheme given, so https was assumed for this check");
  if (userinfo) hit(3, "has name@ before the host, a classic trick to hide the real address");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || (/^[0-9a-f:]+$/.test(host) && host.includes(":")))
    hit(2, "host is a bare IP address");
  if (labels.some((l) => l.startsWith("xn--")))
    hit(2, "uses punycode (look-alike letters from other alphabets)");
  if (/[^\x00-\x7f]/.test(host))
    hit(2, "host contains non-English letters that can imitate English ones");
  if (SHORTENERS.has(registrable.join("."))) hit(2, "link shortener hides the real destination");
  if (subs.length > 3) hit(1, `${subs.length} sub-domain levels`);
  if (BAD_TLDS.has(tld)) hit(1, `.${tld} is often used for throw-away sites`);
  if (raw.length > 100) hit(1, "very long link");
  if (/%[0-9a-f]{2}/i.test(host)) hit(2, "host is percent-encoded");
  const brand = BRANDS.find((b) => {
    if (label === b) return false;
    return squash(label).includes(b) || subs.some((s) => s === b || squash(s).includes(b));
  });
  if (brand) hit(3, `mentions "${brand}" but is not the ${brand} domain`);
  if (
    score > 0 &&
    /login|signin|verify|secure|account|update|password|wallet|kyc/i.test(m[3] + (m[4] ?? ""))
  ) {
    hit(1, "asks you to log in, verify or update something");
  }
  return {
    url: raw,
    host,
    risk: score >= 4 ? "high" : score >= 2 ? "medium" : "low",
    score,
    signals,
  };
}

export async function run(input = {}) {
  const text = String(input?.url ?? input?.prompt ?? input?.text ?? "");
  const urls = [
    ...new Set(text.match(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`)]+/gi) ?? []),
  ].slice(0, 10);
  const items = urls.map((u) => analyse(u.replace(/[.,;:!?]+$/, ""))).filter(Boolean);
  if (!items.length) return { ok: false, error: "No link found in the text." };
  return {
    ok: true,
    items,
    answer:
      items
        .map(
          (i) => `${i.host}: ${i.risk} risk${i.signals.length ? ` (${i.signals.join("; ")})` : ""}`,
        )
        .join("\n") +
      "\nThis reads the link only and never opens it; no signals does not prove a link is safe.",
  };
}

export default run;
