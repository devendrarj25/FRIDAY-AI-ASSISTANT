/**
 * The twenty skills added to FRIDAY's own set in the second batch: behaviour with fixed vectors, the "not for this
 * request" answers that let agents skip them, and that the router reaches each one from a natural request.
 * Vectors: RFC 9562 appendix test values for UUIDs, and arithmetic that can be checked by hand.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chooseSkills } from "../../src/lib/friday/brain/skill-router";
import type { SkillManifest } from "../../src/lib/friday/brain/skill-forge";
import { MERGED } from "./helpers/core-skills-map";

const CORE = path.resolve(__dirname, "../../skills/core");
type Out = any; // eslint-disable-line @typescript-eslint/no-explicit-any
async function skill(id: string, input: Record<string, unknown>): Promise<Out> {
  const target = MERGED[id] ?? id;
  const mod = await import(
    /* @vite-ignore */ pathToFileURL(path.join(CORE, target, "skill.mjs")).href
  );
  return mod.run(MERGED[id] ? { ...input, part: id } : input);
}

describe("India desk additions", () => {
  it("fixed deposit: yearly and simple interest are exact, quarterly is the default", async () => {
    expect(
      await skill("in-fd-compound", { prompt: "1 lakh at 10% for 2 years yearly" }),
    ).toMatchObject({
      ok: true,
      maturityAmount: 121000,
      interestEarned: 21000,
    });
    expect(
      await skill("in-fd-compound", { prompt: "1 lakh at 10% for 2 years simple interest" }),
    ).toMatchObject({
      maturityAmount: 120000,
    });
    const q = await skill("in-fd-compound", { prompt: "fd of 50,000 at 7.1% for 18 months" });
    expect(q.compounding).toBe("compounded quarterly");
    expect(q.maturityAmount).toBeCloseTo(50000 * Math.pow(1 + 0.071 / 4, 6), 1);
    expect((await skill("in-fd-compound", { prompt: "hello" })).ok).toBe(false);
  });

  it("the word 'years' is not read as the rupee marker 'rs'", async () => {
    expect((await skill("in-fd-compound", { prompt: "2 lakh at 8% for 3 years" })).principal).toBe(
      200000,
    );
    expect((await skill("in-percent-calc", { prompt: "15% of 2400 in 3 years" })).ok).toBe(true);
  });

  it("bill splitter: tip and GST, and the extra paisa is shared out", async () => {
    expect(
      await skill("in-split-bill", { prompt: "split 2400 among 4 people with 10% tip" }),
    ).toMatchObject({
      grandTotal: 2640,
      perPerson: 660,
      extraPaisaPayers: 0,
    });
    const odd = await skill("in-split-bill", { prompt: "bill 1000 between 3 friends, 5% gst" });
    expect(odd).toMatchObject({ taxAmount: 50, grandTotal: 1050, perPerson: 350 });
    const thirds = await skill("in-split-bill", { total: 100, people: 3 });
    expect(thirds.perPerson).toBe(33.33);
    expect(thirds.extraPaisaPayers).toBe(1);
    expect((await skill("in-split-bill", { prompt: "split the bill" })).ok).toBe(false);
  });
});

describe("Dev helper additions", () => {
  it("UUID inspector reads the RFC 9562 test values", async () => {
    const r = await skill("dev-uuid-inspect", {
      prompt:
        "017F22E2-79B0-7CC3-98C4-DC0C0C07398F C232AB00-9414-11EC-B3C8-9F6BDECED846 1EC9414C-232A-6B00-B3C8-9F6BDECED846 " +
        "550e8400-e29b-41d4-a716-446655440000 00000000-0000-0000-0000-000000000000",
    });
    const by = Object.fromEntries(r.items.map((i: Out) => [i.version, i]));
    expect(by[7].createdAt).toBe("2022-02-22T19:22:22.000Z");
    expect(by[1].createdAt).toBe("2022-02-22T19:22:22.000Z");
    expect(by[6].createdAt).toBe("2022-02-22T19:22:22.000Z");
    expect(by[4]).toMatchObject({ kind: "random", createdAt: null });
    expect(by[0].kind).toBe("nil UUID");
    expect((await skill("dev-uuid-inspect", { prompt: "no id here" })).ok).toBe(false);
  });

  it("number base converter", async () => {
    expect(await skill("dev-base-convert", { prompt: "255 to binary" })).toMatchObject({
      binary: "11111111",
      hex: "ff",
      octal: "377",
    });
    expect((await skill("dev-base-convert", { prompt: "1010 binary to decimal" })).decimal).toBe(
      "10",
    );
    expect((await skill("dev-base-convert", { prompt: "0xFF to decimal" })).decimal).toBe("255");
    expect((await skill("dev-base-convert", { prompt: "what is 65 in hex" })).character).toBe("A");
    expect((await skill("dev-base-convert", { prompt: "18446744073709551616 to hex" })).hex).toBe(
      "10000000000000000",
    );
    expect((await skill("dev-base-convert", { prompt: "hello" })).ok).toBe(false);
  });

  it("JSON path query reads a value, explains a miss, and describes a shape", async () => {
    const doc = '{"user":{"items":[{"name":"a"},{"name":"b"}]}}';
    expect(
      await skill("dev-json-query", { prompt: `get user.items[1].name from ${doc}` }),
    ).toMatchObject({
      ok: true,
      value: "b",
    });
    const miss = await skill("dev-json-query", { prompt: `get user.zip from ${doc}` });
    expect(miss.ok).toBe(false);
    expect(miss.error).toMatch(/available here: items/);
    expect(await skill("dev-json-query", { json: { a: 1, b: [1, 2] } })).toMatchObject({
      type: "object",
      keyCount: 2,
    });
    expect((await skill("dev-json-query", { json: "{oops", path: "a" })).ok).toBe(false);
  });

  it("env file audit never repeats a value", async () => {
    const secret = "S3cr3t-value-0001";
    const r = await skill("dev-env-audit", {
      text: `A=1\nA=2\nAPI_KEY=${secret}\nEMPTY=\nTOKEN=changeme\nbad line\nQ="open`,
    });
    const rules = r.issues.map((i: Out) => i.rule);
    expect(rules).toEqual(
      expect.arrayContaining(["duplicate", "empty", "placeholder", "no-equals", "unclosed-quote"]),
    );
    expect(r.secretLooking).toEqual([{ line: 3, key: "API_KEY", length: secret.length }]);
    expect(r.safeToCommit).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect((await skill("dev-env-audit", { text: "just words" })).ok).toBe(false);
  });

  it("commit lint accepts the project form and flags attribution trailers", async () => {
    expect(
      (
        await skill("dev-commit-lint", {
          prompt: "check commit message: feat(ui): add skills page",
        })
      ).valid,
    ).toBe(true);
    const bad = await skill("dev-commit-lint", {
      message: "Fix stuff.\nbody without a blank line\nCo-authored-by: someone <a@b.co>",
    });
    expect(bad.valid).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/attribution/);
    expect(
      (await skill("dev-commit-lint", { message: "wip(ui): " + "x".repeat(80) })).problems.join(
        " ",
      ),
    ).toMatch(/72|Unknown type/);
    expect((await skill("dev-commit-lint", { message: "" })).ok).toBe(false);
  });
});

describe("System desk", () => {
  it("size converter explains the Windows 500 GB drive", async () => {
    const r = await skill("ops-size-convert", { prompt: "500 GB in GiB" });
    expect(r.table.GiB).toBeCloseTo(465.6613, 3);
    expect(r.answer).toMatch(/465/);
    expect((await skill("ops-size-convert", { prompt: "2048 KiB" })).bytes).toBe(2097152);
    expect((await skill("ops-size-convert", { prompt: "nothing" })).ok).toBe(false);
  });

  it("unit converter, including temperature and refusing mixed kinds", async () => {
    expect((await skill("ops-unit-convert", { prompt: "5 km to miles" })).result).toBeCloseTo(
      3.106856,
      5,
    );
    expect((await skill("ops-unit-convert", { prompt: "convert 100 f in c" })).result).toBeCloseTo(
      37.777778,
      5,
    );
    expect((await skill("ops-unit-convert", { prompt: "0 c to k" })).result).toBeCloseTo(273.15, 5);
    expect((await skill("ops-unit-convert", { prompt: "2000 sq ft to sqm" })).result).toBeCloseTo(
      185.80608,
      4,
    );
    const mixed = await skill("ops-unit-convert", { prompt: "5 km to kg" });
    expect(mixed).toMatchObject({ ok: false });
    expect(mixed.error).toMatch(/length to mass/);
  });

  it("port lookup by number and by name, with FRIDAY's own ports", async () => {
    const r = await skill("ops-port-lookup", { prompt: "what is port 3389 and 8765" });
    expect(r.items.map((i: Out) => i.service)).toEqual(["RDP", "FRIDAY kernel"]);
    expect(
      (await skill("ops-port-lookup", { prompt: "which port does ssh use" })).items[0].port,
    ).toBe(22);
    expect((await skill("ops-port-lookup", { prompt: "port 61234" })).ok).toBe(false);
  });

  it("IP inspector classifies IPv4 and IPv6", async () => {
    const r = await skill("ops-ip-inspect", {
      prompt:
        "192.168.1.5 8.8.8.8 127.0.0.1 100.64.0.1 169.254.1.1 ::1 fe80::1 fd00::1 2001:db8::1 2606:4700::1111",
    });
    const kinds = Object.fromEntries(r.items.map((i: Out) => [i.ip, i.kind]));
    expect(kinds).toMatchObject({
      "192.168.1.5": "private",
      "8.8.8.8": "public",
      "127.0.0.1": "loopback",
      "100.64.0.1": "shared",
      "169.254.1.1": "link-local",
      "::1": "loopback",
      "fe80::1": "link-local",
      "fd00::1": "private",
      "2001:db8::1": "documentation",
      "2606:4700::1111": "public",
    });
    expect((await skill("ops-ip-inspect", { prompt: "999.1.1.1 and 12:30:45" })).ok).toBe(false);
  });

  it("file type check catches the double extension and does not call a web domain a file", async () => {
    const r = await skill("ops-file-type", {
      prompt: "is invoice.pdf.exe safe? also notes.txt and setup.msi",
    });
    const by = Object.fromEntries(r.items.map((i: Out) => [i.name, i]));
    expect(by["invoice.pdf.exe"]).toMatchObject({ risk: "high", canRunCode: true });
    expect(by["invoice.pdf.exe"].note).toMatch(/disguise/);
    expect(by["notes.txt"]).toMatchObject({ risk: "low", canRunCode: false });
    expect(by["setup.msi"].risk).toBe("high");
    expect((await skill("ops-file-type", { prompt: "https://example.com/page" })).ok).toBe(false);
  });
});

describe("Writing desk", () => {
  it("word statistics", async () => {
    const r = await skill("doc-word-stats", {
      prompt:
        "word count of: The quick brown fox jumps. It runs fast! Does it?\n\nSecond paragraph here.",
    });
    expect(r).toMatchObject({ words: 13, sentences: 4, paragraphs: 2 });
    expect((await skill("doc-word-stats", { text: "कल सुबह आठ बजे" })).words).toBe(4);
    expect((await skill("doc-word-stats", { text: "   " })).ok).toBe(false);
  });

  it("case converter splits camelCase and folds accents for slugs", async () => {
    expect(
      (await skill("doc-case-convert", { prompt: "convert 'user profile page' to snake case" }))
        .result,
    ).toBe("user_profile_page");
    expect(
      (await skill("doc-case-convert", { prompt: "getHTTPResponse to kebab case" })).result,
    ).toBe("get-http-response");
    expect((await skill("doc-case-convert", { prompt: 'slug for "Café Déjà Vu!"' })).result).toBe(
      "cafe-deja-vu",
    );
    expect((await skill("doc-case-convert", { text: "user profile", to: "camel" })).result).toBe(
      "userProfile",
    );
  });

  it("markdown contents: GitHub anchors, repeated titles, code fences and skipped levels", async () => {
    const r = await skill("doc-markdown-toc", {
      text: "# Title\n## A\n```\n# not a heading\n```\n## A\n#### Deep",
    });
    expect(r.toc).toContain("- [Title](#title)");
    expect(r.toc).toContain("[A](#a)");
    expect(r.toc).toContain("[A](#a-1)");
    expect(r.toc).not.toContain("not a heading");
    expect(r.warnings[0]).toMatch(/Deep/);
    expect((await skill("doc-markdown-toc", { text: "no headings" })).ok).toBe(false);
  });
});

describe("Time planner and Data desk additions", () => {
  it("age calculator is exact, day-first, and handles 29 February", async () => {
    const r = await skill("cal-age-calc", {
      prompt: "age of someone born 15-08-1995 on 2026-11-07",
    });
    expect(r).toMatchObject({
      years: 31,
      months: 2,
      days: 23,
      weekdayBorn: "Tuesday",
      nextBirthday: "2027-08-15",
    });
    expect(r.daysToNextBirthday).toBe(281);
    const leap = await skill("cal-age-calc", { prompt: "born 29 Feb 2000, as of 2026-03-01" });
    expect(leap).toMatchObject({ years: 26, months: 0, days: 0, nextBirthday: "2027-02-28" });
    expect((await skill("cal-age-calc", { dob: "2030-01-01", asOf: "2026-01-01" })).ok).toBe(false);
    expect((await skill("cal-age-calc", { prompt: "hello" })).ok).toBe(false);
  });

  it("time blocks lay tasks out with breaks", async () => {
    const r = await skill("cal-time-blocks", {
      prompt: "plan 9:00: report 45m, email 20m, gym 1h",
    });
    expect(r.schedule).toEqual([
      { task: "report", start: "09:00", end: "09:45", minutes: 45 },
      { task: "email", start: "09:50", end: "10:10", minutes: 20 },
      { task: "gym", start: "10:15", end: "11:15", minutes: 60 },
    ]);
    expect(r.finish).toBe("11:15");
    const pm = await skill("cal-time-blocks", {
      prompt: "at 2pm: call 30 min, write 1.5 hours, 10 min break",
    });
    expect(pm.schedule[0]).toMatchObject({ start: "14:00", end: "14:30" });
    expect(pm.schedule[1]).toMatchObject({ start: "14:40", end: "16:10", minutes: 90 });
    expect((await skill("cal-time-blocks", { prompt: "plan my day" })).ok).toBe(false);
  });

  it("number statistics", async () => {
    const r = await skill("dat-stats", { prompt: "stats of 12, 15, 9, 22, 18, 15, 100" });
    expect(r).toMatchObject({
      count: 7,
      sum: 191,
      median: 15,
      modes: [15],
      min: 9,
      max: 100,
      outliers: [100],
    });
    expect(r.mean).toBeCloseTo(27.2857, 3);
    expect((await skill("dat-stats", { prompt: "mean of 1,50,000 2,00,000" })).mean).toBe(175000);
    expect((await skill("dat-stats", { numbers: [2, 4, 4, 4, 5, 5, 7, 9] })).populationStdDev).toBe(
      2,
    );
    expect((await skill("dat-stats", { prompt: "no numbers" })).ok).toBe(false);
  });
});

describe("Privacy guard additions", () => {
  it("password check ranks weak and strong and never repeats the password", async () => {
    const weak = await skill("saf-password-check", { prompt: "is 'Passw0rd123' strong?" });
    expect(weak.verdict).toBe("very weak");
    expect(weak.flags.join(" ")).toMatch(/most common/);
    const strong = await skill("saf-password-check", {
      password: "correct horse battery staple 7!",
    });
    expect(["strong", "very strong"]).toContain(strong.verdict);
    expect(JSON.stringify([weak, strong])).not.toMatch(/Passw0rd123|correct horse/);
    expect((await skill("saf-password-check", { password: "aaaaaaaaaaaa" })).verdict).toMatch(
      /weak/,
    );
    expect((await skill("saf-password-check", { prompt: "hello there" })).ok).toBe(false);
  });

  it("link risk spots phishing signals and leaves a normal link alone", async () => {
    const r = await skill("saf-url-risk", {
      prompt:
        "https://paypa1-login.example.tk/verify?x=1 http://user@192.168.0.1/a https://www.google.com/ https://bit.ly/x",
    });
    const by = Object.fromEntries(r.items.map((i: Out) => [i.host, i]));
    expect(by["paypa1-login.example.tk"].risk).toBe("high");
    expect(by["192.168.0.1"].risk).toBe("high");
    expect(by["www.google.com"]).toMatchObject({ risk: "low", signals: [] });
    expect(by["bit.ly"].signals.join(" ")).toMatch(/shortener/);
    expect(r.answer).toMatch(/never opens/);
    expect((await skill("saf-url-risk", { prompt: "no link" })).ok).toBe(false);
  });
});

describe("the router reaches the new skills from natural requests", () => {
  const manifest = (id: string) =>
    JSON.parse(fs.readFileSync(path.join(CORE, id, "skill.json"), "utf8")) as SkillManifest;
  const all = fs
    .readdirSync(CORE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(CORE, e.name, "skill.json")))
    .map((e) => manifest(e.name));
  const cases: [string, string][] = [
    ["calculate my age from date of birth 15-08-1995", "cal-age-calc"],
    ["fixed deposit calculator for 1 lakh at 7% for 2 years", "in-fd-compound"],
    ["split the bill among 4 people", "in-split-bill"],
    ["use the unit converter on 5 km to miles", "ops-unit-convert"],
    ["inspect this UUID 550e8400-e29b-41d4-a716-446655440000", "dev-uuid-inspect"],
    ["number base converter 255 to binary", "dev-base-convert"],
    ["json path query on this document", "dev-json-query"],
    ["run an env file audit on my dotenv", "dev-env-audit"],
    ["commit message lint for feat: add page", "dev-commit-lint"],
    ["data size converter 500 GB", "ops-size-convert"],
    ["port lookup for 3389", "ops-port-lookup"],
    ["ip address inspector 192.168.1.5", "ops-ip-inspect"],
    ["file type check on report.pdf.exe", "ops-file-type"],
    ["word count and reading time of this essay", "doc-word-stats"],
    ["naming case converter to camel case", "doc-case-convert"],
    ["markdown contents list for this README", "doc-markdown-toc"],
    ["day planner blocks for my tasks", "cal-time-blocks"],
    ["number statistics for 3 5 7", "dat-stats"],
    ["password strength check for my password", "saf-password-check"],
    ["link risk check on this url", "saf-url-risk"],
  ];
  it.each(cases)("%s -> %s", (prompt, id) => {
    const picked = chooseSkills(prompt, all, { limit: 3 }).map((s) => s.id);
    expect(picked, prompt).toContain(MERGED[id] ?? id);
  });

  it("small talk reaches none of them", () => {
    for (const p of [
      "good morning",
      "tell me a joke",
      "how are you today",
      "what is the capital of France",
    ]) {
      expect(chooseSkills(p, all, { limit: 3 }), p).toEqual([]);
    }
  });
});
