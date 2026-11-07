// FRIDAY · skill: dev-text-diff
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Line-by-line comparison of two texts: what was added, removed or kept, as a unified-style diff.

function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

export async function run(input = {}) {
  let before = input?.before ?? input?.a ?? input?.old;
  let after = input?.after ?? input?.b ?? input?.new;
  if (before === undefined || after === undefined) {
    const parts = String(input?.text ?? input?.prompt ?? "").split(
      /^\s*(?:-{3,}|={3,}|\+{3,})\s*$/m,
    );
    if (parts.length === 2)
      [before, after] = parts.map((part) => part.replace(/^\r?\n|\r?\n$/g, ""));
  }
  if (before === undefined || after === undefined) {
    return {
      ok: false,
      error: "Give two texts as before and after, or one text with a line of --- between them.",
    };
  }
  const ignoreSpace = Boolean(input?.ignoreWhitespace);
  const norm = (s) => (ignoreSpace ? s.replace(/\s+/g, " ").trim() : s);
  const a = String(before).replace(/\r\n/g, "\n").split("\n");
  const b = String(after).replace(/\r\n/g, "\n").split("\n");
  if (a.length * b.length > 4_000_000)
    return {
      ok: false,
      error: "The texts are too long for a line diff here (over about 2000 lines each).",
    };
  const table = lcs(a.map(norm), b.map(norm));
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (norm(a[i]) === norm(b[j])) {
      ops.push([" ", b[j], i + 1, j + 1]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push(["-", a[i], i + 1, null]);
      i += 1;
    } else {
      ops.push(["+", b[j], null, j + 1]);
      j += 1;
    }
  }
  while (i < a.length) ops.push(["-", a[i], (i += 1), null]);
  while (j < b.length) ops.push(["+", b[j], null, (j += 1)]);
  const added = ops.filter((o) => o[0] === "+").length;
  const removed = ops.filter((o) => o[0] === "-").length;
  const same = ops.length - added - removed;
  const context = Math.max(0, Number(input?.context ?? 2));
  const keep = new Set();
  ops.forEach((o, k) => {
    if (o[0] !== " ") for (let d = -context; d <= context; d += 1) keep.add(k + d);
  });
  const lines = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (!keep.has(k)) {
      skipped = true;
      return;
    }
    if (skipped && lines.length) lines.push("…");
    skipped = false;
    lines.push(`${o[0]} ${o[1]}`);
  });
  return {
    ok: true,
    identical: added === 0 && removed === 0,
    added,
    removed,
    unchanged: same,
    similarity: ops.length ? Math.round((same / Math.max(a.length, b.length)) * 100) : 100,
    answer:
      added === 0 && removed === 0
        ? "The two texts are identical."
        : `${added} line(s) added, ${removed} removed, ${same} unchanged.`,
    diff: lines.join("\n"),
    note: ignoreSpace ? "Whitespace differences were ignored." : undefined,
  };
}

export default run;
