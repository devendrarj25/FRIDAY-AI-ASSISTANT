// FRIDAY · skill: code-review
// Runs inside the sandbox harness, which calls run(input).
// Deterministic static review — no network, no file system access.

const RULES = [
  {
    id: "hardcoded-secret",
    severity: "high",
    test: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i,
    message: "Possible hardcoded credential — move it to a secret store or environment variable.",
  },
  {
    id: "shell-injection",
    severity: "high",
    test: /(exec|execSync|spawn|system|os\.popen)\s*\(\s*[`"'].*\$\{|shell\s*:\s*true/,
    message: "Shell command built from interpolated input — pass an argument array instead.",
  },
  {
    id: "empty-catch",
    severity: "medium",
    test: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    message: "Empty catch block swallows the error — log it or rethrow.",
  },
  {
    id: "await-in-loop",
    severity: "low",
    test: /for\s*\([^)]*\)\s*\{[^}]*await /s,
    message: "await inside a loop serialises work — consider Promise.all where order allows.",
  },
  {
    id: "todo-debt",
    severity: "low",
    test: /\b(TODO|FIXME|HACK|XXX)\b/,
    message: "Unresolved TODO/FIXME left in the code.",
  },
  {
    id: "console-log",
    severity: "low",
    test: /console\.log\(/,
    message: "Debug logging left in place.",
  },
  {
    id: "any-cast",
    severity: "medium",
    test: /\bas any\b|:\s*any\b/,
    message: "`any` defeats type checking — narrow the type.",
  },
];

export async function run(input = {}) {
  const code = String(input.code || "");
  if (!code.trim()) return { ok: false, error: "No code was provided." };
  const lines = code.split(/\r?\n/);

  const findings = [];
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.test.test(line)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          line: index + 1,
          text: line.trim().slice(0, 200),
          message: rule.message,
        });
      }
    }
  });

  // Multi-line checks.
  for (const rule of RULES.filter((r) => r.id === "await-in-loop")) {
    if (rule.test.test(code) && !findings.some((f) => f.rule === rule.id)) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line: null,
        text: "",
        message: rule.message,
      });
    }
  }

  const longFunctions = [];
  let current = null;
  lines.forEach((line, index) => {
    const match = line.match(/(?:function\s+(\w+)|(\w+)\s*(?:=|:)\s*(?:async\s*)?\([^)]*\)\s*=>)/);
    if (match) {
      if (current) longFunctions.push(current);
      current = { name: match[1] || match[2], start: index + 1, length: 0 };
    }
    if (current) current.length = index + 1 - current.start;
  });
  if (current) longFunctions.push(current);
  const oversized = longFunctions.filter((f) => f.length > 60);

  const score = Math.max(
    0,
    100 -
      findings.filter((f) => f.severity === "high").length * 20 -
      findings.filter((f) => f.severity === "medium").length * 8 -
      findings.filter((f) => f.severity === "low").length * 2 -
      oversized.length * 5,
  );

  return {
    filename: input.filename || null,
    lines: lines.length,
    score,
    verdict: score >= 85 ? "looks good" : score >= 60 ? "needs attention" : "needs rework",
    findings,
    oversizedFunctions: oversized,
    summary: `${findings.length} finding(s) across ${lines.length} lines; ${oversized.length} function(s) over 60 lines.`,
  };
}

export default run;
