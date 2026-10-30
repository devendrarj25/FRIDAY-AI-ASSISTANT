import { describe, expect, it } from "vitest";
import {
  checkAnswer,
  checksFor,
  evaluateArithmetic,
  feedbackFor,
} from "../../src/lib/friday/brain/answer-checks";

const fails = (prompt: string, answer: string) =>
  checkAnswer(prompt, answer).failures.map((failure) => failure.id);

describe("what the ask requires", () => {
  it("finds only the requirements that were written", () => {
    expect(checksFor("tell me about whales")).toEqual([]);
    expect(checksFor("explain whales in at most 20 words, no commas, in lowercase")).toEqual([
      "max-words",
      "lowercase",
      "no-commas",
    ]);
    expect(checksFor('give exactly 3 bullet points and end with the phrase "Thank you"')).toEqual([
      "bullets",
      "ends-with",
    ]);
    expect(checksFor("what is 12 * (3 + 4)?")).toEqual(["arithmetic"]);
  });
});

describe("counting limits", () => {
  it("holds words, lines, sentences and bullets to the number asked", () => {
    expect(fails("say hi in at most 3 words", "hello there my friend")).toEqual(["max-words"]);
    expect(fails("say hi in at most 3 words", "hello there")).toEqual([]);
    expect(fails("write at least 5 words", "too short")).toEqual(["min-words"]);
    expect(fails("Answer in at most 2 short lines", "a\nb\nc")).toEqual(["max-lines"]);
    expect(fails("explain in 2 sentences", "One. Two. Three.")).toEqual(["max-sentences"]);
    expect(fails("explain in 2 sentences", "One. Two.")).toEqual([]);
    expect(fails("list in 3 bullet points", "- a\n- b")).toEqual(["bullets"]);
    expect(fails("list in 3 bullet points", "- a\n- b\n* c")).toEqual([]);
    expect(fails("answer in one word", "Yes, definitely")).toEqual(["one-word"]);
    expect(fails("answer in one word", "Yes.")).toEqual([]);
  });
});

describe("form and wording", () => {
  it("checks case, commas, phrases, start and end", () => {
    expect(fails("reply in lowercase", "Hello")).toEqual(["lowercase"]);
    expect(fails("reply in all caps", "HELLO")).toEqual([]);
    expect(fails("reply without commas", "a, b")).toEqual(["no-commas"]);
    expect(fails('include the word "budget"', "the plan is fine")).toEqual(["include-phrase"]);
    expect(fails('include the word "budget"', "The Budget is fine")).toEqual([]);
    expect(fails('do not use the word "very"', "it is very good")).toEqual(["exclude-phrase"]);
    expect(fails('end your answer with "Over and out"', "done. Over and out")).toEqual([]);
    expect(fails('end your answer with "Over and out"', "done.")).toEqual(["ends-with"]);
    expect(fails('start your reply with "Namaste"', "Hello")).toEqual(["starts-with"]);
  });

  it("checks JSON, its keys, and Hindi", () => {
    expect(fails("return the result as JSON with keys name and age", "sure: nope")).toEqual([
      "json",
    ]);
    expect(fails("return the result as JSON with keys name and age", '{"name":"A"}')).toEqual([
      "json",
    ]);
    expect(
      fails(
        "return the result as JSON with keys name and age",
        '```json\n{"name":"A","age":3}\n```',
      ),
    ).toEqual([]);
    expect(fails("explain in Hindi", "It is a tree")).toEqual(["hindi"]);
    expect(fails("explain in Hindi", "यह एक पेड़ है")).toEqual([]);
  });
});

describe("arithmetic and code", () => {
  it("evaluates without eval and rejects anything else", () => {
    expect(evaluateArithmetic("12 * (3 + 4)")).toBe(84);
    expect(evaluateArithmetic("2^3^2")).toBe(512);
    expect(evaluateArithmetic("-5 + 10 / 4")).toBe(-2.5);
    expect(evaluateArithmetic("process.exit(1)")).toBeNull();
    expect(evaluateArithmetic("1 +")).toBeNull();
    expect(evaluateArithmetic("1/0")).toBeNull();
  });

  it("checks the number the answer states", () => {
    expect(fails("what is 17 * 23?", "It is 391.")).toEqual([]);
    expect(fails("what is 17 * 23?", "It is 381.")).toEqual(["arithmetic"]);
    expect(fails("calculate 1000 * 1000", "1,000,000")).toEqual([]);
  });

  it("parses the code blocks the answer contains, without running them", () => {
    expect(fails("show it", "```json\n{ bad\n```")).toEqual(["code-syntax"]);
    expect(fails("show it", "```js\nconst a = ;\n```")).toEqual(["code-syntax"]);
    expect(fails("show it", "```js\nconst a = 1;\n```")).toEqual([]);
    const marker = "__ran__";
    (globalThis as Record<string, unknown>)[marker] = false;
    checkAnswer("show it", `\`\`\`js\n(globalThis as any).${marker} = true\n\`\`\``);
    checkAnswer("show it", `\`\`\`js\nglobalThis.${marker} = true;\n\`\`\``);
    expect((globalThis as Record<string, unknown>)[marker]).toBe(false);
  });

  it("refuses an answer that speaks as another model", () => {
    expect(fails("hello", "I am ChatGPT, a large language model trained by OpenAI.")).toContain(
      "identity",
    );
  });
});

describe("feedback", () => {
  it("is one plain sentence per failure", () => {
    const text = feedbackFor(
      checkAnswer("in at most 2 words, lowercase", "Hello There Friend").failures,
    );
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("at most 2 words");
  });
});
