/**
 * FRIDAY · tender / RFP field extract (main process)
 *
 * Quotes clauses that actually appear in the document text. Missing sections
 * stay missing. Ambiguous wording is flagged instead of guessed. Keep in
 * lockstep with src/lib/friday/owner-work-logic.ts (parity test).
 */
const FIELD_PATTERNS = [
  {
    id: "title",
    label: "Title",
    re: /(?:tender title|name of (?:the )?work|subject)\s*[:-]\s*([^\n]{8,200})/i,
  },
  {
    id: "issuer",
    label: "Issuer",
    re: /(?:issued by|procuring entity|department|authority|organisation|organization)\s*[:-]\s*([^\n]{4,160})/i,
  },
  {
    id: "deadline",
    label: "Deadline",
    re: /(?:last date|closing date|due date|deadline|submission (?:date|deadline)|bid due)\s*[:-]\s*([^\n]{4,80})/i,
  },
  {
    id: "eligibility",
    label: "Eligibility",
    re: /(?:eligibility(?: criteria)?|pre-?qualification)\s*[:-]?\s*([\s\S]{20,600}?)(?:\n{2,}|submission|deadline|scope of|earnest)/i,
  },
  {
    id: "scope",
    label: "Scope",
    re: /(?:scope of (?:work|the tender)|statement of work)\s*[:-]?\s*([\s\S]{20,800}?)(?:\n{2,}|eligibility|submission|deadline)/i,
  },
  {
    id: "boq",
    label: "BOQ line items",
    re: /(?:bill of quantities|b\.?\s*o\.?\s*q\.?|schedule of (?:rates|quantities)|boq)\s*[:-]?\s*([\s\S]{20,1200}?)(?:\n{2,}|eligibility|submission|deadline|scope of|earnest)/i,
  },
  {
    id: "submission",
    label: "Submission",
    re: /(?:submission (?:requirements?|procedure)|how to submit|bids? (?:must|shall) be)\s*[:-]?\s*([\s\S]{20,600}?)(?:\n{2,}|eligibility|deadline|earnest)/i,
  },
  {
    id: "emd",
    label: "Earnest money / EMD",
    re: /(?:earnest money|emd|bid security)\s*[:-]\s*([^\n]{4,80})/i,
  },
  {
    id: "value",
    label: "Estimated value",
    re: /(?:estimated (?:value|cost)|tender value|n.i.t. amount)\s*[:-]\s*([^\n]{4,80})/i,
  },
];

const AMBIGUOUS =
  /\b(tbd|to be (specified|decided|notified|announced)|as applicable|if any|or as directed)\b/i;

function clipQuote(source, needle) {
  const idx = source.toLowerCase().indexOf(
    String(needle || "")
      .toLowerCase()
      .slice(0, 40),
  );
  if (idx < 0) return needle ? String(needle).slice(0, 160) : null;
  const start = Math.max(0, idx - 12);
  return source.slice(start, start + Math.min(180, String(needle).length + 24)).trim();
}

function extractTender(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const fields = [];
  const missing = [];
  const flags = [];
  const dates = [];

  for (const pattern of FIELD_PATTERNS) {
    const match = pattern.re.exec(source);
    const raw = match?.[1]?.trim().replace(/\s+/g, " ") ?? null;
    if (!raw) {
      missing.push(pattern.label);
      fields.push({
        id: pattern.id,
        label: pattern.label,
        value: null,
        quote: null,
        ambiguous: null,
      });
      continue;
    }
    const quote = clipQuote(source, raw);
    let ambiguous = null;
    if (raw.length < 12) ambiguous = "too short to be sure this is the full clause";
    if (AMBIGUOUS.test(raw)) ambiguous = "the document itself leaves this unspecified";
    if (pattern.id === "deadline") {
      dates.push(raw);
      if (!/\d/.test(raw)) ambiguous = "no calendar date was found in this line";
    }
    fields.push({
      id: pattern.id,
      label: pattern.label,
      value: raw.slice(0, 500),
      quote,
      ambiguous,
    });
    if (ambiguous) flags.push(`${pattern.label}: ${ambiguous}`);
  }

  if (dates.length >= 2 && dates[0] && dates[1] && dates[0] !== dates[1]) {
    flags.push("more than one deadline-like date was quoted — review before relying on one");
  }

  const vague = [...source.matchAll(/\b(tbd|to be (specified|decided|notified))\b/gi)];
  for (const hit of vague.slice(0, 6)) {
    const around = clipQuote(source, hit[0] || "");
    if (around) flags.push(`Ambiguous wording: “${around}”`);
  }

  return { sourceChars: source.length, fields, missing, flags };
}

function formatTenderExtract(extract) {
  if (!extract || !extract.sourceChars) {
    return "I need the actual tender/RFP text (or a document I can extract text from). I will not guess at clauses that are not on the page.";
  }
  const lines = ["From the document's own wording:"];
  for (const field of extract.fields || []) {
    if (!field.value) {
      lines.push(`• ${field.label}: not stated in the text I was given.`);
      continue;
    }
    lines.push(`• ${field.label}: ${field.value}`);
    if (field.ambiguous) lines.push(`  Flag: ${field.ambiguous}`);
  }
  if (extract.flags?.length) {
    lines.push("", "Please review these unclear bits rather than me guessing:");
    for (const flag of extract.flags) lines.push(`• ${flag}`);
  }
  return lines.join("\n");
}

module.exports = { extractTender, formatTenderExtract, FIELD_PATTERNS };
