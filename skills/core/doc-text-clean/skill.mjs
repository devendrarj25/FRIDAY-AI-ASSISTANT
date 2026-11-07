// FRIDAY · skill: doc-text-clean
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Cleans pasted text and lists: trim, collapse spaces, drop blank or duplicate lines, sort, strip bullets,
// straighten quotes, change case, number the lines. A model is unreliable on long lists; this is exact.

const OPS = [
  "trim",
  "collapse-spaces",
  "remove-blank-lines",
  "dedupe-lines",
  "sort-lines",
  "sort-lines-desc",
  "strip-bullets",
  "straighten-quotes",
  "number-lines",
  "lowercase",
  "uppercase",
  "title-case",
  "reverse-lines",
  "join-lines",
];

function wanted(input, text) {
  if (Array.isArray(input?.ops)) return input.ops.map(String);
  const t = text.toLowerCase();
  const ops = [];
  const has = (re) => re.test(t);
  if (has(/\b(dedupe|duplicate|duplicates|unique|repeated)\b/)) ops.push("dedupe-lines");
  if (has(/\bsort\b.*\b(desc|descending|z to a|reverse)\b|\bz to a\b/)) ops.push("sort-lines-desc");
  else if (has(/\bsort|alphabetical|a to z\b/)) ops.push("sort-lines");
  if (has(/\b(blank|empty) lines?\b/)) ops.push("remove-blank-lines");
  if (has(/\b(bullets?|dashes)\b/)) ops.push("strip-bullets");
  if (has(/\b(smart|curly|straighten)\b.*\bquotes?\b|\bquotes?\b.*\b(straight|plain)\b/))
    ops.push("straighten-quotes");
  if (has(/\bnumber (?:the )?lines\b|\bnumbered\b/)) ops.push("number-lines");
  if (has(/\blower ?case\b/)) ops.push("lowercase");
  if (has(/\bupper ?case\b/)) ops.push("uppercase");
  if (has(/\btitle case\b/)) ops.push("title-case");
  if (has(/\breverse (?:the )?(?:order|lines)\b/)) ops.push("reverse-lines");
  if (has(/\bone line\b|\bjoin (?:the )?lines\b/)) ops.push("join-lines");
  return ops.length ? ops : ["trim", "collapse-spaces", "remove-blank-lines", "straighten-quotes"];
}

/** The text to clean: the block after the first line that holds the instruction, or the text field. */
function body(input) {
  if (input?.text !== undefined && input?.text !== null) return String(input.text);
  const prompt = String(input?.prompt ?? "");
  const at = prompt.indexOf("\n");
  return at >= 0 ? prompt.slice(at + 1) : "";
}

export async function run(input = {}) {
  const prompt = String(input?.prompt ?? "");
  const original = body(input);
  if (!original.trim())
    return {
      ok: false,
      error:
        "Paste the text after the instruction, for example: remove duplicate lines, then the lines on the next line.",
    };
  const ops = wanted(input, `${prompt.split("\n")[0]} ${input?.instruction ?? ""}`);
  const unknown = ops.filter((o) => !OPS.includes(o));
  if (unknown.length)
    return {
      ok: false,
      error: `Unknown operation(s): ${unknown.join(", ")}. Available: ${OPS.join(", ")}.`,
    };
  let lines = original.replace(/\r\n/g, "\n").split("\n");
  const before = lines.length;
  let removedDuplicates = 0;
  const applied = [];
  for (const op of ops) {
    const count = lines.length;
    if (op === "trim") lines = lines.map((l) => l.trim());
    else if (op === "collapse-spaces") lines = lines.map((l) => l.replace(/[ \t\u00a0]{2,}/g, " "));
    else if (op === "remove-blank-lines") lines = lines.filter((l) => l.trim() !== "");
    else if (op === "dedupe-lines") {
      const seen = new Set();
      lines = lines.filter((l) => {
        const key = l.trim().toLowerCase();
        if (key === "") return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      removedDuplicates += count - lines.length;
    } else if (op === "sort-lines")
      lines = [...lines].sort((a, b) =>
        a.localeCompare(b, "en", { sensitivity: "base", numeric: true }),
      );
    else if (op === "sort-lines-desc")
      lines = [...lines].sort((a, b) =>
        b.localeCompare(a, "en", { sensitivity: "base", numeric: true }),
      );
    else if (op === "strip-bullets")
      lines = lines.map((l) => l.replace(/^\s*(?:[-*•●▪–]|\d+[.)])\s+/, ""));
    else if (op === "straighten-quotes")
      lines = lines.map((l) =>
        l
          .replace(/[‘’‚‛]/g, "'")
          .replace(/[“”„‟]/g, '"')
          .replace(/…/g, "...")
          .replace(/[–—]/g, "-"),
      );
    else if (op === "number-lines") lines = lines.map((l, i) => `${i + 1}. ${l}`);
    else if (op === "lowercase") lines = lines.map((l) => l.toLowerCase());
    else if (op === "uppercase") lines = lines.map((l) => l.toUpperCase());
    else if (op === "title-case")
      lines = lines.map((l) =>
        l.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_, a, b) => a + b.toUpperCase()),
      );
    else if (op === "reverse-lines") lines = [...lines].reverse();
    else if (op === "join-lines") lines = [lines.filter((l) => l.trim() !== "").join(" ")];
    applied.push(op);
  }
  return {
    ok: true,
    applied,
    linesBefore: before,
    linesAfter: lines.length,
    duplicatesRemoved: removedDuplicates || undefined,
    result: lines.join("\n"),
    answer: `Applied ${applied.join(", ")}: ${before} line(s) became ${lines.length}${removedDuplicates ? ` (${removedDuplicates} duplicate(s) removed)` : ""}.`,
    note: "Duplicates are compared ignoring case and surrounding spaces; the first occurrence is kept.",
  };
}

export default run;
