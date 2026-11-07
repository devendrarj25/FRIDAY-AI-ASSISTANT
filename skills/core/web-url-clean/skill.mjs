// FRIDAY · skill: web-url-clean
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Cleans links: strips tracking parameters, unwraps redirect wrappers and flags suspicious address tricks.

const TRACKING =
  /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|vero_id|oly_enc_id|oly_anon_id|mkt_tok|spm|ref_src|s_cid)$/i;
const SHORTENERS = new Set([
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "cutt.ly",
  "rebrand.ly",
  "shorturl.at",
  "tiny.cc",
  "rb.gy",
]);

function unwrap(url) {
  const host = url.hostname.toLowerCase();
  const pick = (name) => url.searchParams.get(name);
  let inner = null;
  if (host.endsWith("google.com") && url.pathname === "/url") inner = pick("q") ?? pick("url");
  else if (host === "l.facebook.com" || host === "lm.facebook.com") inner = pick("u");
  else if (host.endsWith("safelinks.protection.outlook.com")) inner = pick("url");
  else if (host === "out.reddit.com") inner = pick("url");
  else if (host.endsWith("youtube.com") && url.pathname === "/redirect") inner = pick("q");
  if (!inner) return null;
  try {
    return new URL(inner);
  } catch {
    return null;
  }
}

function clean(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { input: raw, ok: false, error: "Not a valid absolute URL." };
  }
  const steps = [];
  let current = url;
  for (let i = 0; i < 3; i += 1) {
    const inner = unwrap(current);
    if (!inner) break;
    steps.push(`unwrapped a ${current.hostname} redirect`);
    current = inner;
  }
  const removed = [];
  for (const key of [...current.searchParams.keys()]) {
    if (TRACKING.test(key)) {
      removed.push(key);
      current.searchParams.delete(key);
    }
  }
  const host = current.hostname.toLowerCase();
  const warnings = [];
  if (current.username || current.password)
    warnings.push("The address has user@ in front of the real host, a common disguise.");
  if (/^xn--|\.xn--/.test(host))
    warnings.push("Punycode host: it can imitate a familiar site with look-alike letters.");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\[.*\]$/.test(host))
    warnings.push("The host is a bare IP address, not a name.");
  if (SHORTENERS.has(host))
    warnings.push(
      "A link shortener hides the real destination; open it only if you trust the sender.",
    );
  if (current.protocol === "http:") warnings.push("Plain http: nothing on the way is encrypted.");
  if ((host.match(/\./g) ?? []).length >= 4)
    warnings.push(
      "Many subdomains: check the last two parts of the host, those decide who owns it.",
    );
  if (/%[0-9a-f]{2}/i.test(current.pathname) && /%2e|%2f|%5c/i.test(current.pathname))
    warnings.push("Encoded dots or slashes in the path.");
  const cleaned = current.toString();
  return {
    input: raw,
    ok: true,
    cleaned,
    changed: cleaned !== raw,
    host,
    registrableGuess: host.split(".").slice(-2).join("."),
    removedParameters: removed,
    steps,
    path: decodeURIComponent(current.pathname),
    query: Object.fromEntries(current.searchParams.entries()),
    warnings,
  };
}

export async function run(input = {}) {
  const raw = input?.urls ?? input?.url;
  const list = Array.isArray(raw)
    ? raw.map(String)
    : raw
      ? [String(raw)]
      : (String(input?.text ?? input?.prompt ?? "").match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []);
  if (!list.length)
    return { ok: false, error: "Give a link, for example https://example.com/page?utm_source=x." };
  const results = list.slice(0, 20).map((u) => clean(u.replace(/[.,;:!?]+$/, "")));
  const warned = results.filter((r) => r.ok && r.warnings.length).length;
  return {
    ok: true,
    answer: results
      .map((r) =>
        r.ok
          ? `${r.cleaned}${r.warnings.length ? `  (${r.warnings.length} warning(s))` : ""}`
          : `${r.input}: ${r.error}`,
      )
      .join("\n"),
    results,
    note: warned
      ? "Some links carry warnings. A clean look does not make a link safe; FRIDAY never opens it from this skill."
      : "This skill only rewrites text: it does not open the link.",
  };
}

export default run;
