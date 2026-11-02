import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextLabel, nameIfMissing } from "../../src/lib/friday/accessible-name";

type FakeEl = {
  tagName: string;
  textContent: string;
  attrs: Record<string, string>;
  previousElementSibling: FakeEl | null;
  parentElement: FakeEl | null;
  labels?: unknown[];
  querySelector: (selector: string) => unknown;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
};

function el(tag: string, text = "", attrs: Record<string, string> = {}): FakeEl {
  const node: FakeEl = {
    tagName: tag,
    textContent: text,
    attrs: { ...attrs },
    previousElementSibling: null,
    parentElement: null,
    querySelector: () => null,
    getAttribute: (name) => node.attrs[name] ?? null,
    setAttribute: (name, value) => {
      node.attrs[name] = value;
    },
  };
  return node;
}

/** `<div><p>label</p><div><input></div></div>` */
function field(label: string, controlAttrs: Record<string, string> = {}) {
  const wrap = el("DIV");
  const p = el("P", label);
  const inner = el("DIV");
  const input = el("INPUT", "", controlAttrs);
  p.parentElement = wrap;
  inner.parentElement = wrap;
  inner.previousElementSibling = p;
  input.parentElement = inner;
  return { input, p };
}

describe("a control with no name takes the label that comes before it", () => {
  it("reads the label before the control's wrapper", () => {
    const { input } = field("Voice speed");
    expect(contextLabel(input as never)).toBe("Voice speed");
    nameIfMissing(input as never);
    expect(input.attrs["aria-label"]).toBe("Voice speed");
  });

  it("leaves a control that already has a name alone", () => {
    for (const attrs of [
      { "aria-label": "Mine" },
      { "aria-labelledby": "x" },
      { placeholder: "Type here" },
      { title: "Hint" },
    ]) {
      const { input } = field("Other", attrs);
      nameIfMissing(input as never);
      expect(input.attrs["aria-label"]).toBe(attrs["aria-label"]);
    }
    const { input } = field("Other");
    input.labels = [{}];
    nameIfMissing(input as never);
    expect(input.attrs["aria-label"]).toBeUndefined();
  });

  it("does not take a value or a number as a name, nor a block that holds other controls", () => {
    const { input, p } = field("12 ms");
    expect(contextLabel(input as never)).toBe("");
    p.textContent = "Mode";
    p.querySelector = () => ({});
    expect(contextLabel(input as never)).toBe("");
  });
});

describe("the shared fields name themselves", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("passes the visible label to the input, the select and the slider", () => {
    const fields = read("src/components/friday/settings/fields.tsx");
    expect(fields.match(/aria-label=\{label\}/g)?.length).toBe(3);
  });

  it("falls back to the context label in Input, Textarea and the slider thumb", () => {
    for (const file of ["input", "textarea", "slider"]) {
      expect(read(`src/components/ui/${file}.tsx`), file).toContain("nameIfMissing");
    }
  });

  it("keeps controls named as pages change, once per quiet period and not while hidden", () => {
    expect(read("src/components/friday/AppShell.tsx")).toContain(
      "watchControlNames(document.body)",
    );
    const util = read("src/lib/friday/accessible-name.ts");
    expect(util).toContain("document.hidden");
    expect(util).toContain("requestIdleCallback");
  });

  it("lets Escape answer NO on the spoken-command confirmation, and nothing answers YES by key", () => {
    const card = read("src/components/friday/VoiceTranscript.tsx");
    expect(card).toMatch(/event\.key === "Escape"[\s\S]{0,120}confirmPending\(false\)/);
    expect(card).not.toMatch(/Enter[\s\S]{0,80}confirmPending\(true\)/);
  });
});
