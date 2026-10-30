/** The clinic and brain check panels render their empty states first, with no window and no network. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrainCheckPanel, ErrorClinicPanel } from "../../src/components/friday/ErrorClinicPanels";

describe("error clinic and brain check panels", () => {
  it("clinic starts empty and says the pasted text is only read", () => {
    const html = renderToStaticMarkup(createElement(ErrorClinicPanel));
    expect(html).toContain("Nothing pasted yet");
    expect(html).toContain("never run");
  });

  it("brain check starts unrun, with a Run control and no number shown", () => {
    const html = renderToStaticMarkup(createElement(BrainCheckPanel));
    expect(html).toContain("Not run yet");
    expect(html).toContain("Run");
    expect(html).not.toContain("tasks ·");
  });
});

describe("format atlas panel", () => {
  it("lists every kind with its gaps in words", async () => {
    const { FormatAtlasPanel } = await import("../../src/components/friday/FormatAtlasPanel");
    const html = renderToStaticMarkup(createElement(FormatAtlasPanel));
    expect(html).toContain("What I can read and make");
    expect(html).toContain("Word documents");
    expect(html).toContain("partly");
    expect(html).toContain("not yet");
    expect(html).toContain("generating new video from a prompt is not built");
  });
});

describe("model comparison panel", () => {
  it("says it needs the desktop app, and asks nothing until the button is pressed", async () => {
    const { ModelComparePanel } = await import("../../src/components/friday/ErrorClinicPanels");
    const html = renderToStaticMarkup(createElement(ModelComparePanel));
    expect(html).toContain("Brain against my model");
    expect(html).toContain("Needs the desktop app");
  });
});
