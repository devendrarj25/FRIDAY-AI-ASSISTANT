// FRIDAY · skill: saf-link-check
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Phishing signals and tracking clean-up for a link. Reads a link and judges it; never opens it.
// It holds 2 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "saf-url-risk",
    gate: null,
    run: (() => {
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
        if (
          /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
          (/^[0-9a-f:]+$/.test(host) && host.includes(":"))
        )
          hit(2, "host is a bare IP address");
        if (labels.some((l) => l.startsWith("xn--")))
          hit(2, "uses punycode (look-alike letters from other alphabets)");
        if (/[^\x00-\x7f]/.test(host))
          hit(2, "host contains non-English letters that can imitate English ones");
        if (SHORTENERS.has(registrable.join(".")))
          hit(2, "link shortener hides the real destination");
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

      async function run(input = {}) {
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
                (i) =>
                  `${i.host}: ${i.risk} risk${i.signals.length ? ` (${i.signals.join("; ")})` : ""}`,
              )
              .join("\n") +
            "\nThis reads the link only and never opens it; no signals does not prove a link is safe.",
        };
      }

      return run;
    })(),
  },
  {
    id: "web-url-clean",
    gate: null,
    run: (() => {
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
        if (host.endsWith("google.com") && url.pathname === "/url")
          inner = pick("q") ?? pick("url");
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
        if (current.protocol === "http:")
          warnings.push("Plain http: nothing on the way is encrypted.");
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

      async function run(input = {}) {
        const raw = input?.urls ?? input?.url;
        const list = Array.isArray(raw)
          ? raw.map(String)
          : raw
            ? [String(raw)]
            : (String(input?.text ?? input?.prompt ?? "").match(/https?:\/\/[^\s<>"')\]]+/gi) ??
              []);
        if (!list.length)
          return {
            ok: false,
            error: "Give a link, for example https://example.com/page?utm_source=x.",
          };
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
