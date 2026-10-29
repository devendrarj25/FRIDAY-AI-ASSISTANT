import { describe, expect, it } from "vitest";
import { detectDependencies, detectKind } from "../../src/lib/friday/hub-engine";

describe("friday hub · content recognition", () => {
  it("identifies FRIDAY areas from the real install paths", () => {
    expect(detectKind(["plugins/installed/foo/index.js"])).toBe("plugin");
    expect(detectKind(["skills/custom/summarise.py"])).toBe("skill");
    expect(detectKind(["agents/custom/researcher.ts"])).toBe("agent");
    expect(detectKind(["workflows/saved/flow.json"])).toBe("workflow");
    expect(detectKind(["modules/custom/thing/main.py"])).toBe("module");
  });

  it("falls back to content and naming when there is no FRIDAY layout", () => {
    expect(detectKind(["weights/model.gguf"])).toBe("model");
    expect(detectKind(["src/index.ts", "manifest.json"])).toBe("module");
    expect(detectKind(["src/index.ts"], { name: "voice-plugin" })).toBe("plugin");
    expect(detectKind(["readme.md"])).toBe("unknown");
    expect(detectKind(["pack/skill.json"])).toBe("skill");
    expect(detectKind(["pack/tool.json"])).toBe("tool");
    expect(detectKind(["pack/agent.json"])).toBe("agent");
  });

  it("reads declared dependencies from manifest files only", () => {
    expect(detectDependencies(["package.json", "src/a.ts"])).toContain("Node.js");
    expect(detectDependencies(["requirements.txt"])).toContain("Python");
    expect(detectDependencies(["weights/m.gguf"])).toContain("Local model runtime");
    expect(detectDependencies(["readme.md"])).toEqual([]);
  });
});
