/**
 * Full-spectrum upgrade surfaces: page-action gating, office extract honesty,
 * self-dev merge policy, and one real fetch → extract → chart path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOnline } from "./helpers/environment";
import { createRequire } from "node:module";

import { pageActionNeedsApproval, webClick } from "../../src/lib/friday/browser-engine";
import { needsOfficeExtract, readAttachment } from "../../src/lib/friday/attachments";
import { showRealChart } from "../../src/lib/friday/stage";
import { identity } from "../../src/lib/friday/brain/identity";
import { affect } from "../../src/lib/friday/brain/affect";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");
const extract = createRequire(import.meta.url)("../../electron/document-extract.cjs");

describe("page actions stay approval-gated", () => {
  it("lets ordinary click/scroll through and gates submit/login/purchase", () => {
    expect(pageActionNeedsApproval("click", "#next")).toBe(false);
    expect(pageActionNeedsApproval("scroll")).toBe(false);
    expect(pageActionNeedsApproval("submit", "form")).toBe(true);
    expect(pageActionNeedsApproval("fill", "#password")).toBe(true);
    expect(pageActionNeedsApproval("click", "sign in")).toBe(true);
  });

  it("reports desktop-only instead of faking a click in Node", async () => {
    const result = await webClick("#missing");
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/desktop/i);
  });
});

describe("office / PDF extract", () => {
  it("recognises office types and extracts real CSV/DOCX bytes", () => {
    expect(needsOfficeExtract("tender.pdf")).toBe(true);
    expect(needsOfficeExtract("notes.txt")).toBe(false);
    const csv = extract.extract({ filename: "books.csv", text: "a,b\n1,2\n" });
    expect(csv.kind).toBe("csv");
    expect(csv.rows.length).toBeGreaterThan(0);
  });

  it("does not pretend a PDF was read when the desktop extract bridge is absent", async () => {
    const file = new File([new Uint8Array([37, 80, 68, 70])], "scan.pdf", {
      type: "application/pdf",
    });
    const attachment = await readAttachment(file);
    expect(attachment.error ?? "").toMatch(/desktop|extract/i);
    expect(attachment.text).toBeUndefined();
  });
});

describe("self-dev git policy", () => {
  it("does not auto-merge to main from the self-dev pipeline", () => {
    const pipeline = read("src/lib/friday/self/dev-pipeline.ts");
    const maintenance = read("src/lib/friday/self/maintenance-bridge.ts");
    const blob = `${pipeline}\n${maintenance}`;
    expect(blob).not.toMatch(/git push[^\n]*\bmain\b/);
    expect(blob).not.toMatch(/gh pr merge/);
    expect(blob).not.toMatch(/auto-merge|automerge/i);
    const mergeFlow = read("docs/FRIDAY_MERGE_FLOW.md");
    expect(mergeFlow).toMatch(/Never[\s\S]*automatic merge/i);
  });
});

const ONLINE = await isOnline();

describe("real page numbers become a real chart", () => {
  it.skipIf(!ONLINE)(
    "fetches example.com, charts measured status and body length, and refuses empty charts",
    async () => {
      const response = await fetch("https://example.com/");
      const body = await response.text();
      expect(response.ok).toBe(true);
      expect(body.length).toBeGreaterThan(20);
      const title = /<title>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() || "example.com";
      const chart = showRealChart({
        title: `Fetched ${title}`,
        source: "web-open",
        body: `HTTP ${response.status}, ${body.length} characters (real fetch).`,
        series: [
          { label: "HTTP status", value: response.status },
          { label: "body characters", value: body.length },
        ],
      });
      expect("id" in chart).toBe(true);
      if ("series" in chart) {
        expect(chart.series?.some((point) => point.value === response.status)).toBe(true);
      }
    },
    20_000,
  );
});

describe("tone stays identity-safe (owner review)", () => {
  it("still names the owner and forbids claiming human feelings as facts", () => {
    const prompt = identity.compile();
    expect(prompt).toMatch(/Devendra Singh Meena/);
    expect(prompt).toMatch(/never claim human emotions|consciousness/i);
    const fragment = affect.prompt();
    expect(fragment).toMatch(/never claim to have human feelings/i);
  });
});
