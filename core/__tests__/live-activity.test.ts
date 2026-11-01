import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activityLine,
  describeActivity,
  subjectOf,
} from "../../src/lib/friday/brain/live-activity";

const step = (nodeId: string, detail = "", label = "Step") => ({ nodeId, detail, label });

describe("live activity", () => {
  it("says nothing when no work is running", () => {
    expect(describeActivity(null)).toBeNull();
  });

  it("names the real work from the step detail", () => {
    expect(describeActivity(step("agents.tools", "web search: weather in Jaipur"))?.verb).toBe(
      "Searching the web",
    );
    expect(describeActivity(step("execution.runners", "reading “report.pdf”"))?.verb).toBe(
      "Reading report.pdf",
    );
    expect(describeActivity(step("execution.runners", "zipping notes.zip"))?.kind).toBe("zipping");
    expect(describeActivity(step("execution.runners", "unzipping notes.zip"))?.kind).toBe(
      "unzipping",
    );
    expect(describeActivity(step("execution.runners", "writing summary.md"))?.verb).toBe(
      "Writing summary.md",
    );
  });

  it("falls back to what the node does, then to the step's own label", () => {
    expect(describeActivity(step("thinking.planner"))?.verb).toBe("Planning the steps");
    expect(describeActivity(step("router.select"))?.verb).toBe("Choosing a model");
    expect(describeActivity(step("unknown.node", "", "Custom stage"))?.verb).toBe("Custom stage");
  });

  it("turns a long model step into writing once the answer is streaming", () => {
    expect(describeActivity(step("router.select"), { streaming: true })?.verb).toBe(
      "Writing the answer",
    );
  });

  it("gives the work a matching mood and shows the time of a long step", () => {
    const search = describeActivity(step("agents.tools", "web search"));
    expect(search?.emotion).toBe("Curious");
    expect(activityLine(search!, 2000)).toBe("Searching the web…");
    expect(activityLine(search!, 12_400)).toBe("Searching the web… 12s");
  });

  it("finds a file or a quoted name as the subject", () => {
    expect(subjectOf("opened D:\\docs\\plan.docx")).toBe("plan.docx");
    expect(subjectOf("nothing named here")).toBe("");
  });

  it("is wired into the chat chip, the graphic, and the conversation captions", () => {
    expect(readFileSync("src/components/friday/TurnTrace.tsx", "utf8")).toContain(
      "describeActivity",
    );
    expect(readFileSync("src/lib/friday/use-friday-live.ts", "utf8")).toContain("describeActivity");
    const auto = readFileSync("src/components/friday/AutoMode.tsx", "utf8");
    expect(auto).toContain('caption.tag !== "ambient"');
  });
});
