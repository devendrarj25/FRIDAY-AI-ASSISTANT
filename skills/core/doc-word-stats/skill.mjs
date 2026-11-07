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

export async function run(input = {}) {
  let text = input.text != null ? String(input.text) : String(input?.prompt ?? "");
  if (input.text == null) {
    const m = /^([^:\n]{0,60}):\s*([\s\S]+)$/.exec(text);
    if (m && /word|count|stat|read|character|sentence|analy[sz]e|length/i.test(m[1])) text = m[2];
  }
  const words = text.match(/[\p{L}\p{M}\p{N}'’]+/gu) ?? [];
  if (!words.length) return { ok: false, error: "Give some text to measure." };
  const sentences = text.split(/[.!?।]+(?:\s|$)/).filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
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

export default run;
