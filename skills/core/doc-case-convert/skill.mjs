// FRIDAY · skill: doc-case-convert
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Change the naming style of a phrase: snake_case, camelCase, PascalCase, kebab-case, Title Case, slug and more.

const STYLES = [
  "snake",
  "camel",
  "pascal",
  "kebab",
  "constant",
  "title",
  "sentence",
  "slug",
  "dot",
  "upper",
  "lower",
];
const ALIAS = {
  screaming: "constant",
  macro: "constant",
  dash: "kebab",
  hyphen: "kebab",
  capital: "title",
};

function tokens(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const fold = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "");

const MAKE = {
  snake: (w) => w.map((x) => x.toLowerCase()).join("_"),
  camel: (w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join(""),
  pascal: (w) => w.map(cap).join(""),
  kebab: (w) => w.map((x) => x.toLowerCase()).join("-"),
  constant: (w) => w.map((x) => x.toUpperCase()).join("_"),
  title: (w) => w.map(cap).join(" "),
  sentence: (w) => w.map((x, i) => (i ? x.toLowerCase() : cap(x))).join(" "),
  slug: (w) =>
    w
      .map((x) =>
        fold(x)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, ""),
      )
      .filter(Boolean)
      .join("-"),
  dot: (w) => w.map((x) => x.toLowerCase()).join("."),
  upper: (w) => w.join(" ").toUpperCase(),
  lower: (w) => w.join(" ").toLowerCase(),
};

export async function run(input = {}) {
  const prompt = String(input?.prompt ?? input?.text ?? "");
  const styleRe = new RegExp(
    `\\b(${[...STYLES, ...Object.keys(ALIAS)].join("|")})[\\s_-]*case\\b|\\b(slug)\\b`,
    "i",
  );
  let target = input.to
    ? String(input.to)
        .toLowerCase()
        .replace(/[\s_-]*case$/, "")
    : null;
  if (!target) {
    const m = styleRe.exec(prompt);
    if (m) target = (m[1] ?? m[2]).toLowerCase();
  }
  if (target && ALIAS[target]) target = ALIAS[target];
  if (target && !MAKE[target]) target = null;

  let source = input.text != null && input.to ? String(input.text) : null;
  if (source === null) {
    const q = /["“'‘`]([^"”'’`]+)["”'’`]/.exec(prompt);
    if (q) source = q[1];
    else {
      const c = /:\s*([^\n]+)$/.exec(prompt);
      if (c) source = c[1];
    }
  }
  if (source === null) {
    source = prompt
      .replace(styleRe, " ")
      .replace(
        /\b(?:convert|change|make|turn|rewrite|into|to|as|in|case|style|format|this|the|please|name)\b/gi,
        " ",
      )
      .trim();
  }
  const words = tokens(source);
  if (!words.length)
    return { ok: false, error: "Give a phrase, e.g. convert 'user profile page' to snake case." };
  const all = {};
  for (const style of STYLES) all[style] = MAKE[style](words);
  return {
    ok: true,
    source,
    target,
    result: target ? all[target] : null,
    all,
    answer: target ? `${target}: ${all[target]}` : STYLES.map((s) => `${s}: ${all[s]}`).join("\n"),
  };
}

export default run;
