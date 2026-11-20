/**
 * Controls fit their boxes. Found by looking at the real window (Windows, 125% scale, Glass style) and in headless
 * Chromium on the built renderer:
 *  - the switch thumb moved twice (Tailwind's `translate` and the Glass `transform`; the minifier dropped the
 *    `translate: none` that was meant to cancel one) and stuck out of its track over the next card's title;
 *  - the Glass style gives every FRIDAY button a 32 px minimum, so a 24 px box that clips its children (the autonomy
 *    dial, the caption size switch) cut its own text low and showed a half-clipped selected pill;
 *  - a full-height page put a `h-full` child after its header, so the page ended below the window;
 *  - a compact node summary was one line and ended in "6 r…".
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const css = read("src/styles.css");

/** The body of the first rule whose selector list contains `selector` exactly. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  // Comments are not rules: strip them so a note that quotes a property is not read as the property.
  return css.slice(at, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the switch", () => {
  it("slides its thumb with one property, inside the track, in both states", () => {
    const thumb = rule('html[data-ui-style="glass"] .friday-switch-thumb');
    expect(thumb).toContain("translate: 0 0;");
    expect(thumb).toContain("transform: none;");
    expect(thumb).not.toContain("translate: none");
    const checked = css.slice(
      css.indexOf(
        'html[data-ui-style="glass"] .friday-switch[aria-checked="true"] .friday-switch-thumb',
      ),
    );
    expect(checked.slice(0, 400)).toContain("translate: 1.25rem 0;");
    expect(css).not.toMatch(/\.friday-switch-thumb \{[^}]*transform: translateX\(1\.25rem\)/);
    // Track 2.75rem; the thumb is 1.25rem, starts 2px in and slides 1.25rem: it ends 2px inside the track's edge.
    const track = rule('html[data-ui-style="glass"] .friday-switch');
    expect(track).toContain("width: 2.75rem;");
    expect(thumb).toContain("width: 1.25rem;");
    expect(thumb).toContain("left: 2px;");
    const px = (rem: number) => rem * 16;
    expect(2 + px(1.25) + px(1.25)).toBeLessThanOrEqual(px(2.75));
  });
});

describe("compact controls in a box that clips", () => {
  it("the autonomy dial grows to the 32 px button minimum in Glass, so its text is centred and not cut", () => {
    const dial = read("src/components/friday/AutonomyDial.tsx");
    expect(dial).toContain("[html[data-ui-style='glass']_&]:h-8");
  });

  it("the caption size switch is neither fixed at 24 px nor clipped in Glass, and its buttons match the strip", () => {
    const bar = read("src/components/friday/VoiceControlBar.tsx");
    const at = bar.indexOf("voice-level-switch friday-seg");
    const line = bar.slice(at, bar.indexOf('"', at));
    expect(line).not.toMatch(/(^|\s)h-6(\s|$)/);
    expect(line).not.toMatch(/(^|\s)overflow-hidden(\s|$)/);
    expect(line).toContain("[html:not([data-ui-style='glass'])_&]:h-6");
    expect(
      rule('html[data-ui-style="glass"] .voice-level-switch.friday-seg > [role="radio"]'),
    ).toContain("min-height: 1.5rem;");
  });
});

describe("a full-height page", () => {
  it("is a column: the header keeps its height and the page takes what is left", () => {
    const shell = read("src/components/friday/AppShell.tsx");
    expect(shell).toContain('fill ? "flex flex-col overflow-hidden"');
    expect(shell).toContain('<div className="min-h-0 flex-1">{children}</div>');
    expect(shell).not.toContain('<div className="h-full min-h-0">{children}</div>');
    expect(shell).toContain("page-header mb-3 flex min-w-0 shrink-0");
  });
});

describe("the live node cards", () => {
  it("a long summary wraps to a second line and keeps the full text in the tooltip", () => {
    const circuit = read("src/components/friday/NeuralCircuit.tsx");
    expect(circuit).toContain('"line-clamp-2 break-words font-mono leading-tight"');
    expect(circuit).toContain("title={active ? node.action : node.status}");
  });
});
