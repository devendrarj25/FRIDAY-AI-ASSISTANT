/**
 * Friday Hub chat reuses ImportChat's Core Brain pattern and stays grounded
 * in live Hub git data. It never checks whether FRIDAY herself is out of date.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  describeHubSession,
  interpretHubPrompt,
  parseProposedFiles,
  handleHubIntent,
  type HubChatSnapshot,
} from "../../src/lib/friday/hub-chat";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const snap: HubChatSnapshot = {
  workspace: {
    ok: true,
    repo: true,
    branch: "feature/demo",
    connectedRepo: "acme/scratch",
    hubRole: "linked",
    dirty: 1,
    changes: [{ state: "M", path: "hello.txt" }],
  },
  diff: "diff --git a/hello.txt b/hello.txt\n+second repo\n",
  validation: {
    ok: true,
    summary: "1 check(s) passed.",
    results: [{ id: "test", label: "Tests", state: "passed" }],
  },
  history: [{ sha: "abc", short: "abc1234", author: "owner", date: "2026-09-07", subject: "init" }],
};

describe("Hub chat grounding", () => {
  it("classifies review / validate / history / diff / fix without inventing", () => {
    expect(interpretHubPrompt("review this diff")).toEqual({ type: "review" });
    expect(interpretHubPrompt("does this look safe to merge")).toEqual({ type: "review" });
    expect(interpretHubPrompt("fix the failing test before I push")).toEqual({ type: "validate" });
    expect(interpretHubPrompt("show commit history")).toEqual({ type: "history" });
    expect(interpretHubPrompt("what is the diff")).toEqual({ type: "diff" });
    expect(interpretHubPrompt("apply that patch")).toEqual({ type: "fix" });
  });

  it("describes only the supplied live session", () => {
    const text = describeHubSession(snap);
    expect(text).toContain("acme/scratch");
    expect(text).toContain("feature/demo");
    expect(text).toContain("hello.txt");
    expect(text).toContain("1 check(s) passed");
    expect(text).not.toContain("githubCheck");
  });

  it("parses fenced file proposals and refuses a silent invent-a-fix", async () => {
    const parsed = parseProposedFiles("```\nhello.txt\nfixed\n```");
    expect(parsed).toEqual([{ file: "hello.txt", content: "fixed\n" }]);
    const reply = await handleHubIntent("apply that", snap);
    expect(reply.grounded).toBe(true);
    expect(reply.text).toMatch(/no proposed file patch|waiting for your approval|Governance/i);
  });

  it("returns the live validation summary instead of inventing one", async () => {
    const reply = await handleHubIntent("validate before I push", snap);
    expect(reply.grounded).toBe(true);
    expect(reply.text).toContain("1 check(s) passed");
  });
});

describe("Hub chat sources stay off the Updates self-check", () => {
  it("does not call githubCheck / checkForUpdates / checkAllUpdates", () => {
    for (const file of [
      "src/lib/friday/hub-chat.ts",
      "src/components/friday/hub/HubChat.tsx",
      "src/routes/hub.tsx",
      "src/lib/friday/hub-repos.ts",
    ]) {
      const src = read(file);
      expect(src).not.toContain("githubCheck(");
      expect(src).not.toContain("checkForUpdates(");
      expect(src).not.toContain("checkAllUpdates(");
    }
    expect(read("src/lib/friday/import-chat.ts")).toContain("brain.send");
    expect(read("src/lib/friday/hub-chat.ts")).toContain("brain.send");
    expect(read("src/lib/friday/hub-chat.ts")).toContain('kind: "code-change"');
  });
});
