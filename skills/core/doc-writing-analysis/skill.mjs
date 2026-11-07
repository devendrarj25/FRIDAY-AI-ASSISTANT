// FRIDAY · skill: doc-writing-analysis
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Readability, keywords, summary, meeting actions and SEO check. Analyses what you wrote or received, without sending it anywhere.
// It holds 5 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "seo-onpage",
    gate: /\bseo\b|meta description|title tag|page title|keyword density|on-?page/,
    run: (() => {
      // On-page SEO: title and description length, keyword placement, headings, images without alt text, word count.
      const strip = (h) =>
        h
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ");

      async function run(input = {}) {
        const raw = String(input.html ?? input.text ?? input?.prompt ?? "");
        let title = input.title ?? null;
        let description = input.description ?? null;
        let keyword = input.keyword ?? null;
        let body = input.body ?? null;
        let h1 = 0;
        let imgs = 0;
        let noAlt = 0;
        let links = 0;
        if (/<\w+[^>]*>/.test(raw)) {
          title ??= /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? null;
          description ??=
            /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(raw)?.[1] ??
            null;
          h1 = (raw.match(/<h1[\s>]/gi) ?? []).length;
          const tags = raw.match(/<img\b[^>]*>/gi) ?? [];
          imgs = tags.length;
          noAlt = tags.filter((t) => !/\balt=["'][^"']+["']/i.test(t)).length;
          links = (raw.match(/<a\s[^>]*href=/gi) ?? []).length;
          body ??= strip(raw);
        } else {
          const kv = (k) =>
            new RegExp(
              `(?:^|\\n|\\s)${k}\\s*[:=]\\s*(.+?)(?=\\s+(?:title|(?:meta )?description|(?:focus )?keyword|body)\\s*[:=]|\\n|$)`,
              "i",
            )
              .exec(raw)?.[1]
              ?.trim() ?? null;
          title ??= kv("title");
          description ??= kv("(?:meta )?description");
          keyword ??= kv("(?:focus )?keyword");
          body ??= /(?:^|\n)\s*body\s*[:=]\s*([\s\S]+)/i.exec(raw)?.[1] ?? null;
          h1 = (raw.match(/^#\s+\S/gm) ?? []).length;
          imgs = (raw.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
          noAlt = (raw.match(/!\[\s*\]\([^)]*\)/g) ?? []).length;
          links = (raw.match(/(?<!!)\[[^\]]+\]\([^)]*\)/g) ?? []).length;
        }
        if (!title && !description && !body) {
          return {
            ok: false,
            error: "Give title:, description:, keyword: and body: lines, or the page HTML.",
          };
        }
        const issues = [];
        const good = [];
        const check = (cond, bad, ok) => (cond ? good.push(ok) : issues.push(bad));
        const kw = keyword ? String(keyword).toLowerCase() : null;
        if (title) {
          check(
            title.length >= 30 && title.length <= 60,
            `Title is ${title.length} characters; 30-60 shows fully in search results.`,
            "Title length is good.",
          );
          if (kw)
            check(
              title.toLowerCase().includes(kw),
              "Keyword is missing from the title.",
              "Keyword is in the title.",
            );
        } else issues.push("No title found.");
        if (description) {
          check(
            description.length >= 70 && description.length <= 160,
            `Description is ${description.length} characters; 70-160 is the safe range.`,
            "Description length is good.",
          );
          if (kw)
            check(
              description.toLowerCase().includes(kw),
              "Keyword is missing from the description.",
              "Keyword is in the description.",
            );
        } else issues.push("No meta description found.");
        const words = body ? (String(body).match(/[\p{L}\p{N}']+/gu) ?? []) : [];
        let density = null;
        if (words.length) {
          check(
            words.length >= 300,
            `Only ${words.length} words; pages under 300 rarely rank for competitive terms.`,
            "Enough content.",
          );
          if (kw) {
            const first = words.slice(0, 100).join(" ").toLowerCase();
            check(
              first.includes(kw),
              "Keyword is not in the first 100 words.",
              "Keyword appears early.",
            );
            const hits = String(body).toLowerCase().split(kw).length - 1;
            density = Math.round((hits * kw.split(/\s+/).length * 1000) / words.length) / 10;
            check(
              density <= 3,
              `Keyword density ${density}% looks stuffed; keep it under 3%.`,
              `Keyword density ${density}% is natural.`,
            );
          }
        }
        if (h1 !== 1 && (/<\w+[^>]*>/.test(raw) || words.length))
          issues.push(`Found ${h1} H1 headings; use exactly one.`);
        else if (h1 === 1) good.push("One H1 heading.");
        if (noAlt) issues.push(`${noAlt} of ${imgs} image(s) have no alt text.`);
        const score = Math.round((good.length / Math.max(1, good.length + issues.length)) * 100);
        return {
          ok: true,
          score,
          issues,
          passed: good,
          words: words.length,
          keywordDensityPercent: density,
          links,
          images: imgs,
          answer: `On-page score ${score}/100. ${issues.length ? "Fix: " + issues.join(" ") : "No problems found."}`,
        };
      }

      return run;
    })(),
  },
  {
    id: "meeting-actions",
    gate: /meeting|minutes|action items?|transcript|follow.?ups?|decisions?/,
    run: (() => {
      // Meeting notes: action items with owner and due date, decisions, questions and dates.
      const DAY = "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*";
      const DUE = new RegExp(
        `\\b(?:by|before|on|due|till|until)\\s+((?:next\\s+|this\\s+)?${DAY}|tomorrow|today|eod|end of (?:day|week|month)|\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+[a-z]{3,9})`,
        "i",
      );

      async function run(input = {}) {
        let text = input.text != null ? String(input.text) : String(input?.prompt ?? "");
        const m = /^([^:\n]{0,70}):\s*([\s\S]+)$/.exec(text);
        if (
          input.text == null &&
          m &&
          /meeting|minutes|action|transcript|follow|decision|notes/i.test(m[1])
        )
          text = m[2];
        const lines = text
          .split(/\r?\n|(?<=[.!?])\s+/)
          .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
          .filter((l) => l.length > 5);
        if (lines.length < 2)
          return { ok: false, error: "Paste the meeting notes or transcript (a few lines)." };
        const actions = [];
        const decisions = [];
        const questions = [];
        for (const line of lines) {
          if (
            /\b(decided|decision|agreed|approved|finali[sz]ed|resolved|confirmed|go ahead)\b/i.test(
              line,
            )
          ) {
            decisions.push(line);
            continue;
          }
          const isAction =
            /^(?:action|todo|to-do|task|follow[- ]?up|ai)\b[:\s-]/i.test(line) ||
            /\b(will|needs? to|has to|have to|should|must|to send|to share|to prepare|please|assigned|owner)\b/i.test(
              line,
            );
          if (isAction) {
            const owner = /^(?:action|todo|task)[:\s-]*/i.test(line)
              ? (/@(\w+)/.exec(line)?.[1] ?? null)
              : (/^([A-Z][a-z]+)\s+(?:will|to|needs?|has|should|must)\b/.exec(line)?.[1] ??
                /@(\w+)/.exec(line)?.[1] ??
                null);
            const due = DUE.exec(line)?.[1] ?? null;
            actions.push({
              text: line.replace(/^(?:action|todo|to-do|task|follow[- ]?up)[:\s-]*/i, ""),
              owner,
              due,
            });
          } else if (/\?$/.test(line)) questions.push(line);
        }
        if (!actions.length && !decisions.length && !questions.length) {
          return { ok: false, error: "No action items, decisions or questions found." };
        }
        return {
          ok: true,
          actions,
          decisions,
          openQuestions: questions,
          answer: `${actions.length} action item(s), ${decisions.length} decision(s), ${questions.length} open question(s).${actions.map((a) => `\n- ${a.owner ? a.owner + ": " : ""}${a.text}${a.due ? ` (by ${a.due})` : ""}`).join("")}`,
        };
      }

      return run;
    })(),
  },
  {
    id: "readability",
    gate: /readab|reading level|grade level|flesch|easy to read|how hard|how difficult/,
    run: (() => {
      // Readability: Flesch reading ease, Flesch-Kincaid grade, long sentences.
      const syllables = (word) => {
        let w = word.toLowerCase().replace(/[^a-z]/g, "");
        if (!w) return 0;
        if (w.length <= 3) return 1;
        w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
        const groups = w.match(/[aeiouy]{1,2}/g);
        return Math.max(1, groups ? groups.length : 1);
      };

      async function run(input = {}) {
        let text = input.text != null ? String(input.text) : String(input?.prompt ?? "");
        const m = /^([^:\n]{0,60}):\s*([\s\S]+)$/.exec(text);
        if (input.text == null && m && /readab|reading level|grade|flesch|easy|hard/i.test(m[1]))
          text = m[2];
        const words = text.match(/[A-Za-z']+/g) ?? [];
        if (words.length < 5)
          return { ok: false, error: "Give at least a few sentences of English text." };
        const parts = text.split(/(?<=[.!?])\s+/).filter((s) => /[A-Za-z]/.test(s));
        const sentences = Math.max(1, parts.length);
        const syl = words.reduce((a, w) => a + syllables(w), 0);
        const wps = words.length / sentences;
        const spw = syl / words.length;
        const ease = 206.835 - 1.015 * wps - 84.6 * spw;
        const grade = 0.39 * wps + 11.8 * spw - 15.59;
        const band =
          ease >= 90
            ? "very easy, about grade 5"
            : ease >= 80
              ? "easy"
              : ease >= 70
                ? "fairly easy"
                : ease >= 60
                  ? "plain English, grade 8-9"
                  : ease >= 50
                    ? "fairly difficult"
                    : ease >= 30
                      ? "difficult, college level"
                      : "very difficult";
        const long = parts
          .map((s) => ({
            words: (s.match(/[A-Za-z']+/g) ?? []).length,
            text: s.trim().slice(0, 120),
          }))
          .filter((s) => s.words > 25)
          .sort((a, b) => b.words - a.words)
          .slice(0, 3);
        const r1 = (n) => Math.round(n * 10) / 10;
        return {
          ok: true,
          words: words.length,
          sentences,
          averageWordsPerSentence: r1(wps),
          averageSyllablesPerWord: Math.round(spw * 100) / 100,
          fleschReadingEase: r1(ease),
          fleschKincaidGrade: r1(grade),
          level: band,
          longSentences: long,
          answer: `Reading ease ${r1(ease)} (${band}), grade level ${r1(grade)}; ${words.length} words, ${sentences} sentence(s), ${r1(wps)} words per sentence.${long.length ? ` ${long.length} sentence(s) run past 25 words: split them.` : ""}`,
        };
      }

      return run;
    })(),
  },
  {
    id: "summary",
    gate: /summar|tl;?dr|shorten|gist|in short|brief|sankshep/,
    run: (() => {
      // Summary: picks the sentences that carry the text's most repeated ideas (extractive, never invents a word).
      const STOP = new Set(
        "the a an and or but of to in on at for with by is are was were be been it this that these those as from i you he she we they my your his her our their not no so if then than also have has had will would can could should may might do does did into about over after before more most very just only such there here what which who whom when where why how all any each other some".split(
          " ",
        ),
      );

      async function run(input = {}) {
        let text = input.text != null ? String(input.text) : String(input?.prompt ?? "");
        const m = /^([^:\n]{0,60}):\s*([\s\S]+)$/.exec(text);
        if (input.text == null && m && /summar|tl;?dr|shorten|gist|in short|brief/i.test(m[1]))
          text = m[2];
        const sentences = text
          .replace(/\s+/g, " ")
          .split(/(?<=[.!?।])\s+/)
          .map((s) => s.trim())
          .filter((s) => (s.match(/[\p{L}]+/gu) ?? []).length >= 4);
        if (sentences.length < 4)
          return { ok: false, error: "Give a text of at least four sentences to summarise." };
        const freq = new Map();
        for (const s of sentences) {
          for (const w of s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
            if (w.length > 2 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
          }
        }
        const scored = sentences.map((s, i) => {
          const ws = (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
            (w) => w.length > 2 && !STOP.has(w),
          );
          const score =
            ws.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / Math.sqrt(Math.max(ws.length, 1));
          return { i, s, score: score + (i === 0 ? 0.5 : 0) };
        });
        const want = Math.min(
          sentences.length - 1,
          Math.max(1, Number(input.sentences) || Math.round(sentences.length * 0.3)),
        );
        const picked = [...scored]
          .sort((a, b) => b.score - a.score)
          .slice(0, want)
          .sort((a, b) => a.i - b.i);
        const summary = picked.map((p) => p.s).join(" ");
        return {
          ok: true,
          sentences: sentences.length,
          kept: picked.length,
          summary,
          answer: summary,
        };
      }

      return run;
    })(),
  },
  {
    id: "keywords",
    gate: /keyword|key words|key terms|topics|tags|hashtag|main words/,
    run: (() => {
      // Keywords: the words and two-word phrases a text keeps coming back to.
      const STOP = new Set(
        "the a an and or but of to in on at for with by is are was were be been it this that these those as from i you he she we they my your his her our their not no so if then than also have has had will would can could should may might do does did into about over after before more most very just only such there here what which who whom when where why how all any each other some hai hain tha thi ka ki ke ko se me mein par aur to ye yeh wo woh kya nahi bhi hi".split(
          " ",
        ),
      );

      async function run(input = {}) {
        let text = input.text != null ? String(input.text) : String(input?.prompt ?? "");
        const m = /^([^:\n]{0,60}):\s*([\s\S]+)$/.exec(text);
        if (
          input.text == null &&
          m &&
          /keyword|key words|key terms|topics|tags|hashtag|main words/i.test(m[1])
        )
          text = m[2];
        const words = (text.toLowerCase().match(/[\p{L}\p{M}\p{N}'’]+/gu) ?? []).filter(
          (w) => w.length >= 3,
        );
        if (words.length < 8) return { ok: false, error: "Give a longer text (at least 8 words)." };
        const single = new Map();
        for (const w of words)
          if (!STOP.has(w) && !/^\d+$/.test(w)) single.set(w, (single.get(w) ?? 0) + 1);
        const pairs = new Map();
        for (let i = 0; i + 1 < words.length; i++) {
          const a = words[i];
          const b = words[i + 1];
          if (STOP.has(a) || STOP.has(b)) continue;
          pairs.set(`${a} ${b}`, (pairs.get(`${a} ${b}`) ?? 0) + 1);
        }
        const top = (map, n, min) =>
          [...map.entries()]
            .filter(([, c]) => c >= min)
            .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
            .slice(0, n)
            .map(([word, count]) => ({ word, count }));
        const keywords = top(single, Number(input.limit) || 8, 1);
        const phrases = top(pairs, 5, 2);
        if (!keywords.length) return { ok: false, error: "No meaningful words found." };
        return {
          ok: true,
          keywords,
          phrases,
          hashtags: keywords.slice(0, 5).map((k) => "#" + k.word.replace(/[^\p{L}\p{N}]/gu, "")),
          answer: `Top words: ${keywords.map((k) => `${k.word} (${k.count})`).join(", ")}.${phrases.length ? ` Repeated phrases: ${phrases.map((p) => p.word).join(", ")}.` : ""}`,
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
