/**
 * Find -> understand -> fix -> guide. Every case is text in, data out: no file is read and
 * no command is run. Secret-shaped fixtures are assembled at run time so no scanner mistakes
 * this file for a leak.
 */
import { describe, expect, it } from "vitest";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  decodeCode,
  diagnose,
  extractCodes,
  fileFixProposal,
  fileRiskFindings,
  guidance,
  localize,
  looksLikeFailure,
  normaliseMessage,
  normalizeError,
  prefersHinglish,
  scanRisks,
} from "../../src/lib/friday/brain/error-intelligence";
import { governance } from "../../src/lib/friday/self/governance";
import { publishReliability, resetSelfAtlasForTests } from "../../src/lib/friday/self-atlas";

const PY = `Traceback (most recent call last):
  File "C:\\proj\\app.py", line 12, in <module>
    main()
  File "C:\\proj\\core.py", line 40, in main
    data = open(path).read()
  File "C:\\Python312\\Lib\\encodings\\cp1252.py", line 23, in decode
    return codecs.charmap_decode(input,self.errors,decoding_table)[0]
UnicodeDecodeError: 'charmap' codec can't decode byte 0x9d in position 12: character maps to <undefined>`;

const JS = `TypeError: Cannot read properties of undefined (reading 'id')
    at renderPanel (C:\\app\\src\\panel.ts:12:20)
    at Object.<anonymous> (C:\\app\\src\\main.ts:30:5)
    at Module._compile (node:internal/modules/cjs/loader:1554:14)
    at node_modules/vite/dist/node.js:5:1`;

const JAVA = `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null
\tat com.acme.Util.len(Util.java:12)
\tat com.acme.Main.main(Main.java:5)`;

const CSHARP = `System.NullReferenceException: Object reference not set to an instance of an object.
   at Demo.Worker.Execute() in C:\\src\\Worker.cs:line 42
   at System.Linq.Enumerable.Select()
   at Demo.Program.Main() in C:\\src\\Program.cs:line 10`;

const GO = `panic: runtime error: invalid memory address or nil pointer dereference
[signal 0xc0000005 code=0x0 addr=0x0 pc=0x4a1b2c]

goroutine 1 [running]:
main.handle(...)
\tC:/proj/main.go:14
main.main()
\tC:/proj/main.go:9 +0x1d`;

const RUST = `thread 'main' panicked at src/main.rs:5:9:
called \`Option::unwrap()\` on a \`None\` value`;

const GCC = `src/a.cpp:12:5: error: 'x' was not declared in this scope
src/a.cpp:20:1: warning: unused variable`;

const MSVC_LINK = `main.obj : error LNK2019: unresolved external symbol "int __cdecl foo(void)" referenced in function main`;

const PS = `The term 'foo' is not recognized as the name of a cmdlet, function, script file, or operable program.
At line:1 char:1
+ foo
+ ~~~
    + CategoryInfo          : ObjectNotFound: (foo:String) [], CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException`;

describe("reading a failure", () => {
  it("lists frames innermost first, and picks the innermost frame in the owner's code", () => {
    const py = normalizeError(PY);
    expect(py.language).toBe("python");
    expect(py.errorType).toBe("UnicodeDecodeError");
    expect(py.frames[0]).toMatchObject({
      file: "C:\\Python312\\Lib\\encodings\\cp1252.py",
      own: false,
    });
    expect(py.frames.find((f) => f.own)).toMatchObject({
      file: "C:\\proj\\core.py",
      line: 40,
      fn: "main",
    });

    const js = normalizeError(JS);
    expect(js.language).toBe("javascript");
    expect(js.errorType).toBe("TypeError");
    expect(js.frames.map((f) => f.own)).toEqual([true, true, false, false]);
    expect(js.frames[0]).toMatchObject({
      file: "C:\\app\\src\\panel.ts",
      line: 12,
      column: 20,
      fn: "renderPanel",
    });
  });

  it("reads Java, C#, Go, Rust, C++ and PowerShell", () => {
    const java = normalizeError(JAVA);
    expect(java).toMatchObject({ language: "java", errorType: "java.lang.NullPointerException" });
    expect(java.frames[0]).toMatchObject({ line: 12, fn: "com.acme.Util.len", own: true });

    const cs = normalizeError(CSHARP);
    expect(cs).toMatchObject({ language: "csharp", errorType: "System.NullReferenceException" });
    expect(cs.frames.map((f) => f.own)).toEqual([true, false, true]);
    expect(cs.frames[0]).toMatchObject({ file: "C:\\src\\Worker.cs", line: 42 });

    const go = normalizeError(GO);
    expect(go).toMatchObject({ language: "go", errorType: "nil pointer dereference" });
    expect(go.frames[0]).toMatchObject({ file: "C:/proj/main.go", line: 14 });

    const rust = normalizeError(RUST);
    expect(rust).toMatchObject({ language: "rust", errorType: "panic" });
    expect(rust.frames[0]).toMatchObject({ file: "src/main.rs", line: 5, column: 9 });

    const cpp = normalizeError(GCC);
    expect(cpp).toMatchObject({ language: "cpp", errorType: "compile error" });
    expect(cpp.frames[0]).toMatchObject({ file: "src/a.cpp", line: 12, column: 5 });
    expect(normalizeError(MSVC_LINK)).toMatchObject({ language: "cpp", errorType: "link error" });

    const ps = normalizeError(PS);
    expect(ps).toMatchObject({ language: "powershell", errorType: "CommandNotFoundException" });
    expect(ps.frames[0]).toMatchObject({ line: 1, column: 1 });
  });

  it("gives the same fingerprint when only paths, numbers and names change", () => {
    const a = normalizeError(PY);
    const b = normalizeError(
      PY.replaceAll("C:\\proj", "D:\\other\\place")
        .replace("position 12", "position 99")
        .replace("0x9d", "0x81"),
    );
    expect(a.fingerprint).toMatch(/^fp-[0-9a-f]{8}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(normalizeError(JS).fingerprint).not.toBe(a.fingerprint);
    expect(normalizeError(PY.replace("line 40", "line 41")).fingerprint).toBe(a.fingerprint);
    expect(normalizeError(PY.replace("core.py", "other.py")).fingerprint).not.toBe(a.fingerprint);
    expect(normaliseMessage("ENOENT open 'C:\\a\\b.json' at 0xDEADBEEF after 42 tries")).toBe(
      "enoent open '?' at <hex> after n tries",
    );
  });

  it("copes with empty, huge and hostile text", () => {
    expect(normalizeError("").language).toBe("unknown");
    expect(normalizeError("   \n\n").frames).toEqual([]);
    expect(normalizeError("x".repeat(500_000)).lines).toBe(1);
    expect(() =>
      normalizeError("at (((((((((((((((((((((((((((((((((((((((((((((((((("),
    ).not.toThrow();
  });
});

describe("decoding Windows and system codes", () => {
  it("decodes NTSTATUS, HRESULT, Win32, MSI and winget codes, and negative exit codes", () => {
    expect(decodeCode("3221225781")).toMatchObject({ code: "0xc0000135", family: "ntstatus" });
    expect(decodeCode("-1073741515")).toMatchObject({ code: "0xc0000135" });
    expect(decodeCode("0xC0000005")?.meaning).toContain("access violation");
    expect(decodeCode("0x80070005")).toMatchObject({
      family: "hresult",
      meaning: "Windows error 5: access denied",
    });
    expect(decodeCode("0x80004005")?.meaning).toContain("E_FAIL");
    expect(decodeCode("5")).toMatchObject({ family: "win32", meaning: "access denied" });
    expect(decodeCode("1603", "msiexec /i app.msi")).toMatchObject({ family: "msi" });
    expect(decodeCode("3010", "msiexec")).toMatchObject({ benign: true });
    expect(decodeCode("2316632107")).toMatchObject({ family: "winget", benign: true });
    expect(decodeCode("0x8A150014")).toMatchObject({ family: "winget", benign: true });
    expect(decodeCode("ENOSPC")?.meaning).toBe("no space left on the device");
  });

  it("does not invent a meaning for a code it does not know", () => {
    expect(decodeCode("0x12345678")).toBeNull();
    expect(decodeCode("424242")).toBeNull();
    expect(decodeCode("EWHATEVER")).toBeNull();
    expect(decodeCode("not a code")).toBeNull();
    expect(decodeCode("0x80070999")).toBeNull();
  });

  it("finds codes inside log text, once each", () => {
    const codes = extractCodes(
      "Process exited with code 3221225781 (0xC0000135) and ERROR_ACCESS_DENIED; ENOENT again ENOENT",
    );
    expect(codes.map((c) => c.code)).toEqual(["0xc0000135", "5", "ENOENT"]);
  });
});

describe("ranking causes with evidence", () => {
  it("explains a full disk, and lets measured free space raise or lower the confidence", () => {
    const text = "Error: ENOSPC: no space left on device, write";
    const bare = diagnose({ text });
    expect(bare.hypotheses[0]?.id).toBe("disk-full");
    expect(bare.unknown).toContain("the free space of the drive was not read");
    const low = diagnose({ text, evidence: { diskFreeGb: 0.2 } });
    const plenty = diagnose({ text, evidence: { diskFreeGb: 120 } });
    expect(low.hypotheses[0]?.confidence).toBeGreaterThan(bare.hypotheses[0]?.confidence ?? 1);
    expect(plenty.hypotheses[0]?.confidence).toBeLessThan(bare.hypotheses[0]?.confidence ?? 0);
    expect(low.hypotheses[0]?.evidence.join(" ")).toContain("0.2 GB free");
    expect(plenty.hypotheses[0]?.evidence.join(" ")).toContain("another drive or a quota");
  });

  it("does not retry a fault that another try cannot change, and does retry a rate limit", () => {
    for (const text of [
      "Error: ENOSPC: no space left on device",
      "EACCES: permission denied, open 'C:\\Windows\\x'",
      "SyntaxError: Unexpected token } in main.js:4",
      "EADDRINUSE: address already in use :::8765",
      "running scripts is disabled on this system",
    ]) {
      expect(diagnose({ text }).retryable, text).toBe(false);
    }
    const limited = diagnose({ text: "HTTP 429 Too Many Requests: rate limit reached" });
    expect(limited.hypotheses[0]?.id).toBe("rate-limited");
    expect(limited.retryable).toBe(true);
    expect(limited.domain).toBe("model");
  });

  it("uses the clock and the kernel state as evidence", () => {
    const tls = "SSL certificate problem: certificate is not yet valid";
    const off = diagnose({ text: tls, evidence: { clockSkewMs: 3 * 3_600_000 } });
    const fine = diagnose({ text: tls, evidence: { clockSkewMs: 2_000 } });
    expect(off.hypotheses[0]?.confidence).toBeGreaterThan(fine.hypotheses[0]?.confidence ?? 1);
    const refused = "connect ECONNREFUSED 127.0.0.1:8765";
    expect(
      diagnose({ text: refused, evidence: { kernelUp: false } }).hypotheses[0]?.confidence,
    ).toBeGreaterThan(
      diagnose({ text: refused, evidence: { kernelUp: true } }).hypotheses[0]?.confidence ?? 1,
    );
  });

  it("checks a version floor against the measured version", () => {
    const text = "npm warn EBADENGINE Unsupported engine { required: { node: '>=22.19.0' } }";
    const old = diagnose({ text, evidence: { nodeVersion: "20.11.0", nodeFloor: "22.19.0" } });
    const fine = diagnose({ text, evidence: { nodeVersion: "24.1.0", nodeFloor: "22.19.0" } });
    expect(old.hypotheses[0]?.id).toBe("engine-floor");
    expect(old.hypotheses[0]?.confidence).toBeGreaterThan(fine.hypotheses[0]?.confidence ?? 1);
  });

  it("recognises common failures across tools", () => {
    const cases: [string, string][] = [
      ["ModuleNotFoundError: No module named 'faster_whisper'", "module-missing-python"],
      ["Error: Cannot find module 'electron'", "module-missing-node"],
      ["error: externally-managed-environment", "pip-externally-managed"],
      ["npm error code ERESOLVE unable to resolve dependency tree", "npm-peer-conflict"],
      ["/bin/bash^M: bad interpreter", "crlf-script"],
      ["fatal: detected dubious ownership in repository at 'D:/friday'", "git-ownership"],
      ["CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed", "merge-conflict"],
      ["ENAMETOOLONG: name too long, open 'C:\\very\\long'", "path-too-long"],
      ["a.cpp:1:10: fatal error: foo.h: No such file or directory", "missing-include"],
      [MSVC_LINK, "unresolved-symbol"],
      ["The process exited with code 3221225781", "missing-runtime-dll"],
      ["segmentation fault (core dumped)", "native-crash"],
      ["The requested operation requires elevation. error 740", "needs-elevation"],
      ["msiexec returned 1618: another installation is in progress", "installer-busy"],
      ["winget exited with code 2316632107", "benign-code"],
      ["getaddrinfo ENOTFOUND registry.npmjs.org", "host-not-found"],
      [PS, "command-not-found"],
      [JS, "null-access"],
      [JAVA, "null-access"],
      [GO, "null-access"],
      [RUST, "null-access"],
      [PY, "encoding"],
    ];
    for (const [text, id] of cases) {
      expect(
        diagnose({ text }).hypotheses.map((h) => h.id),
        text.slice(0, 50),
      ).toContain(id);
    }
  });

  it("reports a code or text it cannot explain as unknown, without a made-up cause", () => {
    const got = diagnose({ text: "Something odd happened with code 0x12345678 in the widget" });
    expect(got.hypotheses).toEqual([]);
    expect(got.confidence).toBe(0);
    expect(got.unknown).toContain("no known cause matches this text");
    expect(got.unknown).toContain("a code in the text is not in the decode tables");
  });

  it("states the doubt when the best cause is weak", () => {
    const got = diagnose({
      text: "SSL certificate problem: unable to get local issuer certificate",
      evidence: { clockSkewMs: 1000 },
    });
    expect(got.confidence).toBeLessThan(0.6);
    expect(got.unknown).toContain("the best cause is below 60% sure, so check before acting");
  });

  it("uses the crash records the PC probe already read", () => {
    resetSelfAtlasForTests();
    publishReliability({
      detectedAt: 1,
      supported: true,
      items: [
        {
          id: "crashes",
          label: "Application crashes",
          state: "warn",
          detail: "x",
          apps: [{ app: "FRIDAY.exe", count: 4 }],
        },
      ],
    });
    const got = diagnose({ text: "The program exited with code 0xC0000005" });
    resetSelfAtlasForTests();
    expect(got.hypotheses[0]?.id).toBe("native-crash");
    expect(got.hypotheses[0]?.evidence.join(" ")).toContain(
      "FRIDAY.exe appears in 4 recent crash record(s)",
    );
  });

  it("keeps every proposed step read-only until the owner approves a change", () => {
    const got = diagnose({ text: "ModuleNotFoundError: No module named 'x'" });
    expect(got.hypotheses[0]?.check).toContain("nothing is installed");
    expect(got.hypotheses[0]?.fix.risk).toBe("needs-approval");
  });
});

describe("where to look before any patch", () => {
  it("prefers the innermost frame in the owner's code", () => {
    const got = localize(normalizeError(PY));
    expect(got.location).toMatchObject({
      file: "C:\\proj\\core.py",
      line: 40,
      basis: "stack-trace",
    });
    expect(got.bisect).toBeNull();
  });

  it("notes when the trace points at a file that changed lately", () => {
    const got = localize(normalizeError(JS), {
      recentChanges: [{ path: "src/panel.ts", subject: "refactor panel props" }],
    });
    expect(got.location?.note).toContain('this file changed recently ("refactor panel props")');
  });

  it("falls back to change history with a bisect plan, and says when it has neither", () => {
    const lead = localize(normalizeError("it just stopped working"), {
      recentChanges: [{ path: "src/x.ts" }],
    });
    expect(lead.location).toMatchObject({ basis: "change-history", file: "src/x.ts" });
    expect(lead.location?.note).toContain("only a lead, not a finding");
    expect(lead.bisect).toContain("git bisect run");
    const none = localize(normalizeError("it just stopped working"));
    expect(none.location).toBeNull();
    expect(none.bisect).toContain("send the full trace");
  });
});

describe("guidance in the owner's language", () => {
  it("answers in short Hinglish with the cause, the check, the fix and the way back", () => {
    const text = guidance(
      diagnose({ text: "Error: ENOSPC: no space left on device", evidence: { diskFreeGb: 0.3 } }),
      "hinglish",
    );
    expect(text).toContain("Kya hua:");
    expect(text).toContain("Sabse sambhav wajah");
    expect(text).toContain("Pehle yeh dekho (sirf padhna)");
    expect(text).toContain("Safe fix:");
    expect(text).toContain("Undo: badalne se pehle backup banta hai");
    expect(text).toContain("Dobara chalane se fark nahi padega");
    expect(text.split("\n").length).toBeLessThan(16);
  });

  it("answers in English too, and picks the language from the message", () => {
    const text = guidance(diagnose({ text: PY }), "english");
    expect(text).toContain("What broke: UnicodeDecodeError");
    expect(text).toContain("Where: C:\\proj\\core.py:40 (main)");
    expect(text).toContain("Undo: a backup is taken before any change");
    expect(prefersHinglish("mujhe ye error aa raha hai, kya karu")).toBe(true);
    expect(prefersHinglish("the build failed with an error")).toBe(false);
  });

  it("will not guess when it does not know, and says what to send", () => {
    const text = guidance(diagnose({ text: "something strange" }), "hinglish");
    expect(text).toContain("andaza nahi lagaya");
    expect(text).not.toMatch(/Sabse sambhav/);
  });

  it("asks one question when two causes are close", () => {
    const text = guidance(
      diagnose({
        text: "SSL certificate problem: unable to get local issuer certificate. connect ECONNREFUSED",
        evidence: { clockSkewMs: 400_000 },
      }),
      "english",
    );
    expect(text.match(/One question/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("states a benign code plainly", () => {
    const text = guidance(diagnose({ text: "winget exited with code 2316632107" }), "english");
    expect(text).toContain("nothing to fix");
  });
});

describe("a fix is a proposal, never an action", () => {
  const diagnosis = diagnose({ text: JS });
  const base = {
    diagnosis,
    diff: "--- a/src/panel.ts\n+++ b/src/panel.ts\n@@\n-p.id\n+p?.id\n",
    files: ["src/panel.ts"],
    tests: ["core/__tests__/panel.test.ts"],
    rollback: "git restore src/panel.ts",
  };

  it("refuses an incomplete proposal and says what is missing", () => {
    const got = fileFixProposal({ ...base, tests: [], rollback: " " });
    expect(got).toMatchObject({ filed: false, allow: "incomplete", applied: false });
    expect(got.reason).toBe("a fix proposal needs the tests that cover it, how to undo it");
  });

  it("refuses a protected file", () => {
    const got = fileFixProposal({ ...base, files: ["AGENTS.md"] });
    expect(got).toMatchObject({ filed: false, allow: "refuse", applied: false });
  });

  it("files a complete proposal on the governance queue, always-ask, once", () => {
    const own = diagnose({ text: `${JS}\n// ${Date.now().toString(36)}-${Math.random()}` });
    const first = fileFixProposal({ ...base, diagnosis: own });
    expect(first.filed).toBe(true);
    expect(first.applied).toBe(false);
    const item = governance.get(first.id ?? "");
    expect(item).toMatchObject({ kind: "code-change", stage: "discovered" });
    expect(item?.evidence.join("\n")).toContain("rollback git restore src/panel.ts");
    expect(governance.autoApproves(item!.risk, item!.kind)).toBe(false);
    expect(fileFixProposal({ ...base, diagnosis: own }).filed).toBe(false);
  });
});

// Built at run time so this file holds no literal that looks like a credential.
const AKIA = ["AKI", "AABCDEFGHIJKLMNOP"].join("");
const GH = ["gh", "p_", "a".repeat(36)].join("");
const SK = ["s", "k-", "b".repeat(30)].join("");
const PEM = ["-----BEGIN ", "RSA PRIVATE KEY-----"].join("");

describe("risk scanning", () => {
  const scan = (text: string, path = "src/x.ts") => scanRisks([{ path, text }]);

  it("finds a secret and never repeats it in the excerpt", () => {
    const found = scan(`const a = "${AKIA}";\nconst t = "${GH}";\nconst k = "${SK}";\n${PEM}\n`);
    expect(found.map((f) => f.rule).sort()).toEqual(
      ["aws-access-key", "github-token", "api-key-literal", "private-key-block"].sort(),
    );
    for (const finding of found) {
      expect(finding.severity).toBe("high");
      expect(finding.excerpt).toContain("[redacted]");
      expect(finding.excerpt).not.toContain(GH);
      expect(finding.excerpt).not.toContain(SK);
      expect(finding.excerpt).not.toContain(AKIA);
    }
  });

  it("flags a password literal but not a placeholder or an environment read", () => {
    expect(scan('const password = "hunter2hunter2";').map((f) => f.rule)).toEqual([
      "password-literal",
    ]);
    expect(scan('password = "your-password-here"')).toEqual([]);
    expect(scan('password = process.env.PASSWORD || ""')).toEqual([]);
    expect(scan('api_key = os.environ["KEY"]')).toEqual([]);
  });

  it("flags shell strings built from input, eval, iex, TLS off and unguarded deletes", () => {
    const rules = (text: string, path?: string) => scan(text, path).map((f) => f.rule);
    expect(rules("subprocess.run(cmd, shell=True)", "a.py")).toContain("shell-from-input");
    expect(rules('os.system(f"rm {name}")', "a.py")).toContain("shell-from-input");
    expect(rules("child_process.exec(`git ${arg}`)")).toContain("shell-from-input");
    expect(rules("eval(userText)")).toContain("eval-call");
    expect(rules("Invoke-Expression $cmd", "a.ps1")).toContain("powershell-iex");
    expect(rules("requests.get(url, verify=False)", "a.py")).toContain("tls-verify-off");
    expect(rules("shutil.rmtree(target)", "a.py")).toContain("recursive-delete-variable");
    expect(rules("DELETE FROM users;", "a.sql")).toContain("sql-without-where");
    expect(rules("fetch(url)")).toContain("http-unguarded-fetch");
  });

  it("leaves safe code alone", () => {
    const safe = [
      'subprocess.run(["git", "status"])',
      "eval_score = 3",
      "DELETE FROM users WHERE id = 1;",
      "const a = fetch('https://example.com/x')",
    ].join("\n");
    expect(scan(safe)).toEqual([]);
  });

  it("orders by severity and gives the line number and a remedy", () => {
    const found = scan(`fetch(url)\nsubprocess.run(x, shell=True)\n`);
    expect(found.map((f) => [f.rule, f.line])).toEqual([
      ["shell-from-input", 2],
      ["http-unguarded-fetch", 1],
    ]);
    expect(found[0]?.remedy.length).toBeGreaterThan(10);
  });

  it("files only high and medium findings on the governance queue, once, as security", () => {
    const path = `src/risk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.py`;
    const found = scanRisks([{ path, text: `x = 1\nsubprocess.run(c, shell=True)\nfetch(url)\n` }]);
    const filed = fileRiskFindings(found);
    expect(filed.filed).toBe(1);
    const item = governance.get(filed.ids[0] ?? "");
    expect(item).toMatchObject({ kind: "security", stage: "discovered", risk: "risky" });
    expect(governance.autoApproves(item!.risk, item!.kind)).toBe(false);
    expect(fileRiskFindings(found).filed).toBe(0);
  });
});

describe("in the chat", () => {
  it("analyses a pasted traceback with no model, in Hinglish when the owner wrote Hinglish", async () => {
    const reply = baselineRespond(`mujhe ye error aa raha hai, kya karu?\n${PY}`);
    expect(reply.handled).toBe(true);
    expect(reply.text).toContain("Kya hua:");
    expect(reply.text).toContain("core.py:40");
  });

  it("explains a bare crash code", () => {
    expect(looksLikeFailure("setup exited with code 3221225781")).toBe(true);
    const reply = baselineRespond("setup exited with code 3221225781");
    expect(reply.handled).toBe(true);
    expect(reply.text).toContain("a required DLL was not found");
  });

  it("leaves ordinary talk alone", () => {
    expect(looksLikeFailure("what time is it")).toBe(false);
    expect(looksLikeFailure("I made an error in my budget")).toBe(false);
  });
});
