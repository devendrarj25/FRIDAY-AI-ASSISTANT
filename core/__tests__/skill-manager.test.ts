/**
 * FRIDAY can manage her own skills by chat: list them, explain one, switch one on or off, remove an installed
 * one, install a pack from a GitHub repository. Reading is free; every change goes through the owner's approval
 * gate and a request that is still waiting is never reported as done. Ordinary talk changes nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  describeCatalog,
  manageSkills,
  parseSkillCommand,
  resolveSkill,
  type GateOutcome,
  type ManagedSkill,
  type SkillManagerHost,
} from "../../src/lib/friday/brain/skill-manager";

const skill = (id: string, name: string, over: Partial<ManagedSkill> = {}): ManagedSkill => ({
  id,
  name,
  category: "friday-ops",
  enabled: true,
  summary: `${name} summary`,
  shipped: true,
  capabilityId: `skills/core/${id}`,
  risk: "safe",
  ...over,
});

const CATALOG: ManagedSkill[] = [
  skill("saf-secret-scan", "Secret scan", { category: "privacy-safety" }),
  skill("ops-log-triage", "Log triage"),
  skill("in-gst-calc", "GST calculator", { category: "india" }),
  skill("in-invoice-total", "Invoice total", { category: "india", enabled: false }),
  skill("my-notes", "My notes helper", {
    shipped: false,
    capabilityId: "skills/custom/my-notes",
    category: "custom",
  }),
  skill("web.search", "Web search", { shipped: true, capabilityId: null, category: "web" }),
];

type Call = { kind: string; detail?: string };

function host(gate: GateOutcome["state"] = "done", calls: Call[] = []): SkillManagerHost {
  return {
    list: async () => CATALOG.map((s) => ({ ...s })),
    setEnabled: async (s, enabled) => {
      calls.push({ kind: "setEnabled", detail: `${s.id}:${enabled}` });
      return { ok: true };
    },
    remove: async (s) => {
      calls.push({ kind: "remove", detail: s.id });
      return { ok: true };
    },
    installGit: async (url) => {
      calls.push({ kind: "installGit", detail: url });
      return { ok: true, installed: ["a-pack"] };
    },
    // The stand-in for governance: runs the change only when the gate opens, like the real one.
    gate: async (title, _rationale, risk, _evidence, apply) => {
      calls.push({ kind: "gate", detail: `${risk}:${title}` });
      if (gate === "done") {
        const result = await apply();
        return result.ok
          ? { state: "done", detail: result.detail }
          : { state: "failed", detail: result.detail };
      }
      return {
        state: gate,
        detail: gate === "waiting" ? "it applies when approved" : "not approved",
      };
    },
  };
}

describe("reading the owner's words", () => {
  it("finds enable, disable and remove commands in English and Hinglish", () => {
    expect(parseSkillCommand("disable the secret scan skill")).toEqual({
      kind: "disable",
      target: "secret scan",
    });
    expect(parseSkillCommand("Please turn off the Log triage skill.")).toEqual({
      kind: "disable",
      target: "log triage",
    });
    expect(parseSkillCommand("enable gst calculator skill")).toEqual({
      kind: "enable",
      target: "gst calculator",
    });
    expect(parseSkillCommand("friday, activate the skill called invoice total")).toEqual({
      kind: "enable",
      target: "invoice total",
    });
    expect(parseSkillCommand("remove my notes helper skill")).toEqual({
      kind: "remove",
      target: "notes helper", // "my" is a determiner; the resolver still finds "My notes helper"
    });
    expect(parseSkillCommand("uninstall the skill my-notes")).toEqual({
      kind: "remove",
      target: "my-notes",
    });
    expect(parseSkillCommand("secret scan skill on karo")).toEqual({
      kind: "enable",
      target: "secret scan",
    });
    expect(parseSkillCommand("log triage skill band karo")).toEqual({
      kind: "disable",
      target: "log triage",
    });
    expect(parseSkillCommand("gst calculator skill hatao")).toEqual({
      kind: "remove",
      target: "gst calculator",
    });
  });

  it("finds list and info questions", () => {
    for (const ask of [
      "list my skills",
      "show me all skills",
      "what skills do you have",
      "which skills are enabled",
      "how many skills are installed",
      "what are your skills?",
      "skills list dikhao",
      "kaun kaun se skills hain",
      "show installed skills",
    ]) {
      expect(parseSkillCommand(ask)?.kind, ask).toBe("list");
    }
    expect(parseSkillCommand("show me the privacy skills")).toEqual({
      kind: "list",
      query: "privacy",
    });
    expect(parseSkillCommand("what does the gst calculator skill do?")).toEqual({
      kind: "info",
      target: "gst calculator",
    });
    expect(parseSkillCommand("secret scan skill kya karta hai")).toEqual({
      kind: "info",
      target: "secret scan",
    });
  });

  it("finds an install from a GitHub repository", () => {
    expect(parseSkillCommand("install skills from https://github.com/owner/repo")).toEqual({
      kind: "install",
      url: "https://github.com/owner/repo",
    });
    expect(
      parseSkillCommand("please add the skill pack https://github.com/owner/repo.git")?.kind,
    ).toBe("install");
    // A bare link, or a link without the word skill, is not an install request.
    expect(parseSkillCommand("install https://github.com/owner/repo")).toBeNull();
    expect(parseSkillCommand("read https://github.com/owner/repo skills section")).toBeNull();
  });

  it("changes nothing on ordinary conversation", () => {
    for (const talk of [
      "how are you today",
      "I want to learn new skills this year",
      "enable dark mode",
      "disable notifications",
      "remove the duplicate lines from this text",
      "turn off the lights",
      "write a list of skills for my resume",
      "decode exit code 1603",
      "",
    ]) {
      expect(parseSkillCommand(talk), talk).toBeNull();
    }
    expect(parseSkillCommand("x".repeat(500))).toBeNull();
  });

  it("a question about the word skill that names no real skill is left to chat", async () => {
    // It has the shape of an info request, but "your best" is not a skill, so nothing is handled.
    expect(await manageSkills("what is your best skill", host())).toBeNull();
    expect(await manageSkills("tell me about the cooking skill", host())).toBeNull();
  });
});

describe("finding the skill that was meant", () => {
  it("matches by id, by name, by a single partial, and says when it is ambiguous or unknown", () => {
    expect((resolveSkill("secret scan", CATALOG) as { skill: ManagedSkill }).skill.id).toBe(
      "saf-secret-scan",
    );
    expect((resolveSkill("saf-secret-scan", CATALOG) as { skill: ManagedSkill }).skill.id).toBe(
      "saf-secret-scan",
    );
    expect((resolveSkill("SECRET SCAN", CATALOG) as { skill: ManagedSkill }).skill.id).toBe(
      "saf-secret-scan",
    );
    expect((resolveSkill("gst", CATALOG) as { skill: ManagedSkill }).skill.id).toBe("in-gst-calc");
    const twice = resolveSkill("in", [skill("a-in-1", "Inbox one"), skill("a-in-2", "Inbox two")]);
    expect("candidates" in twice && twice.candidates).toHaveLength(2);
    expect(resolveSkill("no such thing", CATALOG)).toEqual({ none: true });
  });
});

describe("the catalog answer", () => {
  it("counts what is on, off, shipped and installed, by category", () => {
    const text = describeCatalog(CATALOG);
    expect(text).toMatch(
      /6 skill\(s\) in total: 5 on, 1 off; 5 ship with FRIDAY, 1 were installed/,
    );
    expect(text).toMatch(/india \(on\): GST calculator/);
    expect(text).toMatch(/Off \(1\): Invoice total/);
  });

  it("filters by a word and says when nothing matches", () => {
    expect(describeCatalog(CATALOG, "privacy")).toMatch(/Matching "privacy": 1/);
    expect(describeCatalog(CATALOG, "zzz")).toMatch(/No skill matches "zzz"/);
  });
});

describe("managing skills", () => {
  it("lists and explains without asking anyone, and changes nothing", async () => {
    const calls: Call[] = [];
    const list = await manageSkills("what skills do you have", host("done", calls));
    expect(list).toMatchObject({ handled: true, kind: "list", ok: true });
    expect(list?.text).toMatch(/6 skill\(s\)/);
    const info = await manageSkills("what does the gst calculator skill do", host("done", calls));
    expect(info?.text).toMatch(/GST calculator \(id in-gst-calc/);
    expect(info?.text).toMatch(/ships with FRIDAY/);
    expect(calls).toEqual([]);
  });

  it("disables a skill through the approval gate, and says it is done only when it is", async () => {
    const calls: Call[] = [];
    const done = await manageSkills("disable the secret scan skill", host("done", calls));
    expect(done?.ok).toBe(true);
    expect(done?.text).toMatch(/Disabling Secret scan: done/);
    expect(calls.map((c) => c.kind)).toEqual(["gate", "setEnabled"]);
    expect(calls[0]!.detail).toBe("review:Disable skill - Secret scan");
    expect(calls[1]!.detail).toBe("saf-secret-scan:false");

    const waitingCalls: Call[] = [];
    const waiting = await manageSkills(
      "disable the secret scan skill",
      host("waiting", waitingCalls),
    );
    expect(waiting?.text).toMatch(/filed and waits for the owner's approval/);
    expect(waiting?.text).toMatch(/NOT been done yet/);
    expect(waitingCalls.map((c) => c.kind)).toEqual(["gate"]); // nothing applied behind the owner's back

    const rejected = await manageSkills("disable the secret scan skill", host("rejected"));
    expect(rejected?.ok).toBe(false);
    expect(rejected?.text).toMatch(/did not approve/);
  });

  it("enables an off skill, and leaves an unchanged one alone", async () => {
    const calls: Call[] = [];
    const on = await manageSkills("enable the invoice total skill", host("done", calls));
    expect(on?.text).toMatch(/Enabling Invoice total: done/);
    expect(calls[1]!.detail).toBe("in-invoice-total:true");
    const same = await manageSkills("enable the secret scan skill", host("done", calls));
    expect(same?.text).toMatch(/already on/);
    expect(calls).toHaveLength(2); // the second command asked nobody and changed nothing
  });

  it("removes only a skill the owner installed, with the highest-scrutiny gate; shipped ones are refused", async () => {
    const calls: Call[] = [];
    const removed = await manageSkills("remove my notes helper skill", host("done", calls));
    expect(removed?.text).toMatch(/Removing My notes helper: done/);
    expect(calls[0]!.detail).toBe("risky:Remove skill - My notes helper");
    expect(calls[1]).toEqual({ kind: "remove", detail: "my-notes" });
    const shipped: Call[] = [];
    const refused = await manageSkills("remove the secret scan skill", host("done", shipped));
    expect(refused?.ok).toBe(false);
    expect(refused?.text).toMatch(/ships with FRIDAY, so it cannot be removed/);
    expect(refused?.text).toMatch(/disable the Secret scan skill/);
    expect(shipped).toEqual([]);
  });

  it("installs from a GitHub repository only through the gate", async () => {
    const calls: Call[] = [];
    const out = await manageSkills(
      "install skills from https://github.com/owner/repo",
      host("done", calls),
    );
    expect(out?.text).toMatch(
      /Installing skills from https:\/\/github.com\/owner\/repo: done \(installed a-pack\)/,
    );
    expect(calls.map((c) => c.kind)).toEqual(["gate", "installGit"]);
    expect(calls[0]!.detail).toBe("review:Install skills from https://github.com/owner/repo");
    const waitingCalls: Call[] = [];
    await manageSkills(
      "install skills from https://github.com/owner/repo",
      host("waiting", waitingCalls),
    );
    expect(waitingCalls.map((c) => c.kind)).toEqual(["gate"]);
  });

  it("reports an unknown or ambiguous name instead of guessing", async () => {
    const none = await manageSkills("disable the flying skill", host());
    expect(none?.ok).toBe(false);
    expect(none?.text).toMatch(/No skill is called "flying"/);
    const many = host();
    many.list = async () => [skill("a-1", "Inbox one"), skill("a-2", "Inbox two")];
    const ambiguous = await manageSkills("disable the inbox skill", many);
    expect(ambiguous?.ok).toBe(false);
    expect(ambiguous?.text).toMatch(/More than one skill matches "inbox"/);
  });

  it("a built-in tool without a switch is refused by the real host's rule, and ordinary text is left alone", async () => {
    expect(await manageSkills("how are you today", host())).toBeNull();
    const failing = host();
    failing.setEnabled = async () => ({
      ok: false,
      error: "This is a built-in tool, not a skill pack, so it has no switch here.",
    });
    const out = await manageSkills("disable the web search skill", failing);
    expect(out?.ok).toBe(false);
    expect(out?.text).toMatch(/failed \(This is a built-in tool/);
  });
});

describe("wired into the chat turn", () => {
  it("skill management is answered before any skill or agent is routed, and such a turn runs neither", () => {
    const brain = readFileSync(
      path.join(__dirname, "../../src/lib/friday/brain/core-brain.ts"),
      "utf8",
    );
    const manage = brain.indexOf("manageSkillsFromPrompt(prompt)");
    const route = brain.indexOf("routeSkills(prompt)");
    const agents = brain.indexOf("routeAgents(prompt)");
    expect(manage).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(manage);
    expect(brain).toContain("const skillRuns = managed ? [] : await routeSkills(prompt)");
    expect(brain).toContain("const agentRuns = managed ? [] : await routeAgents(prompt)");
    expect(agents).toBeGreaterThan(route);
  });

  it("the real host uses the same gate and switches as the Skills page", () => {
    const source = readFileSync(
      path.join(__dirname, "../../src/lib/friday/brain/skill-manager.ts"),
      "utf8",
    );
    expect(source).toContain("governance.submit");
    expect(source).toContain('kind: "install"');
    expect(source).toContain("setCapabilityEnabled");
    expect(source).toContain("setSkillEnabled");
    expect(source).toContain("uninstallPack");
    expect(source).toContain("installSkillGit");
    // A change waiting for approval is never described as done.
    expect(source).toContain("It has NOT been done yet");
  });
});
