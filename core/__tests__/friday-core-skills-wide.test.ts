/**
 * The third set of built-in skills, found by looking at what agent-skill collections and desktop assistants offer
 * (writing and meeting help, health arithmetic, maths, returns and tax, command help, study, running costs, data
 * extraction, encoders) and keeping what FRIDAY can do exactly and offline. Each tool is pinned with values that
 * can be checked by hand, and the router must reach every skill from a natural request even with the whole
 * catalog switched on.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chooseSkills } from "../../src/lib/friday/brain/skill-router";
import type { SkillManifest } from "../../src/lib/friday/brain/skill-forge";
import { PART_OF } from "./helpers/core-skills-map";

const CORE = path.resolve(__dirname, "../../skills/core");
const CUSTOM = path.resolve(__dirname, "../../skills/custom");
type Out = any; // eslint-disable-line @typescript-eslint/no-explicit-any
async function tool(part: string, input: Record<string, unknown>): Promise<Out> {
  const id = PART_OF[part] ?? part;
  const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(CORE, id, "skill.mjs")).href);
  return mod.run({ ...input, part });
}
async function ask(skill: string, prompt: string): Promise<Out> {
  const mod = await import(
    /* @vite-ignore */ pathToFileURL(path.join(CORE, skill, "skill.mjs")).href
  );
  return mod.run({ prompt });
}

describe("dispatcher behaviour shared by the merged skills", () => {
  it("a request that fits several tools returns the first answer and lists the rest under also", async () => {
    const r = await ask("math-tools", "what is 5!");
    expect(r.ok).toBe(true);
    expect(r.part).toBe("calc");
    expect(r.result).toBe(120);
    expect(r.also.map((a: Out) => a.part)).toContain("combinatorics");
  });

  it("an unknown part is refused with the list, and small talk fits no tool", async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(path.join(CORE, "math-tools", "skill.mjs")).href
    );
    const bad = await mod.run({ part: "nope", prompt: "1+1" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Parts: calc/);
    for (const skill of [
      "math-tools",
      "health-calc",
      "study-tools",
      "dat-extract-tools",
      "doc-writing-analysis",
    ]) {
      expect((await ask(skill, "good morning, how are you today")).ok, skill).toBe(false);
    }
  });
});

describe("Writing analysis", () => {
  it("readability gives Flesch scores and flags long sentences", async () => {
    const easy = await tool("readability", {
      text: "The cat sat on the mat. It was a sunny day. The birds sang in the trees.",
    });
    expect(easy.fleschReadingEase).toBeGreaterThan(90);
    const long = "word ".repeat(30).trim() + ".";
    const hard = await tool("readability", {
      text: `${long} Another sentence follows here for length.`,
    });
    expect(hard.longSentences.length).toBe(1);
    expect((await tool("readability", { text: "Hi." })).ok).toBe(false);
  });

  it("keywords and summary use only the text's own words", async () => {
    const k = await tool("keywords", {
      text: "Solar panels convert sunlight. Solar energy is clean. Solar panels last decades and solar costs fall.",
    });
    expect(k.keywords[0]).toEqual({ word: "solar", count: 4 });
    expect(k.phrases[0].word).toBe("solar panels");
    const text =
      "Delhi is the capital of India. It sits on the Yamuna river. The city has many historic monuments. Tourists visit the Red Fort every year. The Red Fort was built by Shah Jahan. Delhi has a huge metro network.";
    const s = await tool("summary", { text });
    expect(s.kept).toBeLessThan(s.sentences);
    for (const sentence of s.summary.split(/(?<=\.)\s+/)) expect(text).toContain(sentence);
    expect((await tool("summary", { text: "Too short. Really." })).ok).toBe(false);
  });

  it("meeting notes give owners, due dates, decisions and open questions", async () => {
    const r = await tool("meeting-actions", {
      text: "Asha will send the budget by Friday.\nWe decided to launch in March.\nWhat about the vendor contract?\nRavi to share the deck by 2026-12-01.",
    });
    expect(r.actions).toEqual([
      { text: "Asha will send the budget by Friday.", owner: "Asha", due: "Friday" },
      { text: "Ravi to share the deck by 2026-12-01.", owner: "Ravi", due: "2026-12-01" },
    ]);
    expect(r.decisions).toEqual(["We decided to launch in March."]);
    expect(r.openQuestions).toEqual(["What about the vendor contract?"]);
  });

  it("SEO check reads fields and HTML", async () => {
    const r = await tool("seo-onpage", {
      title: "Best budget laptops India 2026 guide",
      description:
        "Compare the best budget laptops in India with prices and honest reviews for students and offices.",
      keyword: "budget laptops",
    });
    expect(r.passed).toEqual(
      expect.arrayContaining(["Title length is good.", "Keyword is in the title."]),
    );
    const html = await tool("seo-onpage", {
      html: "<title>Hi</title><h1>A</h1><h1>B</h1><img src=x.png><p>text</p>",
    });
    expect(html.issues.join(" ")).toMatch(/Title is 2 characters/);
    expect(html.issues.join(" ")).toMatch(/2 H1/);
    expect(html.issues.join(" ")).toMatch(/1 of 1 image/);
  });
});

describe("Health and fitness", () => {
  it("BMI, calories, heart-rate zones, pace and water", async () => {
    const bmi = await tool("bmi", { prompt: "bmi 70 kg 175 cm" });
    expect(bmi.bmi).toBe(22.9);
    expect(bmi.healthyRangeKg).toEqual([56.7, 76.3]);
    expect((await tool("bmi", { prompt: "bmi 154 lb 5'9" })).bmi).toBeCloseTo(22.7, 0);
    const cal = await tool("calories", { prompt: "male 30 years 75 kg 175 cm moderate" });
    expect(cal.bmr).toBe(1699); // 10*75 + 6.25*175 - 5*30 + 5
    expect(cal.maintenance).toBe(2633);
    const hr = await tool("hr-zones", { age: 35 });
    expect(hr.maxHeartRate).toBe(184); // 208 - 0.7 * 35 = 183.5
    const pace = await tool("pace-calc", { prompt: "10 km in 55:30" });
    expect(pace.pacePerKm).toBe("5:33");
    expect(pace.predictions.marathon).toBe("4:15:19");
    expect((await tool("water-intake", { weightKg: 70 })).litres).toBe(2.3);
    expect((await tool("bmi", { prompt: "bmi" })).ok).toBe(false);
  });
});

describe("Math tools", () => {
  it("the calculator is a real parser: precedence, powers, functions, degrees, and refusals", async () => {
    expect((await tool("calc", { prompt: "what is 2^10 + sqrt(144) * 3" })).result).toBe(1060);
    expect((await tool("calc", { prompt: "2^3^2" })).result).toBe(512);
    expect((await tool("calc", { prompt: "-2^2" })).result).toBe(-4);
    expect((await tool("calc", { prompt: "sin(30 degrees)" })).result).toBe(0.5);
    expect((await tool("calc", { prompt: "10 mod 3 + 5!" })).result).toBe(121);
    expect((await tool("calc", { prompt: "1/0" })).ok).toBe(false);
    expect((await tool("calc", { prompt: "15% of 2400" })).ok).toBe(false);
    expect((await tool("calc", { prompt: "process.exit(1)" })).ok).toBe(false);
  });

  it("number theory, combinatorics, equations, geometry, fractions", async () => {
    expect(await tool("number-theory", { prompt: "gcd of 12 18 24" })).toMatchObject({
      gcd: "6",
      lcm: "72",
    });
    expect((await tool("number-theory", { prompt: "is 97 prime" })).prime).toBe(true);
    expect((await tool("number-theory", { prompt: "factorize 360" })).answer).toBe(
      "360 = 2^3 x 3^2 x 5.",
    );
    expect((await tool("number-theory", { prompt: "fibonacci 50" })).value).toBe("12586269025");
    expect((await tool("combinatorics", { prompt: "10 choose 3" })).combinations).toBe("120");
    expect((await tool("combinatorics", { prompt: "10p3" })).permutations).toBe("720");
    expect(
      (await tool("combinatorics", { prompt: "arrangements of MISSISSIPPI" })).arrangements,
    ).toBe("34650");
    expect((await tool("combinatorics", { prompt: "25!" })).factorial).toBe(
      "15511210043330985984000000",
    );
    expect((await tool("equation", { prompt: "solve x^2 - 5x + 6 = 0" })).roots).toEqual([3, 2]);
    expect((await tool("equation", { prompt: "solve 2x + 3 = 11" })).x).toBe(4);
    expect(await tool("equation", { prompt: "solve 2x + 3y = 12, x - y = 1" })).toMatchObject({
      x: 3,
      y: 2,
    });
    expect((await tool("equation", { prompt: "solve x^2 + 1 = 0" })).roots).toEqual([
      "0 + 1i",
      "0 - 1i",
    ]);
    expect((await tool("geometry", { prompt: "area of circle radius 7" })).area).toBe(153.938);
    expect((await tool("geometry", { prompt: "hypotenuse 3 4" })).hypotenuse).toBe(5);
    expect((await tool("geometry", { prompt: "triangle sides 13 14 15" })).area).toBe(84);
    expect((await tool("fraction-ratio", { prompt: "simplify 18/24" })).result).toBe("3/4");
    expect((await tool("fraction-ratio", { prompt: "2/3 + 3/4" })).result).toBe("17/12");
    expect((await tool("fraction-ratio", { prompt: "0.375 as a fraction" })).result).toBe("3/8");
    expect((await tool("fraction-ratio", { prompt: "split 100 in ratio 2:3:5" })).shares).toEqual([
      20, 30, 50,
    ]);
  });
});

describe("Investment and tax", () => {
  it("returns, break-even and inflation are exact", async () => {
    const c = await tool("cagr-roi", { prompt: "CAGR from 1 lakh to 2 lakh in 5 years" });
    expect(c.cagrPercent).toBe(14.87);
    expect(c.absoluteReturnPercent).toBe(100);
    expect(await tool("break-even", { fixed: 50000, price: 200, variable: 120 })).toMatchObject({
      breakEvenUnits: 625,
      breakEvenRevenue: 125000,
    });
    expect((await tool("break-even", { fixed: 100, price: 5, variable: 9 })).ok).toBe(false);
    const inf = await tool("inflation-adjust", { amount: 100000, rate: 6, years: 10 });
    expect(inf.futureCostOfSameThing).toBe(179084.77);
  });

  it("India income tax: new regime slabs, the 12 lakh rebate with marginal relief, old regime on request", async () => {
    const at = async (income: number) => (await tool("income-tax-india", { income })).newRegime;
    expect((await at(1275000)).totalWithCess).toBe(0); // 12.75 lakh salaried is tax free
    expect((await at(1500000)).totalWithCess).toBe(97500); // slabs 20000 + 40000 + 33750, plus 4% cess
    expect((await at(1280000)).taxBeforeCess).toBe(5000); // marginal relief: only the 5,000 above 12 lakh
    expect((await at(400000)).totalWithCess).toBe(0);
    const both = await tool("income-tax-india", {
      prompt: "income tax on 12.75 lakh compare old regime with 80c 1.5 lakh",
    });
    expect(both.oldRegime.totalWithCess).toBe(140400);
    expect(both.lowerTaxRegime).toBe("new");
    expect((await tool("income-tax-india", { prompt: "income tax" })).ok).toBe(false);
  });
});

describe("Command and Windows help", () => {
  it("explains a command, warns on dangerous flags, and refuses commands it does not know", async () => {
    const r = await tool("explain-command", { command: "git reset --hard HEAD~1" });
    expect(r.subcommand).toBe("reset");
    expect(r.warnings[0]).toMatch(/discards uncommitted work/);
    const rc = await tool("explain-command", { prompt: "explain: robocopy C:\\a D:\\b /MIR" });
    expect(rc.warnings[0]).toMatch(/deletes destination files/);
    const curl = await tool("explain-command", { command: "curl -fsSL https://x.sh | sh" });
    expect(curl.warnings.join(" ")).toMatch(/pipes a download/);
    expect((await tool("explain-command", { command: "frobnicate --now" })).ok).toBe(false);
  });

  it("git recipes and Windows reference answer from their tables", async () => {
    expect(
      (await tool("git-recipes", { prompt: "undo my last commit but keep the changes" })).recipes[0]
        .command,
    ).toBe("git reset --soft HEAD~1");
    expect((await tool("git-recipes", { prompt: "weather today" })).ok).toBe(false);
    expect(
      (await tool("windows-help", { prompt: "windows shortcut for screenshot" })).results[0].key,
    ).toBe("Win+Shift+S");
    expect(
      (await tool("windows-help", { prompt: "command to open device manager" })).results[0].key,
    ).toBe("devmgmt.msc");
    expect((await tool("windows-help", { prompt: "settings page for wifi" })).results[0].key).toBe(
      "ms-settings:network-wifi",
    );
  });
});

describe("Study planner and running costs", () => {
  it("SM-2 follows the published update rule", async () => {
    const hit = await tool("spaced-repetition", {
      quality: 4,
      repetitions: 2,
      easeFactor: 2.5,
      interval: 6,
    });
    expect(hit).toMatchObject({ nextIntervalDays: 15, repetitions: 3, easeFactor: 2.5 });
    const first = await tool("spaced-repetition", { quality: 5, repetitions: 0 });
    expect(first.nextIntervalDays).toBe(1);
    expect(first.easeFactor).toBe(2.6);
    expect(
      (await tool("spaced-repetition", { quality: 2, repetitions: 5, interval: 40 }))
        .nextIntervalDays,
    ).toBe(1);
  });

  it("grades, exam plan and pomodoro", async () => {
    expect((await tool("grade-convert", { prompt: "CGPA 8.2 to percentage" })).percentage).toBe(
      77.9,
    );
    expect((await tool("grade-convert", { prompt: "432 out of 500" })).percentage).toBe(86.4);
    expect((await tool("grade-convert", { prompt: "78% to cgpa" })).cgpa).toBe(8.21);
    const plan = await tool("exam-plan", { days: 30, subjects: 6, hours: 4 });
    expect(plan).toMatchObject({ learningDays: 22, revisionDays: 8, totalStudyHours: 120 });
    const dated = await tool("exam-plan", {
      prompt: "exam on 2026-12-15, 5 subjects",
      today: "2026-11-15",
    });
    expect(dated.daysLeft).toBe(30);
    expect((await tool("pomodoro-plan", { minutes: 120 })).focusBlocks).toBe(4);
  });

  it("trip and electricity cost", async () => {
    const trip = await tool("fuel-trip", {
      km: 450,
      mileage: 15,
      price: 105,
      people: 4,
      roundTrip: true,
    });
    expect(trip).toMatchObject({ distanceKm: 900, litres: 60, fuelCost: 6300, perPerson: 1575 });
    const ac = await tool("power-cost", { prompt: "1.5 ton AC 8 hours rate 8 per unit 30 days" });
    expect(ac).toMatchObject({ kwh: 360, cost: 2880, assumedTypicalWatts: true });
    expect(
      (await tool("power-cost", { watts: 100, hoursPerDay: 10, rate: 7, days: 30 })).cost,
    ).toBe(210);
  });
});

describe("Extract and compare, encoders and numerals", () => {
  it("extracts entities and compares lists", async () => {
    const e = await tool("extract-entities", {
      text: "mail a@b.co or call +91 98765 43210 on 2026-12-01, cost Rs 5,000 see https://x.com/a #deal @asha",
    });
    expect(e.emails).toEqual(["a@b.co"]);
    expect(e.phones).toEqual(["+91 98765 43210"]);
    expect(e.dates).toEqual(["2026-12-01"]);
    expect(e.amounts).toEqual(["Rs 5,000"]);
    expect(e.links).toEqual(["https://x.com/a"]);
    expect(e.hashtags).toEqual(["#deal"]);
    const c = await tool("list-compare", {
      text: "apple\nbanana\nmango\n---\nBanana\nmango\ngrape",
    });
    expect(c).toMatchObject({
      onlyInFirst: ["apple"],
      onlyInSecond: ["grape"],
      inBoth: ["banana", "mango"],
    });
    expect((await tool("frequency", { text: "the cat the dog the end" })).top[0]).toEqual({
      item: "the",
      count: 3,
      percent: 50,
    });
    expect(
      (await tool("kv-to-json", { text: "name: Asha\nage=30\nserver.port: 8080\nactive: yes" }))
        .json,
    ).toEqual({
      name: "Asha",
      age: 30,
      server: { port: 8080 },
      active: true,
    });
  });

  it("encoders round-trip, including non-English text", async () => {
    expect((await tool("encode-text", { prompt: "encode base64: hello world" })).result).toBe(
      "aGVsbG8gd29ybGQ=",
    );
    expect((await tool("encode-text", { prompt: "decode base64: aGVsbG8gd29ybGQ=" })).result).toBe(
      "hello world",
    );
    const hindi = await tool("encode-text", { prompt: "encode base64: नमस्ते" });
    expect((await tool("encode-text", { prompt: `decode base64: ${hindi.result}` })).result).toBe(
      "नमस्ते",
    );
    expect((await tool("encode-text", { prompt: "url decode: a%20b%26c" })).result).toBe("a b&c");
    expect((await tool("encode-text", { prompt: "html encode: <b>&</b>" })).result).toBe(
      "&lt;b&gt;&amp;&lt;/b&gt;",
    );
    expect((await tool("encode-text", { prompt: "hex encode: Hi" })).result).toBe("4869");
    expect((await tool("encode-text", { prompt: "base64 decode: !!!" })).ok).toBe(false);
  });

  it("Roman numerals and number words", async () => {
    expect((await tool("roman-numeral", { prompt: "2026 to roman" })).roman).toBe("MMXXVI");
    expect((await tool("roman-numeral", { prompt: "what is XLII in roman numerals" })).number).toBe(
      42,
    );
    expect((await tool("roman-numeral", { prompt: "4000 to roman" })).ok).toBe(false);
    expect((await tool("number-words", { prompt: "1234567 in english words" })).words).toBe(
      "one million two hundred thirty-four thousand five hundred sixty-seven",
    );
    expect((await tool("number-words", { prompt: "21 in words" })).ordinal).toBe("twenty-first");
    expect(
      (
        await tool("number-words", {
          prompt: "twenty one thousand three hundred forty two to number",
        })
      ).number,
    ).toBe(21342);
  });
});

describe("the router reaches the new skills from natural requests with every skill switched on", () => {
  const read = (dir: string, id: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, id, "skill.json"), "utf8")) as SkillManifest;
  const folders = (dir: string) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "skill.json")))
      .map((e) => e.name);
  const core = folders(CORE).map((id) => read(CORE, id));
  const everyone = [...core, ...folders(CUSTOM).map((id) => read(CUSTOM, id))].map((m) => ({
    ...m,
    enabled: true,
  }));

  const cases: [string, string][] = [
    ["check the readability of this text", "doc-writing-analysis"],
    ["summarize this article", "doc-writing-analysis"],
    ["list the action items from these meeting notes", "doc-writing-analysis"],
    ["what is my bmi", "health-calc"],
    ["running pace for a marathon", "health-calc"],
    ["how many calories should i eat", "health-calc"],
    ["use the calculator", "math-tools"],
    ["is 97 a prime number", "math-tools"],
    ["solve equation x^2 - 5x + 6 = 0", "math-tools"],
    ["cagr of my investment", "fin-invest-tax"],
    ["income tax under the new regime", "fin-invest-tax"],
    ["explain this command", "dev-command-help"],
    ["windows keyboard shortcut for screenshot", "dev-command-help"],
    ["make me a spaced repetition schedule", "study-tools"],
    ["convert my cgpa", "study-tools"],
    ["road trip fuel cost", "life-calc"],
    ["electricity bill of my ac", "life-calc"],
    ["extract emails from this text", "dat-extract-tools"],
    ["compare lists", "dat-extract-tools"],
    ["url encode this", "dev-encode-tools"],
    ["write 2026 as a roman numeral", "dev-encode-tools"],
  ];
  it.each(cases)("%s -> %s", (prompt, id) => {
    expect(
      chooseSkills(prompt, everyone, { limit: 3 }).map((s) => s.id),
      prompt,
    ).toContain(id);
  });

  it("small talk reaches no skill even with all 243 on", () => {
    for (const p of [
      "good morning",
      "tell me a joke",
      "how are you today",
      "what is the capital of France",
      "play some music",
      "thank you so much",
    ]) {
      expect(chooseSkills(p, everyone, { limit: 3 }), p).toEqual([]);
    }
  });
});
