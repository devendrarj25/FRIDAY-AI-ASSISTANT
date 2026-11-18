/**
 * Error families a held-out round found silent or wrongly answered (2026-11-18).
 *
 * The diagnosis engine is a list of rules, each naming a tool's own words. A held-out batch (h4 and h5 in
 * `eval-harness.ts`) showed twelve common errors that got no answer and one that got a confident wrong one.
 * These tests pin the fix at the level of the family, with the variants other tools print for the same
 * fault, and pin what must NOT match, because a rule that fires on the wrong text is worse than silence.
 *
 * Text in, data out: nothing is run and no model is used. This says nothing about model quality.
 */
import { describe, expect, it } from "vitest";
import { diagnose, looksLikeFailure } from "../../src/lib/friday/brain/error-intelligence";
import { EVAL_TASKS, runEvalHarness } from "../../src/lib/friday/self/eval-harness";

const top = (text: string) => diagnose({ text }).hypotheses[0]?.id ?? null;
const ids = (text: string) => diagnose({ text }).hypotheses.map((row) => row.id);

describe("each family is recognised in every ecosystem that words it differently", () => {
  const cases: [string, string, string[]][] = [
    [
      "git-not-a-repository",
      "git outside a repository",
      ["fatal: not a git repository (or any of the parent directories): .git"],
    ],
    [
      "download-integrity-mismatch",
      "a download that differs from its recorded hash",
      [
        "verifying module: checksum mismatch\n\tdownloaded: h1:abc=\n\tgo.sum:     h1:def=",
        "npm ERR! code EINTEGRITY\nnpm ERR! sha512-AAAA integrity checksum failed when using sha512",
        "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.",
      ],
    ],
    [
      "dependency-version-unsatisfiable",
      "a version that does not exist",
      [
        'error: failed to select a version for the requirement `serde = "^2"`\ncandidate versions found which didn\'t match: 1.0.210',
        "npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for left-pad@^9.0.0.",
        "ERROR: Could not find a version that satisfies the requirement tensorflow==9.9 (from versions: 2.15.0)\nERROR: No matching distribution found for tensorflow==9.9",
      ],
    ],
    [
      "database-table-missing",
      "a table the database does not have",
      [
        "django.db.utils.OperationalError: no such table: app_item",
        'psycopg2.errors.UndefinedTable: relation "orders" does not exist',
        "ERROR 1146 (42S02): Table 'shop.orders' doesn't exist",
      ],
    ],
    [
      "esm-commonjs-mismatch",
      "CommonJS and ES modules mixed",
      [
        "Error [ERR_REQUIRE_ESM]: require() of ES Module /app/lib/x.mjs from /app/index.js not supported.",
        "SyntaxError: Cannot use import statement outside a module",
      ],
    ],
    [
      "react-invalid-hook-call",
      "a hook in the wrong place",
      [
        "Error: Invalid hook call. Hooks can only be called inside of the body of a function component.",
        "Error: Rendered more hooks than during the previous render.",
      ],
    ],
    [
      "database-login-refused",
      "a database that refused the login",
      [
        "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)",
        'FATAL:  password authentication failed for user "postgres"',
        "Login failed for user 'sa'.",
      ],
    ],
    [
      "process-killed",
      "a process killed from outside",
      [
        "container exited with code 137 (OOMKilled: true)",
        "Out of memory: Killed process 4121 (node) total-vm:2048000kB",
        "Last State: Terminated\n  Reason: OOMKilled",
      ],
    ],
    [
      "yaml-syntax",
      "a YAML file that does not parse",
      [
        'yaml.scanner.ScannerError: mapping values are not allowed here\n  in "config.yml", line 7, column 14',
        "YAMLException: bad indentation of a mapping entry (4:3)",
      ],
    ],
    [
      "assertion-failed",
      "a test whose expected value differs",
      [
        "AssertionError: expected 3 to equal 4\n    at Context.<anonymous> (test/sum.test.js:9:20)",
        "FAILED tests/test_sum.py::test_add - AssertionError: assert 3 == 4",
      ],
    ],
    [
      "too-many-open-files",
      "more open files than allowed",
      [
        "OSError: [Errno 24] Too many open files",
        "Error: EMFILE: too many open files, open '/app/data/1.json'",
      ],
    ],
  ];

  for (const [rule, what, texts] of cases) {
    it(`${rule}: ${what}`, () => {
      for (const text of texts) {
        expect(ids(text), text).toContain(rule);
        expect(diagnose({ text }).unknown, text).not.toContain("no known cause matches this text");
      }
    });
  }

  it("every new answer names a cause, a read-only check and a fix with an honest risk", () => {
    for (const [rule, , texts] of cases) {
      const row = diagnose({ text: texts[0] as string }).hypotheses.find((h) => h.id === rule);
      expect(row, rule).toBeDefined();
      expect(row?.cause.length, rule).toBeGreaterThan(30);
      expect(row?.check, rule).toMatch(/nothing is changed/);
      expect(row?.fix.steps.length, rule).toBeGreaterThanOrEqual(2);
      expect(["none", "low", "needs-approval"], rule).toContain(row?.fix.risk);
    }
  });

  it("a fix that edits files or credentials is marked as needing approval", () => {
    for (const rule of [
      "database-login-refused",
      "esm-commonjs-mismatch",
      "yaml-syntax",
      "download-integrity-mismatch",
    ]) {
      const sample = cases.find(([id]) => id === rule)?.[2][0] as string;
      expect(diagnose({ text: sample }).hypotheses.find((h) => h.id === rule)?.fix.risk).toBe(
        "needs-approval",
      );
    }
  });
});

describe("a wrong confident answer was replaced, and a specific rule beats a generic one", () => {
  it("an older Node wording of a JSON parse failure is the HTML-answer rule, not a code syntax error", () => {
    const text = "SyntaxError: Unexpected token < in JSON at position 0";
    expect(top(text)).toBe("json-got-html");
    expect(ids(text)).not.toContain("syntax");
    expect(ids("SyntaxError: Unexpected end of JSON input")).not.toContain("syntax");
  });

  it("real code syntax errors are still code syntax errors", () => {
    expect(
      top('  File "app.py", line 12\n    return total\nIndentationError: unexpected indent'),
    ).toBe("syntax");
    expect(top("SyntaxError: Unexpected token '}'")).toBe("syntax");
  });

  it("npm's bare ENOENT is a missing path, the same fault Node words with a message", () => {
    const text =
      "npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path C:\\shop\\package.json";
    expect(ids(text)).toContain("path-not-found");
    expect(ids("Error: ENOENT: no such file or directory, open 'x'")).toContain("path-not-found");
  });

  it("Java's certificate failure is the same rule as Node's untrusted chain", () => {
    const text =
      "javax.net.ssl.SSLHandshakeException: PKIX path building failed: unable to find valid certification path to requested target";
    expect(ids(text)).toContain("tls-chain-untrusted");
  });
});

describe("what must not match: a rule that fires on the wrong text is worse than silence", () => {
  const unrelated = [
    "",
    "hello, how are you?",
    "the build finished in 12 seconds",
    "please remember that my meeting is at 5",
    "Access is denied.",
    "ModuleNotFoundError: No module named 'requests'",
    "Connection refused",
    "Error: ENOSPC: no space left on device",
  ];
  const newRules = [
    "git-not-a-repository",
    "download-integrity-mismatch",
    "dependency-version-unsatisfiable",
    "database-table-missing",
    "esm-commonjs-mismatch",
    "react-invalid-hook-call",
    "database-login-refused",
    "process-killed",
    "yaml-syntax",
    "assertion-failed",
    "too-many-open-files",
  ];

  it("ordinary text and other known errors do not trigger any new rule", () => {
    for (const text of unrelated) {
      const hit = ids(text).filter((id) => newRules.includes(id));
      expect(hit, JSON.stringify(text)).toEqual([]);
    }
  });

  it("a filesystem 'Access is denied' stays a permission problem, not a database login", () => {
    expect(top("PermissionError: [WinError 5] Access is denied: 'C:\\Windows\\x.dll'")).toBe(
      "permission-denied",
    );
  });

  it("an error nothing recognises is still reported as not recognised, with no invented cause", () => {
    const got = diagnose({
      text: "Error: the frobnicator flux capacitor is misaligned (code ZX-81)",
    });
    expect(got.hypotheses).toEqual([]);
    expect(got.unknown).toContain("no known cause matches this text");
  });

  it("a plain 'killed' or a 137 inside an unrelated number does not read as an out-of-memory kill", () => {
    expect(ids("the task was killed by the user")).not.toContain("process-killed");
    expect(ids("order #1137 failed validation")).not.toContain("process-killed");
  });
});

describe("the benchmark fixtures that led here stay in place", () => {
  it("keeps h4, h5 and h6 and holds out only h6", () => {
    const by = (prefix: string) => EVAL_TASKS.filter((row) => row.id.startsWith(prefix));
    expect(by("h4-").length).toBe(12);
    expect(by("h5-").length).toBe(22);
    expect(by("h6-").length).toBe(26);
    expect(by("h4-").some((row) => row.heldOut)).toBe(false);
    expect(by("h5-").some((row) => row.heldOut)).toBe(false);
    expect(by("h6-").every((row) => row.heldOut)).toBe(true);
    expect(EVAL_TASKS.filter((row) => row.heldOut).length).toBe(26);
  });

  it("every development task still passes: the new rules took nothing away", async () => {
    const report = await runEvalHarness();
    const failedDev = report.failedAfter.filter((id) => !id.startsWith("h6-"));
    expect(failedDev).toEqual([]);
    expect(report.afterActed).toBe(0);
  });

  it("does not pass the held-out batch on rule coverage it was not written for", async () => {
    // h6 was written before these rules and is the honest figure. It is below 100% by design: when it is
    // fixed it joins the development set and a new batch replaces it.
    const report = await runEvalHarness();
    expect(report.heldOut.tasks).toBe(26);
    expect(report.heldOut.after).toBeLessThan(1);
  });
});

describe("pasted text is untrusted: no input can make a diagnosis take seconds", () => {
  // Found in the 2026-11-18 review: `Expected:` followed by tens of thousands of spaces took 3.6 s at 40 000
  // characters (quadratic backtracking in the new assertion rule), and sibling patterns in the stack parsers and
  // the exit-code decoder did the same on long runs of newlines or spaces. Before the fix these inputs took
  // 1.5 to 13 seconds; after it, a few tens of milliseconds. The limit below is deliberately generous so a slow
  // machine does not fail it, and still far below what the old patterns took.
  const N = 80_000;
  const inputs: Record<string, string> = {
    "Expected: then spaces": `test failed with an ERROR\nExpected:${" ".repeat(N)}done`,
    "Expected: then newlines": `error failed Expected:${"\n".repeat(N)}`,
    "exit code then spaces": `error failed exit code ${" ".repeat(N)}`,
    "a Python traceback header then newlines": `Traceback (most recent call last):${"\n".repeat(N)}`,
    "repeated File tokens": `error ${'File "'.repeat(N / 6)}`,
    "a Java trace of many frames": `Exception\n${"   at a.b(c.java:1)\n".repeat(N / 20)}`,
  };

  for (const [name, text] of Object.entries(inputs)) {
    it(`stays fast on: ${name}`, () => {
      const started = performance.now();
      looksLikeFailure(text);
      diagnose({ text });
      expect(performance.now() - started).toBeLessThan(2000);
    });
  }

  it("reads at most 60 000 characters, so a long paste cannot reach any rule whole", () => {
    // A cause named only after the 60 000th character is not read; one inside it still is.
    const early = `${"x".repeat(100)} AssertionError: expected 3 to equal 4`;
    const late = `${"x".repeat(70_000)} AssertionError: expected 3 to equal 4`;
    expect(diagnose({ text: early }).hypotheses.map((h) => h.id)).toContain("assertion-failed");
    expect(diagnose({ text: late }).hypotheses.map((h) => h.id)).not.toContain("assertion-failed");
  });

  it("still recognises the assertion shapes the bounded pattern is meant to keep", () => {
    for (const text of [
      "Expected: 4\nReceived: 3",
      "Expected: 4\n    Received: 3",
      "Expected: 4 Received: 3",
      "Expected 4 Actual: 3",
    ]) {
      expect(ids(text), text).toContain("assertion-failed");
    }
  });
});
