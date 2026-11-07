// FRIDAY · skill: doc-markdown-toc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Build a table of contents from a Markdown document, with GitHub-style anchors, and flag skipped heading levels.

const plain = (s) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();

function anchor(title) {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export async function run(input = {}) {
  const text = String(input?.text ?? input?.prompt ?? "").replace(/\r\n/g, "\n");
  const maxLevel = Math.min(6, Math.max(1, Number(input.maxLevel) || 6));
  const headings = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) headings.push({ level: m[1].length, title: plain(m[2]) });
  }
  const shown = headings.filter((h) => h.title && h.level <= maxLevel);
  if (!shown.length) return { ok: false, error: "No Markdown headings (# Title) found." };
  const used = new Map();
  const min = Math.min(...shown.map((h) => h.level));
  const warnings = [];
  let prev = null;
  const lines = shown.map((h) => {
    let a = anchor(h.title);
    const n = used.get(a) ?? 0;
    used.set(a, n + 1);
    if (n) a = `${a}-${n}`;
    if (prev !== null && h.level > prev + 1) {
      warnings.push(`"${h.title}" jumps from level ${prev} to ${h.level}.`);
    }
    prev = h.level;
    return `${"  ".repeat(h.level - min)}- [${h.title}](#${a})`;
  });
  return {
    ok: true,
    headings: shown.length,
    toc: lines.join("\n"),
    warnings,
    answer: lines.join("\n"),
  };
}

export default run;
