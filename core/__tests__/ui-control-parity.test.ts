/**
 * "No feature removed" guard for the UI redesign. Every control label that
 * existed in src/routes and src/components/friday before the upgrade must
 * still exist somewhere in that source (it may move between files, into a
 * shared primitive or a More menu). The only exception is a reviewed rename
 * listed below with the same meaning. Icon-only buttons must carry a name.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import baseline from "../fixtures/ui-control-baseline.json";
import {
  collectLabels,
  controlFiles,
  controlLabels,
  deadControls,
  iconOnlyWithoutName,
} from "./helpers/ui-controls";

const ROOT = process.cwd();

/** Reviewed renames: old label → new label with the same meaning. */
export const RENAMES: Record<string, string> = {
  // The import run chips were a bare "· v ·" text artefact of the
  // "{name} · v{version} · {status}" label; they are now FilterTabs whose
  // label is built from the same three fields, above the Pipeline panel.
  "· v ·": "Pipeline",
};

describe("UI control parity", () => {
  const now = collectLabels(ROOT);

  it("keeps every baseline control label (or its reviewed rename)", () => {
    const missing = baseline.labels.filter((label) => {
      if (now[label]) return false;
      const renamed = RENAMES[label];
      return !(renamed && now[renamed]);
    });
    expect(missing).toEqual([]);
  });

  it("has a real baseline", () => {
    expect(baseline.labels.length).toBeGreaterThan(1000);
    for (const label of [
      "Stop everything",
      "Chat does not use the microphone. Auto mode listens.",
      "Pause listening",
      "Reset microphone",
    ]) {
      expect(baseline.labels).toContain(label);
    }
  });

  it("gives every icon-only button an aria-label or title", () => {
    const offenders: string[] = [];
    for (const file of controlFiles(ROOT)) {
      for (const el of iconOnlyWithoutName(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(ROOT, file)}:${el.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no button with an empty or missing handler", () => {
    const offenders: string[] = [];
    for (const file of controlFiles(ROOT)) {
      for (const el of deadControls(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(ROOT, file)}:${el.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("flags a dead control and keeps a live one", () => {
    const src = `
      <button className="x">Nothing</button>
      <Button onClick={() => {}}>Empty</Button>
      <Button onClick={go}>Live</Button>
      <button type="submit">Send</button>
      <DropdownMenuTrigger asChild><Button>Menu</Button></DropdownMenuTrigger>`;
    expect(deadControls(src).map((el) => el.line)).toEqual([2, 3]);
  });

  it("reads labels the way the guard expects", () => {
    const src = `
      <Button title="Copy transcript"><Copy /></Button>
      <button aria-label="Close">{x}</button>
      <ToggleRow label="Neon glow" />
      <Button onClick={go}><Send className="size-3" /> Send</Button>
      const tools = [{ id: "a", label: "Voice flow" }];
      <button onClick={() => a > b}><X /></button>`;
    const labels = controlLabels(src);
    for (const label of ["Copy transcript", "Close", "Neon glow", "Send", "Voice flow"]) {
      expect(labels).toContain(label);
    }
    expect(iconOnlyWithoutName(src)).toHaveLength(1);
  });
});
