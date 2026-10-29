/**
 * Every control on the Models page and AI settings calls a real handler.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");
const files = ["src/routes/models.tsx", "src/components/friday/settings/AISettings.tsx"];

function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${name}\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let i = match.index + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < source.length; i += 1) {
      const char = source[i]!;
      if (quote) {
        if (char === "\\") {
          i += 1;
          continue;
        }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) {
        tags.push(source.slice(match.index, i + 1));
        break;
      }
    }
  }
  return tags;
}

describe("models controls are wired", () => {
  for (const file of files) {
    it(`${file} has no dead buttons, switches, or selects`, () => {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source).not.toMatch(/onClick=\{\s*\(\)\s*=>\s*\{\s*\}\s*\}/);
      expect(source).not.toMatch(/onClick=\{\s*\(\)\s*=>\s*(undefined|null)\s*\}/);
      expect(source).not.toMatch(/onCheckedChange=\{\s*\(\)\s*=>\s*\{\s*\}\s*\}/);
      const buttons = openingTags(source, "Button");
      const switches = openingTags(source, "Switch");
      const selects = openingTags(source, "select");
      expect(buttons.length).toBeGreaterThan(0);
      for (const tag of buttons) {
        expect(tag, tag).toMatch(/onClick=/);
        expect(tag).not.toMatch(/\sdisabled(?:\s|>|=\{true\})/);
      }
      for (const tag of switches) {
        expect(tag, tag).toMatch(/onCheckedChange=/);
        expect(tag).not.toMatch(/\sdisabled(?:\s|>|=\{true\})/);
      }
      for (const tag of selects) {
        expect(tag, tag).toMatch(/onChange=/);
      }
    });
  }
});
