import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  VoiceTargetsOverlay,
  type VoiceTargetsOverlayProps,
} from "../../src/components/friday/VoiceTargetsOverlay";

const base: VoiceTargetsOverlayProps = {
  enabled: true,
  targets: [
    { n: 2, name: "Cancel", role: "button" },
    { n: 1, name: "Save", role: "button" },
  ],
  state: "ready",
  onRetry: () => undefined,
  onClose: () => undefined,
};
const html = (over: Partial<VoiceTargetsOverlayProps> = {}) =>
  renderToStaticMarkup(createElement(VoiceTargetsOverlay, { ...base, ...over }));

describe("VoiceTargetsOverlay", () => {
  it("renders nothing unless enabled", () => {
    expect(html({ enabled: false })).toBe("");
  });

  it("handoff shows no target names even when targets are passed", () => {
    const out = html({ state: "handoff" });
    expect(out).not.toContain("Save");
    expect(out).not.toContain("Cancel");
    expect(out).toContain("A secure prompt needs you. I will not look at it.");
  });

  it("keeps a hostile name as inert text", () => {
    const out = html({ targets: [{ n: 1, name: "<img src=x onerror=alert(1)>", role: "button" }] });
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("labels each chip and orders by number", () => {
    const out = html();
    expect(out).toContain('aria-label="1, Save, button"');
    expect(out.indexOf("1, Save")).toBeLessThan(out.indexOf("2, Cancel"));
    expect(out).toContain('role="status"');
    expect(out).toContain("Close");
  });

  it("caps the chips at 30", () => {
    const targets = Array.from({ length: 45 }, (_, i) => ({
      n: i + 1,
      name: `T${i}`,
      role: "link",
    }));
    const out = html({ targets });
    expect(out.match(/<li /g)?.length).toBe(30);
  });

  it("shows loading, empty, offline and error with Retry", () => {
    expect(html({ state: "loading" })).toContain('aria-busy="true"');
    expect(html({ targets: [] })).toContain("Nothing here I can click safely");
    expect(html({ state: "offline" })).toContain("offline");
    const err = html({ state: "error", error: "boom" });
    expect(err).toContain("Retry");
    expect(err).toContain("boom");
  });

  it("wires Retry to onRetry once", () => {
    const onRetry = vi.fn();
    const tree = VoiceTargetsOverlay({ ...base, state: "error", onRetry }) as {
      props: { children: unknown[] };
    };
    const errorState = tree.props.children[1] as { props: { onRetry: () => void } };
    errorState.props.onRetry();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
