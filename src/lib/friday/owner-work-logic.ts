/**
 * FRIDAY · owner-work pure logic
 *
 * Spreadsheet/CSV parsing, bookkeeping maths, tender span extraction and
 * decision structuring. Nothing here talks to the network, the disk or a
 * model — the persist/chat wrappers call these with real owner data so the
 * numbers and quotes can never be invented.
 */

export const LEDGER_MARK = "FRIDAY_LEDGER";
export const NOTE_TAG = "owner-note";
export const TASK_TAG = "owner-task";
export const SOCIAL_DRAFT_TAG = "social-draft";

export type MoneyTxn = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  side: "income" | "expense";
  category: string;
  payee: string;
  memo: string;
  source: string;
};

export type LedgerTotals = {
  income: number;
  expense: number;
  net: number;
  count: number;
  byCategory: Record<string, number>;
};

export const emptyTotals = (): LedgerTotals => ({
  income: 0,
  expense: 0,
  net: 0,
  count: 0,
  byCategory: {},
});

export function applyTxn(totals: LedgerTotals, txn: MoneyTxn): LedgerTotals {
  const income = totals.income + (txn.side === "income" ? txn.amount : 0);
  const expense = totals.expense + (txn.side === "expense" ? txn.amount : 0);
  const byCategory = { ...totals.byCategory };
  const signed = txn.side === "income" ? txn.amount : -txn.amount;
  byCategory[txn.category] = roundMoney((byCategory[txn.category] ?? 0) + signed);
  return {
    income: roundMoney(income),
    expense: roundMoney(expense),
    net: roundMoney(income - expense),
    count: totals.count + 1,
    byCategory,
  };
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ csv */

export function parseCsv(text: string): Record<string, string>[] {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = splitCsvLines(raw);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]!);
  const header = splitCsvRow(lines[0]!, delimiter).map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = splitCsvRow(line, delimiter);
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key || `col${i}`] = (cells[i] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(header: string): string {
  const counts: Array<[string, number]> = [
    [",", (header.match(/,/g) || []).length],
    ["\t", (header.match(/\t/g) || []).length],
    [";", (header.match(/;/g) || []).length],
    ["|", (header.match(/\|/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![0];
}

function splitCsvLines(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        cur += ch;
      }
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function splitCsvRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseAmount(raw: string): number | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /\b(dr|debit|exp(ense)?)\b/i.test(text);
  const cleaned = text
    .replace(/[₹$€££]/g, "")
    .replace(/,/g, "")
    .replace(/[()]/g, "")
    .replace(/\b(cr|dr|credit|debit|inr|usd|rs\.?)\b/gi, "")
    .trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || cleaned === "") return null;
  return negative ? -Math.abs(n) : n;
}

const DATE_KEYS = ["date", "txn date", "txn_date", "transaction date", "value date", "posted"];
const PAYEE_KEYS = [
  "description",
  "narration",
  "particulars",
  "payee",
  "details",
  "memo",
  "remarks",
];
const AMOUNT_KEYS = ["amount", "amt", "value", "inr", "rs"];
const DEBIT_KEYS = ["debit", "withdrawal", "dr", "money out"];
const CREDIT_KEYS = ["credit", "deposit", "cr", "money in"];
const TYPE_KEYS = ["type", "side", "dr/cr", "txn type"];
const CATEGORY_KEYS = ["category", "head", "account"];

function pick(row: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    if (row[key]) return row[key]!;
  }
  for (const key of keys) {
    const hit = Object.keys(row).find((k) => k.replace(/[_/]+/g, " ") === key);
    if (hit && row[hit]) return row[hit]!;
  }
  return "";
}

export function rowToTxn(row: Record<string, string>, id: string, source: string): MoneyTxn | null {
  const debitRaw = pick(row, DEBIT_KEYS);
  const creditRaw = pick(row, CREDIT_KEYS);
  const debit = debitRaw ? parseAmount(debitRaw) : null;
  const credit = creditRaw ? parseAmount(creditRaw) : null;
  let amount: number | null;
  let side: "income" | "expense";
  if (debitRaw || creditRaw) {
    const net = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    if (net === 0) return null;
    side = net > 0 ? "income" : "expense";
    amount = Math.abs(net);
  } else {
    amount = parseAmount(pick(row, AMOUNT_KEYS));
    if (amount == null || amount === 0) return null;
    const typed = pick(row, TYPE_KEYS).toLowerCase();
    if (/\b(income|credit|cr|sale|receipt)\b/.test(typed)) {
      side = "income";
      amount = Math.abs(amount);
    } else if (/\b(expense|debit|dr|payment)\b/.test(typed)) {
      side = "expense";
      amount = Math.abs(amount);
    } else if (amount < 0) {
      side = "expense";
      amount = Math.abs(amount);
    } else {
      side = "income";
    }
  }

  if (amount == null) return null;

  const payee = pick(row, PAYEE_KEYS) || "(unnamed)";
  const givenCategory = pick(row, CATEGORY_KEYS);
  const category = givenCategory ? slugCategory(givenCategory) : categorise(payee);
  const date = normaliseDate(pick(row, DATE_KEYS)) || "unknown";

  return {
    id,
    date,
    amount: roundMoney(Math.abs(amount)),
    currency: "INR",
    side,
    category,
    payee,
    memo: pick(row, ["memo", "notes", "remark", "remarks"]),
    source,
  };
}

export function slugCategory(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "uncategorised"
  );
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/\b(rent|lease|landlord)\b/i, "rent"],
  [/\b(salary|wages|payroll|stipend)\b/i, "payroll"],
  [/\b(gst|tds|tax|vat|income tax)\b/i, "tax"],
  [/\b(fuel|petrol|diesel|uber|ola|travel|flight|hotel)\b/i, "travel"],
  [/\b(electric|electricity|internet|wifi|broadband|phone bill|airtel|jio)\b/i, "utilities"],
  [/\b(amazon|stationery|supplies|office supplies|printer)\b/i, "supplies"],
  [/\b(client|invoice|payment received|sale|revenue|fee received)\b/i, "revenue"],
  [/\b(interest|dividend)\b/i, "investment"],
  [/\b(insurance|premium)\b/i, "insurance"],
  [/\b(advert|ads|marketing|facebook ads|google ads)\b/i, "marketing"],
];

export function categorise(text: string): string {
  const hay = String(text || "");
  for (const [re, category] of CATEGORY_RULES) {
    if (re.test(hay)) return category;
  }
  return "uncategorised";
}

export function normaliseDate(raw: string): string | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(text);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    const dd = dmy[1]!.padStart(2, "0");
    const mm = dmy[2]!.padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

export function profitAndLoss(
  txns: MoneyTxn[],
  range?: { from?: string; to?: string },
): LedgerTotals {
  let totals = emptyTotals();
  for (const txn of txns) {
    if (range?.from && txn.date < range.from) continue;
    if (range?.to && txn.date > range.to) continue;
    totals = applyTxn(totals, txn);
  }
  return totals;
}

export function isoDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function calendarRangeFromText(
  text: string,
  now = new Date(),
): { from?: string; to?: string } | undefined {
  const value = String(text || "");
  if (/\b(is|iss|this)\s+(hafte|week)\b/i.test(value)) {
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(now.getDate() + mondayOffset);
    return { from: isoDate(monday), to: isoDate(now) };
  }
  if (/\b(is|iss|this)\s+(mahine|month)\b/i.test(value)) {
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    return { from, to: isoDate(now) };
  }
  return undefined;
}

function looksLikePayeeName(value: string): boolean {
  const name = String(value || "").trim();
  if (!name) return false;
  if (/^(who|what|when|where|why|which|how|import|show|the|my|is|are|please)\b/i.test(name)) {
    return false;
  }
  if (name.split(/\s+/).length > 6) return false;
  if (/\b(happened|current|prime|minister|news)\b/i.test(name)) return false;
  return true;
}

export function parsePayeeAsk(
  text: string,
  now = new Date(),
): { payee: string; range?: { from?: string; to?: string } } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (
    /^(who|what|when|where|why|which)\b/i.test(raw) &&
    !/\b(ko|diya|baaki|baki|payee|paid to|given to|kitna)\b/i.test(raw)
  ) {
    return null;
  }
  const range = calendarRangeFromText(raw, now);
  const ko = raw.match(
    /^(.+?)\s+ko\s+(?:kitna\s+(?:diya|dena|mila)|baaki|baki|kitna\s+baaki|kya\s+diya)/i,
  );
  if (ko?.[1] && looksLikePayeeName(ko[1]))
    return { payee: ko[1].trim(), ...(range ? { range } : {}) };
  const paid = raw.match(
    /\b(?:how much (?:did i |have i )?(?:pay|paid|give|given)(?: to)?|paid to|total (?:paid|given) to)\s+(.+?)(?:\?|$)/i,
  );
  if (paid?.[1] && looksLikePayeeName(paid[1].replace(/[?]+$/, ""))) {
    return { payee: paid[1].trim().replace(/[?]+$/, ""), ...(range ? { range } : {}) };
  }
  const weekNamed = raw.match(/^(.+?)\s+(?:is|iss|this)\s+(hafte|week|mahine|month)\b/i);
  if (weekNamed?.[1] && looksLikePayeeName(weekNamed[1])) {
    return { payee: weekNamed[1].trim(), ...(range ? { range } : {}) };
  }
  return null;
}

export function payeeTotals(
  txns: MoneyTxn[],
  payee: string,
  range?: { from?: string; to?: string },
): { rows: MoneyTxn[]; given: number; received: number; net: number; count: number } {
  const needle = String(payee || "")
    .trim()
    .toLowerCase();
  const rows = txns.filter((txn) => {
    if (range?.from && txn.date < range.from) return false;
    if (range?.to && txn.date > range.to) return false;
    return txn.payee.toLowerCase().includes(needle);
  });
  let given = 0;
  let received = 0;
  for (const txn of rows) {
    if (txn.side === "expense") given += txn.amount;
    else received += txn.amount;
  }
  return {
    rows,
    given: roundMoney(given),
    received: roundMoney(received),
    net: roundMoney(received - given),
    count: rows.length,
  };
}

/** Prefix the ledger JSON so the privacy firewall treats a cloud send as SENSITIVE. */
export function markLedgerPayload(payload: unknown): string {
  return `${LEDGER_MARK}\n${JSON.stringify(payload)}`;
}

/* ---------------------------------------------------------------- tender */

export type ExtractedField = {
  id: string;
  label: string;
  value: string | null;
  quote: string | null;
  ambiguous: string | null;
};

export type TenderExtract = {
  sourceChars: number;
  fields: ExtractedField[];
  missing: string[];
  flags: string[];
};

const FIELD_PATTERNS: { id: string; label: string; re: RegExp }[] = [
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

export function extractTender(text: string): TenderExtract {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const fields: ExtractedField[] = [];
  const missing: string[] = [];
  const flags: string[] = [];
  const dates: string[] = [];

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
    let ambiguous: string | null = null;
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

function clipQuote(source: string, needle: string): string | null {
  const idx = source.toLowerCase().indexOf(needle.toLowerCase().slice(0, 40));
  if (idx < 0) return needle.slice(0, 160);
  const start = Math.max(0, idx - 12);
  return source.slice(start, start + Math.min(180, needle.length + 24)).trim();
}

export function formatTenderExtract(extract: TenderExtract): string {
  if (!extract.sourceChars) {
    return "I need the actual tender/RFP text (or a document I can extract text from). I will not guess at clauses that are not on the page.";
  }
  const lines = ["From the document's own wording:"];
  for (const field of extract.fields) {
    if (!field.value) {
      lines.push(`• ${field.label}: not stated in the text I was given.`);
      continue;
    }
    lines.push(`• ${field.label}: ${field.value}`);
    if (field.ambiguous) lines.push(`  Flag: ${field.ambiguous}`);
  }
  if (extract.flags.length) {
    lines.push("", "Please review these unclear bits rather than me guessing:");
    for (const flag of extract.flags) lines.push(`• ${flag}`);
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------- advice */

export type AdviceFrame = {
  question: string;
  options: string[];
  fromOwner: { polarity: "for" | "against" | "note"; text: string }[];
  open: string[];
};

export function structureAdvice(question: string): AdviceFrame {
  const text = String(question || "").trim();
  const options = splitOptions(text);
  const fromOwner: AdviceFrame["fromOwner"] = [];
  const because = /because\s+([^.]{4,200})/i.exec(text);
  if (because?.[1]) fromOwner.push({ polarity: "note", text: because[1].trim() });
  const but = /but\s+([^.]{4,200})/i.exec(text);
  if (but?.[1]) fromOwner.push({ polarity: "against", text: but[1].trim() });
  const although = /(?:although|though)\s+([^.]{4,200})/i.exec(text);
  if (although?.[1]) fromOwner.push({ polarity: "note", text: although[1].trim() });

  const open: string[] = [];
  for (const option of options) {
    const covered = fromOwner.some((row) =>
      row.text.toLowerCase().includes(option.toLowerCase().slice(0, 12)),
    );
    if (!covered) {
      open.push(`pros of “${option}” (you have not said any)`);
      open.push(`cons of “${option}” (you have not said any)`);
    }
  }
  if (!options.length) {
    open.push("what the real choices are");
    open.push("what a wrong call would cost you");
  }
  return { question: text, options, fromOwner, open };
}

function splitOptions(text: string): string[] {
  const or = /\bshould i\s+(.+?)\s+or\s+(.+?)(?:\?|$)/i.exec(text);
  if (or?.[1] && or[2]) return [cleanOption(or[1]), cleanOption(or[2])];
  const vs = /(.+?)\s+(?:vs\.?|versus)\s+(.+)/i.exec(text);
  if (vs?.[1] && vs[2]) return [cleanOption(vs[1]), cleanOption(vs[2])];
  const hire = /\bshould i\s+([^?]{4,80})\??/i.exec(text);
  if (hire?.[1] && !/\bor\b/i.test(hire[1])) return [cleanOption(hire[1]), "not doing that"];
  return [];
}

function cleanOption(value: string): string {
  return value
    .replace(/^(should i|do i|to)\s+/i, "")
    .replace(/[?.!]+$/g, "")
    .trim()
    .slice(0, 80);
}

export function formatAdvice(frame: AdviceFrame): string {
  const lines = [
    "I will not invent advice you did not give me. Here is the decision as you actually wrote it.",
    `Question: ${frame.question}`,
  ];
  if (frame.options.length) {
    lines.push(
      `Options I can see in your wording: ${frame.options.map((o) => `“${o}”`).join(" · ")}`,
    );
  } else {
    lines.push("I could not see distinct options in that sentence.");
  }
  if (frame.fromOwner.length) {
    lines.push("What you already said:");
    for (const row of frame.fromOwner) {
      lines.push(`• ${row.polarity}: ${row.text}`);
    }
  } else {
    lines.push("You have not given me any reasons yet, so the for/against columns stay empty.");
  }
  if (frame.open.length) {
    lines.push("Still open (fill these in your words if you want me to weigh them):");
    for (const slot of frame.open.slice(0, 6)) lines.push(`• ${slot}`);
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------- due / site */

export function parseDueAt(text: string, now = Date.now()): number | null {
  const raw = String(text || "");
  if (/\btomorrow\b/i.test(raw)) return startOfDay(now) + 36 * 3600_000;
  if (/\btonight\b/i.test(raw)) return startOfDay(now) + 21 * 3600_000;
  const inHours = /\bin\s+(\d+)\s+hours?\b/i.exec(raw);
  if (inHours) return now + Number(inHours[1]) * 3600_000;
  const inDays = /\bin\s+(\d+)\s+days?\b/i.exec(raw);
  if (inDays) return now + Number(inDays[1]) * 86400_000;
  const iso = /\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(raw);
  if (iso) {
    const stamp = Date.parse(`${iso[1]}T${iso[2] || "09:00"}:00`);
    return Number.isNaN(stamp) ? null : stamp;
  }
  const dmy = /\bon\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(raw);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    const stamp = Date.parse(
      `${year}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}T09:00:00`,
    );
    return Number.isNaN(stamp) ? null : stamp;
  }
  return null;
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type SiteStatus = {
  url: string;
  up: boolean;
  status: number | null;
  ms: number | null;
  title: string | null;
  note: string;
};

export function interpretSiteStatus(input: {
  url: string;
  status?: number | undefined;
  ok?: boolean | undefined;
  ms?: number | undefined;
  body?: string | undefined;
  error?: string | undefined;
}): SiteStatus {
  const url = String(input.url || "").trim();
  if (input.error) {
    return {
      url,
      up: false,
      status: null,
      ms: input.ms ?? null,
      title: null,
      note: `I could not reach ${url}: ${input.error}`,
    };
  }
  const status = input.status ?? null;
  const up = Boolean(input.ok) || (status != null && status >= 200 && status < 400);
  const titleMatch = String(input.body || "").match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? null;
  return {
    url,
    up,
    status,
    ms: input.ms ?? null,
    title,
    note: up
      ? `${url} answered ${status ?? "ok"}${title ? ` — “${title}”` : ""}${input.ms != null ? ` in ${input.ms}ms` : ""}.`
      : `${url} is not answering as a healthy site${status != null ? ` (HTTP ${status})` : ""}.`,
  };
}

export const SITE_PLATFORM_NEEDED =
  "I can check whether a URL is up, but I will not guess at publishing or editing your live site. Tell me the platform (WordPress or Shopify) and connect it on Connectors. Any publish or edit on a live site still goes through the existing approval gate, every time.";

export const SOCIAL_UNSUPPORTED =
  "Connect X/Twitter, Instagram, Facebook or LinkedIn on Connectors before I can post there. Slack, Discord, Telegram, Microsoft Teams and WhatsApp Cloud can also post when connected. I still draft locally and post only after you approve.";

export function cmsConnectHint(name: string): string {
  return `Connect ${name} on Connectors first. I will not guess credentials. Publish and edit still go through the approval gate every time.`;
}

export function socialConnectHint(name: string): string {
  return `Connect ${name} on Connectors first. I still draft locally and post only after you approve.`;
}

export type NamedConnector = { id: string; name: string };

export function namedCms(prompt: string): NamedConnector | null {
  const text = String(prompt || "");
  if (/\bwordpress\b|\bwp-admin\b/i.test(text)) return { id: "wordpress", name: "WordPress" };
  if (/\bshopify\b/i.test(text)) return { id: "shopify", name: "Shopify" };
  return null;
}

export function namedSocial(prompt: string): NamedConnector | null {
  const text = String(prompt || "");
  if (/\binstagram\b/i.test(text)) return { id: "instagram", name: "Instagram" };
  if (/\bfacebook\b|\bfb\b/i.test(text)) return { id: "facebook", name: "Facebook" };
  if (/\blinkedin\b/i.test(text)) return { id: "linkedin", name: "LinkedIn" };
  if (
    /\btwitter\b|\bx\.com\b|(^|\s)x(\s|$)/i.test(text) &&
    /\b(twitter|tweet|x\.com)\b/i.test(text)
  )
    return { id: "twitter", name: "X / Twitter" };
  if (/\btweet\b|\bpost to x\b|\bpost on x\b/i.test(text))
    return { id: "twitter", name: "X / Twitter" };
  return null;
}

export function cmsWriteActionId(connectorId: string, prompt: string): string {
  const edit = /\bedit\b/i.test(prompt);
  if (connectorId === "shopify") return edit ? "edit-page" : "publish-page";
  return edit ? "edit" : "publish";
}

export function socialWriteActionId(connectorId: string): string {
  return "post";
}
