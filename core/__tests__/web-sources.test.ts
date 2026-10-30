/** Sources are weighed by kind of site, and a citation must say something its source says. */
import { describe, expect, it } from "vitest";
import {
  checkCitations,
  classifyUrl,
  corroboration,
  hostOf,
  sourceScore,
} from "../../src/lib/friday/brain/web-sources";
import { rankSources, researchNote } from "../../src/lib/friday/brain/research";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";

describe("classifyUrl", () => {
  it("sorts sites by kind with a stated reason", () => {
    expect(classifyUrl("https://www.nic.in/x")).toMatchObject({ kind: "official" });
    expect(classifyUrl("https://data.example.gov/report")).toMatchObject({ kind: "official" });
    expect(classifyUrl("https://iitb.ac.in/p")).toMatchObject({ kind: "official" });
    expect(classifyUrl("https://learn.microsoft.com/en-us/x")).toMatchObject({ kind: "official" });
    expect(classifyUrl("https://arxiv.org/abs/2406.04692")).toMatchObject({ kind: "research" });
    expect(classifyUrl("https://en.wikipedia.org/wiki/X")).toMatchObject({ kind: "reference" });
    expect(classifyUrl("https://github.com/o/r")).toMatchObject({ kind: "code-host" });
    expect(classifyUrl("https://www.reuters.com/a")).toMatchObject({ kind: "news" });
    expect(classifyUrl("https://stackoverflow.com/q/1")).toMatchObject({ kind: "community" });
    expect(classifyUrl("https://x.com/u/status/1")).toMatchObject({ kind: "social" });
    expect(classifyUrl("https://random-site.example/a")).toMatchObject({ kind: "unknown" });
    expect(classifyUrl("not a link")).toMatchObject({ kind: "unknown", trust: 0.2 });
  });

  it("trusts an official page above a forum post above a social post, and docks plain http", () => {
    const official = classifyUrl("https://docs.python.org/3/").trust;
    const forum = classifyUrl("https://reddit.com/r/x").trust;
    const social = classifyUrl("https://x.com/a").trust;
    expect(official).toBeGreaterThan(forum);
    expect(forum).toBeGreaterThan(social);
    expect(classifyUrl("http://data.example.gov/a").trust).toBeLessThan(
      classifyUrl("https://data.example.gov/a").trust,
    );
    expect(hostOf("https://www.Example.com/a")).toBe("example.com");
  });
});

describe("corroboration and scores", () => {
  const hits = [
    {
      title: "Price",
      url: "https://a.example/p",
      snippet: "The tool costs 49 dollars and has 12 plugins today in the market.",
    },
    {
      title: "Review",
      url: "https://b.example/r",
      snippet: "Costs 49 dollars per seat with 12 plugins, reviewers say, in the market.",
    },
    { title: "Own page", url: "https://a.example/q", snippet: "Costs 49 dollars, 12 plugins." },
    {
      title: "Other",
      url: "https://c.example/z",
      snippet: "Weather today is sunny with 31 degrees and a light wind from the sea.",
    },
  ];

  it("counts other sites that carry the same figures, never the same host", () => {
    expect(corroboration(hits)).toEqual([1, 1, 1, 0]);
  });

  it("scores an official page above a forum page with the same snippet", () => {
    const snippet =
      "A long enough snippet that explains the answer in plenty of detail for the reader to use here.";
    expect(sourceScore({ title: "t", url: "https://docs.python.org/3/", snippet })).toBeGreaterThan(
      sourceScore({ title: "t", url: "https://reddit.com/r/x", snippet }),
    );
  });

  it("feeds the ranking and the note the model reads", () => {
    const ranked = rankSources(hits.map((hit) => ({ ...hit, snippet: hit.snippet ?? "" })));
    expect(ranked[0]?.corroboratedBy).toBe(1);
    expect(ranked[0]?.kind).toBe("unknown");
    expect(researchNote(ranked)).toContain("other site(s) carry the same figures");
  });
});

describe("checkCitations", () => {
  const sources = [
    {
      title: "Python 3.13 release notes",
      url: "https://docs.python.org/3/whatsnew/3.13.html",
      snippet:
        "Python 3.13 adds an experimental free-threaded build and a new interactive interpreter with colour support.",
    },
  ];

  it("passes a sentence that matches its source", () => {
    const answer =
      "Python 3.13 adds an experimental free-threaded build https://docs.python.org/3/whatsnew/3.13.html";
    expect(checkCitations(answer, sources)).toEqual([]);
  });

  it("flags a sentence the source does not support", () => {
    const answer =
      "Python 3.13 removed the global statement entirely and banned recursion https://docs.python.org/3/whatsnew/3.13.html";
    const problems = checkCitations(answer, sources);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain("does not mention");
  });

  it("flags a link that was never retrieved, and ignores a bare link or no link", () => {
    expect(
      checkCitations(
        "Prices dropped sharply this quarter across the whole market https://invented.example/a",
        sources,
      )[0]?.reason,
    ).toContain("not retrieved");
    expect(checkCitations("See https://docs.python.org/3/whatsnew/3.13.html", sources)).toEqual([]);
    expect(checkCitations("No link in this sentence about anything at all.", sources)).toEqual([]);
  });

  it("is part of the verification of a turn that retrieved sources", async () => {
    const cognition = await coreBrain.cognize("explain closures", {
      mode: "manual",
      allowTools: false,
    });
    const withSources = { ...cognition, sources };
    const bad = coreBrain.verify(
      withSources,
      "Python 3.13 removed the global statement entirely and banned recursion https://docs.python.org/3/whatsnew/3.13.html",
      true,
    );
    expect(bad.ok).toBe(false);
    expect(bad.issues.join(" ")).toContain("a citation does not hold");
  });
});
