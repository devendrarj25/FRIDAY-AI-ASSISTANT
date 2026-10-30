/**
 * FRIDAY · checks an answer can be held to
 *
 * Some things an owner asks for can be checked by counting, parsing or calculating, with no model:
 * "in at most 50 words", "exactly 3 bullet points", "as JSON with keys a and b", "in Hindi", "no
 * commas", "end with the phrase …", "what is 17 * 23". This file finds those requirements in the ask
 * and tests an answer against them. A model's own opinion of its answer is not used anywhere here.
 *
 * `checksFor` says what can be checked. `checkAnswer` runs them. Nothing is checked that was not asked.
 */

import { leaksForeignIdentity } from "./reconciler";

export type CheckFailure = { id: string; message: string };

export type CheckResult = {
  /** What was checked, so "nothing to check" is told apart from "all passed". */
  checked: string[];
  failures: CheckFailure[];
  ok: boolean;
};

type Check = {
  id: string;
  /** Runs when the ask contains the requirement; returns a failure message or null. */
  find: (prompt: string) => ((answer: string) => string | null) | null;
};

const QUOTE = `["“”'‘’]`;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const num = (value: string | undefined) => (value ? Number.parseInt(value, 10) : NaN);

/** A small, safe arithmetic evaluator (+ - * / ^ % and brackets). Never uses eval. */
export function evaluateArithmetic(expression: string): number | null {
  const source = expression.replace(/×/g, "*").replace(/÷/g, "/").replace(/\s+/g, "");
  if (!/^[0-9+\-*/().^%]+$/.test(source) || !/[0-9]/.test(source)) return null;
  let index = 0;
  const peek = () => source[index];
  const fail = (): never => {
    throw new Error("bad expression");
  };
  const primary = (): number => {
    if (peek() === "(") {
      index += 1;
      const inner = additive();
      if (peek() !== ")") fail();
      index += 1;
      return inner;
    }
    if (peek() === "-") {
      index += 1;
      return -power();
    }
    if (peek() === "+") {
      index += 1;
      return power();
    }
    const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(index));
    if (!match) return fail();
    index += match[0].length;
    return Number.parseFloat(match[0]);
  };
  const power = (): number => {
    const base = primary();
    if (peek() === "^") {
      index += 1;
      return base ** power();
    }
    return base;
  };
  const multiplicative = (): number => {
    let value = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = source[index++];
      const right = power();
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const additive = (): number => {
    let value = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const op = source[index++];
      const right = multiplicative();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = additive();
    return index === source.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function jsonIn(answer: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(answer);
  const body = (fenced?.[1] ?? answer).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    if (start < 0) return undefined;
    try {
      return JSON.parse(body.slice(start));
    } catch {
      return undefined;
    }
  }
}

const CHECKS: Check[] = [
  {
    id: "max-words",
    find: (prompt) => {
      const m = new RegExp(
        "\\b(?:in|within|under|less than|fewer than|at most|no more than|up to|max(?:imum)?(?: of)?)\\s+(\\d{1,4})\\s+(?:words?|shabd\\w*)",
        "i",
      ).exec(prompt);
      const limit = num(m?.[1]);
      if (!limit) return null;
      return (answer) =>
        words(answer).length > limit
          ? `Use at most ${limit} words; the answer had ${words(answer).length}.`
          : null;
    },
  },
  {
    id: "min-words",
    find: (prompt) => {
      const limit = num(
        /\b(?:at least|minimum(?: of)?|no fewer than)\s+(\d{1,4})\s+words?/i.exec(prompt)?.[1],
      );
      if (!limit) return null;
      return (answer) =>
        words(answer).length < limit
          ? `Use at least ${limit} words; the answer had ${words(answer).length}.`
          : null;
    },
  },
  {
    id: "one-word",
    find: (prompt) =>
      /\b(?:in|with|using)\s+(?:just\s+|only\s+)?(?:one|a single|1)\s+word\b/i.test(prompt)
        ? (answer) =>
            words(answer.replace(/[.!?"'`]/g, "")).length === 1
              ? null
              : "Answer with exactly one word and nothing else."
        : null,
  },
  {
    id: "bullets",
    find: (prompt) => {
      const m =
        /\b(exactly\s+|in\s+|with\s+|give\s+(?:me\s+)?)?(\d{1,2})\s+(?:short\s+)?(?:bullet(?:ed)?\s*points?|bullets)\b/i.exec(
          prompt,
        );
      const want = num(m?.[2]);
      if (!want) return null;
      return (answer) => {
        const count = answer
          .split(/\r?\n/)
          .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
        return count === want
          ? null
          : `Give exactly ${want} bullet points; the answer had ${count}.`;
      };
    },
  },
  {
    id: "max-lines",
    find: (prompt) => {
      const limit = num(
        /\b(?:at most|no more than|max(?:imum)?(?: of)?|in|within|up to)\s+(\d{1,2})\s+(?:short\s+)?lines?\b/i.exec(
          prompt,
        )?.[1],
      );
      if (!limit) return null;
      return (answer) => {
        const count = answer.split(/\r?\n/).filter((line) => line.trim()).length;
        return count > limit ? `Use at most ${limit} lines; the answer had ${count}.` : null;
      };
    },
  },
  {
    id: "max-sentences",
    find: (prompt) => {
      const limit = num(
        /\b(?:in|within|at most|no more than|up to)\s+(\d{1,2})\s+sentences?\b/i.exec(prompt)?.[1],
      );
      if (!limit) return null;
      return (answer) => {
        const count = (answer.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? []).filter((s) =>
          s.trim(),
        ).length;
        return count > limit ? `Use at most ${limit} sentences; the answer had ${count}.` : null;
      };
    },
  },
  {
    id: "lowercase",
    find: (prompt) =>
      /\b(?:all|entirely|fully)?\s*(?:in\s+)?lowercase\b|\bno capital letters\b/i.test(prompt)
        ? (answer) => (answer === answer.toLowerCase() ? null : "Write everything in lowercase.")
        : null,
  },
  {
    id: "uppercase",
    find: (prompt) =>
      /\b(?:all|entirely|fully)?\s*(?:in\s+)?(?:uppercase|capital letters|all caps)\b/i.test(
        prompt,
      ) && !/\bno capital letters\b/i.test(prompt)
        ? (answer) =>
            answer === answer.toUpperCase() ? null : "Write everything in capital letters."
        : null,
  },
  {
    id: "no-commas",
    find: (prompt) =>
      /\b(?:without|no)\s+(?:any\s+)?commas?\b/i.test(prompt)
        ? (answer) => (answer.includes(",") ? "Do not use any commas." : null)
        : null,
  },
  {
    id: "include-phrase",
    find: (prompt) => {
      const m = new RegExp(
        `\\b(?:include|contain|mention)\\s+(?:the\\s+)?(?:word|keyword|phrase|text)\\s+${QUOTE}([^"“”'‘’]{1,80})${QUOTE}`,
        "i",
      ).exec(prompt);
      const need = m?.[1]?.trim();
      if (!need) return null;
      return (answer) =>
        answer.toLowerCase().includes(need.toLowerCase()) ? null : `Include the phrase "${need}".`;
    },
  },
  {
    id: "exclude-phrase",
    find: (prompt) => {
      const m = new RegExp(
        `\\b(?:do not|don't|never|without)\\s+(?:use|using|include|including|mention|mentioning)\\s+(?:the\\s+)?(?:word|phrase)\\s+${QUOTE}([^"“”'‘’]{1,80})${QUOTE}`,
        "i",
      ).exec(prompt);
      const ban = m?.[1]?.trim();
      if (!ban) return null;
      return (answer) =>
        answer.toLowerCase().includes(ban.toLowerCase()) ? `Do not use the phrase "${ban}".` : null;
    },
  },
  {
    id: "ends-with",
    find: (prompt) => {
      const m = new RegExp(
        `\\bend\\s+(?:your\\s+)?(?:answer|response|reply|message)?\\s*with\\s+(?:the\\s+)?(?:exact\\s+)?(?:phrase\\s+)?${QUOTE}([^"“”'‘’]{1,120})${QUOTE}`,
        "i",
      ).exec(prompt);
      const tail = m?.[1]?.trim();
      if (!tail) return null;
      return (answer) => (answer.trim().endsWith(tail) ? null : `End with exactly "${tail}".`);
    },
  },
  {
    id: "starts-with",
    find: (prompt) => {
      const m = new RegExp(
        `\\bstart\\s+(?:your\\s+)?(?:answer|response|reply|message)?\\s*with\\s+(?:the\\s+)?(?:exact\\s+)?(?:phrase\\s+|word\\s+)?${QUOTE}([^"“”'‘’]{1,120})${QUOTE}`,
        "i",
      ).exec(prompt);
      const head = m?.[1]?.trim();
      if (!head) return null;
      return (answer) => (answer.trim().startsWith(head) ? null : `Start with exactly "${head}".`);
    },
  },
  {
    id: "json",
    find: (prompt) => {
      if (
        !/\b(?:as|in|return|output|reply with|respond with|give)\s+(?:a\s+)?(?:valid\s+)?json\b/i.test(
          prompt,
        )
      )
        return null;
      const keysText =
        /\bkeys?\s*(?:named|called|:)?\s*([A-Za-z_][\w]*(?:\s*(?:,|and|&)\s*[A-Za-z_][\w]*)*)/i.exec(
          prompt,
        )?.[1];
      const keys = keysText ? keysText.split(/\s*(?:,|and|&)\s*/i).filter(Boolean) : [];
      return (answer) => {
        const value = jsonIn(answer);
        if (value === undefined) return "Reply with valid JSON only (it did not parse).";
        if (keys.length && value && typeof value === "object" && !Array.isArray(value)) {
          const missing = keys.filter((key) => !(key in (value as Record<string, unknown>)));
          if (missing.length) return `The JSON is missing the keys: ${missing.join(", ")}.`;
        }
        return null;
      };
    },
  },
  {
    id: "hindi",
    find: (prompt) =>
      /\bin\s+hindi\b|हिंदी\s+में|हिन्दी\s+में/i.test(prompt)
        ? (answer) => {
            const letters = answer.match(/\p{L}/gu) ?? [];
            const deva = answer.match(/[ऀ-ॿ]/g) ?? [];
            return letters.length > 0 && deva.length / letters.length >= 0.4
              ? null
              : "Answer in Hindi (Devanagari script).";
          }
        : null,
  },
  {
    id: "arithmetic",
    find: (prompt) => {
      const m =
        /(?:what(?:'s| is)|calculate|compute|solve|evaluate|kitna hai|\bcalc\b)\s*:?\s*([0-9(][0-9+\-*/().^%×÷\s]{2,60})\s*[?=]?\s*$/i.exec(
          prompt.trim(),
        );
      const value = m?.[1] ? evaluateArithmetic(m[1]) : null;
      if (value === null || !/[+\-*/^%×÷]/.test(m?.[1] ?? "")) return null;
      const expected = Number.parseFloat(value.toPrecision(10));
      return (answer) => {
        const found = (answer.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        return found.some(
          (n) => Math.abs(n - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-9),
        )
          ? null
          : `The calculation ${m?.[1]?.trim()} equals ${expected}; the answer does not say so.`;
      };
    },
  },
];

/** Syntax of code the answer itself contains: JSON blocks must parse; JavaScript blocks must compile. */
function codeBlockFailures(answer: string): string[] {
  const out: string[] = [];
  for (const block of answer.matchAll(/```(json|js|javascript)\s*\n([\s\S]*?)```/gi)) {
    const lang = (block[1] ?? "").toLowerCase();
    const body = block[2] ?? "";
    if (lang === "json") {
      try {
        JSON.parse(body);
      } catch {
        out.push("A json code block in the answer is not valid JSON.");
      }
    } else if (!/^\s*(?:import|export)\s/m.test(body)) {
      try {
        // Compiles only: the function is never called.
        new Function(body);
      } catch {
        out.push("A JavaScript code block in the answer has a syntax error.");
      }
    }
  }
  return out;
}

/** The ids of the requirements the ask contains, in a stable order. */
export function checksFor(prompt: string): string[] {
  const text = String(prompt || "");
  return CHECKS.filter((check) => check.find(text)).map((check) => check.id);
}

export function checkAnswer(prompt: string, answer: string): CheckResult {
  const text = String(prompt || "");
  const reply = String(answer ?? "");
  const checked: string[] = [];
  const failures: CheckFailure[] = [];
  for (const check of CHECKS) {
    const run = check.find(text);
    if (!run) continue;
    checked.push(check.id);
    const message = run(reply);
    if (message) failures.push({ id: check.id, message });
  }
  // Always on: the answer must not claim to be another model, and its code must at least parse.
  if (reply.trim()) {
    checked.push("identity", "code-syntax");
    if (leaksForeignIdentity(reply)) {
      failures.push({ id: "identity", message: "Do not speak as another model; you are FRIDAY." });
    }
    for (const message of codeBlockFailures(reply)) failures.push({ id: "code-syntax", message });
  }
  return { checked, failures, ok: failures.length === 0 };
}

/** The words that go back to the model on a retry: what failed, in plain sentences. */
export function feedbackFor(failures: CheckFailure[]): string {
  return failures.map((failure) => `- ${failure.message}`).join("\n");
}
