// FRIDAY · skill: doc-text-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Clean lists, count words, change naming case, build a Markdown contents list. Everyday text jobs in one skill.
// It holds 4 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "doc-text-clean",
    gate: /clean|dedup|duplicate|sort|unique|bullet|number|join|quote|trim|lines/,
    run: (() => {
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
        if (has(/\bsort\b.*\b(desc|descending|z to a|reverse)\b|\bz to a\b/))
          ops.push("sort-lines-desc");
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
        return ops.length
          ? ops
          : ["trim", "collapse-spaces", "remove-blank-lines", "straighten-quotes"];
      }

      /** The text to clean: the block after the first line that holds the instruction, or the text field. */
      function body(input) {
        if (input?.text !== undefined && input?.text !== null) return String(input.text);
        const prompt = String(input?.prompt ?? "");
        const at = prompt.indexOf("\n");
        return at >= 0 ? prompt.slice(at + 1) : "";
      }

      async function run(input = {}) {
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
          else if (op === "collapse-spaces")
            lines = lines.map((l) => l.replace(/[ \t\u00a0]{2,}/g, " "));
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

      return run;
    })(),
  },
  {
    id: "doc-word-stats",
    gate: /word|count|character|sentence|paragraph|reading time|read time|speaking/,
    run: (() => {
      // FRIDAY · skill: doc-word-stats
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Count the words, characters, sentences and paragraphs of a text, estimate reading time, list the common words.

      const STOP = new Set(
        (
          "the a an and or but of to in on at for with by is are was were be been it this that these those as from " +
          "i you he she we they my your his her our their not no so if then than also hai hain tha thi the ka ki ke ko se me mein " +
          "par aur to ye yeh wo woh kya nahi bhi hi"
        ).split(" "),
      );

      async function run(input = {}) {
        let text = input.text != null ? String(input.text) : String(input?.prompt ?? "");
        if (input.text == null) {
          const m = /^([^:\n]{0,60}):\s*([\s\S]+)$/.exec(text);
          if (m && /word|count|stat|read|character|sentence|analy[sz]e|length/i.test(m[1]))
            text = m[2];
        }
        const words = text.match(/[\p{L}\p{M}\p{N}'’]+/gu) ?? [];
        if (!words.length) return { ok: false, error: "Give some text to measure." };
        const sentences = text
          .split(/[.!?।]+(?:\s|$)/)
          .filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
        const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
        const freq = new Map();
        for (const w of words) {
          const k = w.toLowerCase();
          if (k.length < 3 || STOP.has(k) || /^\d+$/.test(k)) continue;
          freq.set(k, (freq.get(k) ?? 0) + 1);
        }
        const common = [...freq.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([word, count]) => ({ word, count }));
        const readSeconds = Math.round((words.length / 200) * 60);
        const speakSeconds = Math.round((words.length / 130) * 60);
        const mmss = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;
        return {
          ok: true,
          words: words.length,
          characters: [...text].length,
          charactersNoSpaces: [...text.replace(/\s/g, "")].length,
          sentences,
          paragraphs,
          averageWordLength: Math.round((words.join("").length / words.length) * 10) / 10,
          readingTime: mmss(readSeconds),
          speakingTime: mmss(speakSeconds),
          commonWords: common,
          answer: `${words.length} words, ${[...text].length} characters, ${sentences} sentence(s), ${paragraphs} paragraph(s); about ${mmss(readSeconds)} to read, ${mmss(speakSeconds)} to say aloud.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "doc-case-convert",
    gate: /case|slug|camel|snake|kebab|pascal|title|upper|lower|capitali|rename/,
    run: (() => {
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

      async function run(input = {}) {
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
          return {
            ok: false,
            error: "Give a phrase, e.g. convert 'user profile page' to snake case.",
          };
        const all = {};
        for (const style of STYLES) all[style] = MAKE[style](words);
        return {
          ok: true,
          source,
          target,
          result: target ? all[target] : null,
          all,
          answer: target
            ? `${target}: ${all[target]}`
            : STYLES.map((s) => `${s}: ${all[s]}`).join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "doc-markdown-toc",
    gate: /table of contents|\btoc\b|contents|heading|markdown/,
    run: (() => {
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

      async function run(input = {}) {
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
