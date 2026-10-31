import { describe, expect, it } from "vitest";
import { filesLine } from "../../src/lib/friday/folder-watch";
import { buildDigest } from "../../src/lib/friday/proactive-digest";

describe("new files in shared folders", () => {
  it("says nothing when nothing arrived", () => {
    expect(filesLine([])).toBeNull();
  });

  it("groups files by folder in one line", () => {
    const line = filesLine([
      { folder: "Downloads", name: "a.pdf", new: true },
      { folder: "Downloads", name: "b.pdf", new: true },
      { folder: "Downloads", name: "c.pdf", new: true },
      { folder: "proj", name: "x.txt", new: true },
    ]);
    expect(line).toBe("New files: Downloads: a.pdf, b.pdf and 1 more; proj: x.txt.");
  });

  it("reaches the digest and keeps a quiet day quiet", () => {
    const base = { now: 0, tasks: [], pendingApprovals: 0, failedRuns: [], unreadAlerts: 0 };
    expect(buildDigest({ ...base, newFilesLine: "New files: proj: x.txt." }).lines).toContain(
      "New files: proj: x.txt.",
    );
    expect(buildDigest({ ...base, newFilesLine: null }).quiet).toBe(true);
  });
});
