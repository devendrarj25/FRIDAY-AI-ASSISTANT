import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isProblemCheck, stepsFor, type DoctorCheck } from "../../src/lib/friday/doctor-engine";
import { dedupeProblems, type SelfProblem } from "../../src/lib/friday/brain/self-diagnosis";

const check = (over: Partial<DoctorCheck>): DoctorCheck =>
  ({
    id: "x",
    label: "Thing",
    group: "Group",
    status: "Missing",
    detail: "detail",
    fixable: false,
    ...over,
  }) as DoctorCheck;

const problem = (over: Partial<SelfProblem>): SelfProblem => ({
  id: "p",
  severity: "critical",
  area: "models",
  title: "Local models — Missing",
  detail: "no local models pulled",
  ...over,
});

describe("one fault is one entry, and the counts agree", () => {
  it("the Doctor's and the system map's wording of the same fault is listed once, keeping the one with owner steps", () => {
    const doctor = problem({
      id: "doctor:models",
      title: "Local models — Missing",
      steps: ["Pull a model", "Re-check"],
    });
    const map = problem({
      id: "map:models",
      severity: "warning",
      area: "models",
      title: "Local models is missing",
    });
    const merged = dedupeProblems([doctor, map]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("doctor:models");
    expect(merged[0]?.severity).toBe("critical");
  });

  it("the worse severity wins, even when the entry with steps was the milder one", () => {
    const merged = dedupeProblems([
      problem({ id: "a", severity: "warning", title: "Speech model — Missing", steps: ["do it"] }),
      problem({ id: "b", severity: "critical", title: "Speech model is missing" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("a");
    expect(merged[0]?.severity).toBe("critical");
  });

  it("different faults that share a word are not merged", () => {
    const merged = dedupeProblems([
      problem({ id: "a", title: "Local models — Missing" }),
      problem({ id: "b", title: "Cloud models — Missing" }),
      problem({ id: "c", title: "Models cooling down", area: "models" }),
    ]);
    expect(merged.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("an optional part that is not installed is not a problem; a required one is", () => {
    expect(isProblemCheck(check({ optional: true }))).toBe(false);
    expect(isProblemCheck(check({ optional: false }))).toBe(true);
    expect(isProblemCheck(check({ status: "Ready" }))).toBe(false);
  });

  it("the Doctor page counts problems the way its own filter does, and labels an optional part as optional", () => {
    const page = readFileSync("src/routes/doctor.tsx", "utf8");
    expect(page).toContain("fail: state.checks.filter((c) => isProblemCheck(c)).length");
    expect(page).toContain('c.optional && isProblem(c.status) ? "optional"');
  });
});

describe("the owner steps say only what is true", () => {
  it("a note with nothing to act on does not claim that only the owner can grant something", () => {
    const steps = stepsFor(
      check({
        status: "Warning",
        label: "Content Security Policy",
        detail: "8 report-only violation(s)",
      }),
    ).join(" ");
    expect(steps).toMatch(/note, not a fault/i);
    expect(steps).not.toMatch(/only you can grant/i);
  });

  it("an optional part says it is optional", () => {
    const steps = stepsFor(check({ optional: true, detail: "not installed" })).join(" ");
    expect(steps).toMatch(/optional/i);
    expect(steps).not.toMatch(/only you can grant/i);
  });

  it("a required fault with nothing FRIDAY can do still says so", () => {
    const steps = stepsFor(check({ optional: false, detail: "driver missing" })).join(" ");
    expect(steps).toMatch(/only you can grant/i);
  });

  it("a fault with a command or a fix keeps them", () => {
    const steps = stepsFor(check({ fix: "Pull a model", command: "ollama pull qwen2.5:7b" })).join(
      " ",
    );
    expect(steps).toContain("ollama pull qwen2.5:7b");
    expect(steps).toContain("Pull a model");
  });
});

import { offersShowHow } from "../../src/lib/friday/assistant-conduct";

describe("small talk gets no 'show you how' offer", () => {
  it("the matching steps that run on every turn are not tool work; a runner that ran is", () => {
    const smallTalk = [
      { nodeId: "agents.skills", state: "done", detail: "matching installed skills" },
      { nodeId: "agents.tools", state: "done", detail: "matching installed tools" },
    ];
    expect(offersShowHow(smallTalk)).toBe(false);
    expect(
      offersShowHow([
        ...smallTalk,
        { nodeId: "execution.runners", state: "done", detail: "Chrome — opened" },
      ]),
    ).toBe(true);
    expect(offersShowHow([{ nodeId: "execution.runners", state: "done", detail: "" }])).toBe(false);
    expect(offersShowHow(undefined)).toBe(false);
  });
});

describe("screenshot sweep: wording and housekeeping", () => {
  const read = (file: string) => readFileSync(file, "utf8");

  it("keeps code names out of the owner steps and skips the engine install step when one runs", () => {
    const source = read("electron/diagnostics.cjs");
    expect(source).not.toContain("`engineStatus().canStart`");
    expect(source).toContain("is already running, so only the model is missing");
  });

  it("says a bundled tool that was never run needs one run, not a re-extract", () => {
    const source = read("electron/bundled-runtime.cjs");
    expect(source).toContain("has not run it once to prove it works");
    expect(source).toContain("Press Repair: FRIDAY re-checks the pack and runs the tool once");
  });

  it("does not paint optional sandbox dev tools as a red fault", () => {
    const source = read("src/routes/sandbox.tsx");
    expect(source).toContain("optional dev tool");
    expect(source).not.toContain(
      '<XCircle className="size-3.5 text-destructive" />\n                  )}\n                </div>\n                <p',
    );
  });

  it("keeps heal housekeeping out of the conversation captions", () => {
    const source = read("src/lib/friday/assistant-mode.ts");
    const body = source.slice(source.indexOf("private markHealFixed()"));
    expect(body.slice(0, body.indexOf("private applyVoiceHeal"))).not.toContain("this.caption(");
  });
});
