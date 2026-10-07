import { beforeEach, describe, expect, it } from "vitest";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  doctorLookRequested,
  observeDoctorState,
  shouldAttachDoctorExtra,
} from "../../src/lib/friday/brain/doctor-observe";
import {
  describeSelfReport,
  inspectSelf,
  inspectSelfComplete,
} from "../../src/lib/friday/brain/self-diagnosis";
import {
  filterChecks,
  formatDoctorExtra,
  publishDoctorSession,
  resetDoctorSession,
} from "../../src/lib/friday/doctor-awareness";
import {
  desktopUiaChecks,
  localLlamaChecks,
  handleDoctorCommand,
  type DoctorCheck,
} from "../../src/lib/friday/doctor-engine";

const SAMPLE: DoctorCheck[] = [
  {
    id: "a",
    label: "Broken python",
    group: "Runtime",
    status: "Error",
    detail: "nope",
    cause: "missing runtime",
    fixable: true,
    command: "echo fix",
  },
  {
    id: "b",
    label: "Warn",
    group: "Runtime",
    status: "Warning",
    detail: "hmm",
    repairKind: "needs-owner",
  },
  {
    id: "c",
    label: "Ok",
    group: "Runtime",
    status: "Ready",
    detail: "fine",
  },
];

describe("doctor observe LOOK (does not steal inspectSelf)", () => {
  it.each([
    "look at the doctor",
    "setup & doctor",
    "what did the doctor find",
    "doctor scan",
    "quick doctor",
    "deep doctor",
    "auto diagnose",
    "scan now",
    "doctor report",
    "what is on the doctor page",
  ])("looks at doctor for %s", (text) => {
    expect(doctorLookRequested(text)).toBe(true);
    expect(shouldAttachDoctorExtra(text)).toBe(true);
  });

  it.each([
    "what's wrong",
    "whats wrong",
    "diagnose yourself",
    "inspect yourself",
    "find errors in the logs",
    "what is running",
    "look at the terminal",
    "look at the sandbox",
    "look at the logs",
    "look at the tasks",
    "queue status",
  ])("does not steal %s", (text) => {
    expect(doctorLookRequested(text)).toBe(false);
    expect(shouldAttachDoctorExtra(text)).toBe(false);
  });
});

describe("doctor session extra", () => {
  beforeEach(() => {
    resetDoctorSession();
    publishDoctorSession({
      filter: "problems",
      query: "python",
      follow: true,
      selectedIds: ["a"],
      checks: SAMPLE,
    });
  });

  it("formats DOCTOR SESSION from the live store plus page session", () => {
    const extra = formatDoctorExtra();
    expect(extra).toContain("DOCTOR SESSION");
    expect(extra).toContain("filter: problems");
    expect(extra).toContain("query: python");
    expect(extra).toContain("follow: on");
    expect(extra).toContain("selected: a");
    expect(extra).toContain("Broken python");
  });

  it("observeDoctorState includes the shared extra", () => {
    const live = observeDoctorState();
    expect(live.readOnly).toBe(true);
    expect(live.spawned).toBe(false);
    expect(live.extra).toContain("DOCTOR SESSION");
    expect(live.extra).toContain("filter: problems");
  });
});

describe("filterChecks", () => {
  it("filters by status buckets and query", () => {
    expect(filterChecks(SAMPLE, { filter: "all" }).map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(filterChecks(SAMPLE, { filter: "problems" }).map((c) => c.id)).toEqual(["a"]);
    expect(filterChecks(SAMPLE, { filter: "warnings" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterChecks(SAMPLE, { filter: "healthy" }).map((c) => c.id)).toEqual(["c"]);
    expect(filterChecks(SAMPLE, { filter: "fixable" }).map((c) => c.id)).toEqual(["a"]);
    expect(filterChecks(SAMPLE, { filter: "owner" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterChecks(SAMPLE, { filter: "all", query: "warn" }).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("handleDoctorCommand does not collide with inspectSelf", () => {
  it("quick doctor starts a scan through the existing store", () => {
    const handled = handleDoctorCommand("quick doctor");
    expect(handled).toMatch(/Quick Doctor scan started/);
  });

  it("doctor status returns a spoken summary", () => {
    const handled = handleDoctorCommand("what did the doctor find");
    expect(handled).toBeTruthy();
    expect(handled).not.toBeNull();
  });

  it("does not swallow what's wrong", () => {
    expect(handleDoctorCommand("what's wrong")).toBeNull();
    expect(handleDoctorCommand("diagnose yourself")).toBeNull();
  });
});

describe("inspectSelf stays the owner of what's wrong", () => {
  it("SELF_CHECK still produces the inspect-self report", async () => {
    const report = await inspectSelfComplete();
    const reply = describeSelfReport(report);
    expect(reply).toBeTruthy();
    expect(reply).not.toContain("DOCTOR SESSION");
  });

  it("inspectSelf still answers diagnose yourself", () => {
    const report = inspectSelf();
    expect(report).toBeTruthy();
    expect(describeSelfReport(report)).not.toContain("DOCTOR SESSION");
  });
});

describe("baseline doctor look", () => {
  it("look at the doctor includes the live session extra", async () => {
    resetDoctorSession();
    publishDoctorSession({
      filter: "all",
      query: "",
      follow: true,
      selectedIds: [],
      checks: SAMPLE,
    });
    const reply = baselineRespond("look at the doctor");
    expect(reply.handled).toBe(true);
    expect(reply.resolve).toBeTypeOf("function");
    const text = await reply.resolve?.();
    expect(text).toContain("DOCTOR SESSION");
    expect(text).toContain("Broken python");
  });

  it("what's wrong does not attach DOCTOR SESSION", async () => {
    const reply = baselineRespond("what's wrong");
    expect(reply.handled).toBe(true);
    const text = reply.text || (await reply.resolve?.()) || "";
    expect(text).not.toContain("DOCTOR SESSION");
  });
});

describe("desktop UI Automation doctor row", () => {
  it("points at the Install Manager helper and does not claim a live walk", () => {
    const row = desktopUiaChecks()[0];
    expect(row?.id).toBe("desktop:uia");
    expect(row?.fix).toMatch(/Install Manager/);
    expect(row?.detail).toMatch(/comtypes/);
  });
});

describe("local engine doctor row", () => {
  it("points at the pinned CPU pack and does not claim a live install", () => {
    const row = localLlamaChecks()[0];
    expect(row?.id).toBe("local:llama-cpp");
    expect(row?.status).toBe("Missing");
    expect(row?.fix).toMatch(/Install Manager/);
    expect(row?.detail).toMatch(/CPU zip/);
    expect(row?.detail).toMatch(/not checked/);
  });
});
