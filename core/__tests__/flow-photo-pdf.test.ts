/**
 * FRIDAY · photo diagrams and the real PDF export.
 *
 * Fixtures are drawn in memory. No network, no clock date, and no git history.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { encode as encodeJpeg } from "jpeg-js";
import { hasCommand } from "./helpers/environment";
import { boxesFromTesseractTsv, textInBox } from "../../src/lib/friday/diagram-ocr";
import {
  blankRaster,
  encodeRasterPng,
  readPhotoDiagram,
  strokeLine,
  strokeRect,
} from "../../src/lib/friday/diagram-raster";
import { buildFromDiagram, readDiagram } from "../../src/lib/friday/flow-diagram";
import { exportPdf, pdfPageCount, pdfPlainText } from "../../src/lib/friday/flow-pdf";
import { nodeOf, type FlowGraph } from "../../src/lib/friday/flow-graph";

const require_ = createRequire(import.meta.url);
const diagramOcr = require_("../../electron/diagram-ocr.cjs") as {
  recognize: (bytes: Buffer) => { ok: boolean; error?: string; tsv?: string };
};

function stack(): Uint8Array {
  const raster = blankRaster(90, 240);
  strokeRect(raster, 16, 12, 58, 36, 4);
  strokeRect(raster, 16, 96, 58, 36, 4);
  strokeRect(raster, 16, 180, 58, 36, 4);
  strokeLine(raster, 45, 48, 45, 96, 4);
  strokeLine(raster, 45, 132, 45, 180, 4);
  return encodeRasterPng(raster);
}

const TSV = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "5\t1\t1\t1\t1\t1\t20\t16\t40\t20\t92\tStart",
  "5\t1\t1\t1\t2\t1\t20\t100\t40\t20\t88\tMiddle",
  "5\t1\t1\t1\t3\t1\t20\t184\t40\t20\t91\tEnd",
].join("\n");

describe("photo diagrams", () => {
  it("reads drawn boxes and keeps an unlabeled photo uncertain", () => {
    const bytes = stack();
    const photo = readPhotoDiagram(bytes);
    expect(photo.decoded).toBe(true);
    expect(photo.boxes.length).toBe(3);
    expect(photo.links.length).toBe(2);
    const unread = readDiagram({
      name: "shot.png",
      mime: "image/png",
      bytes,
      sensitive: true,
      cloudAllowed: true,
      ownerOptIn: true,
    });
    expect(unread.route).toBe("local");
    expect(unread.graph.nodes).toHaveLength(3);
    expect(unread.graph.edges).toHaveLength(0);
    expect(unread.uncertain).toHaveLength(3);
    expect(unread.explanation.toLowerCase()).not.toContain("not read");
  });

  it("names boxes from a local OCR callback and blocks the forge while uncertain", async () => {
    const bytes = stack();
    const words = boxesFromTesseractTsv(TSV);
    expect(words.map((word) => word.text)).toEqual(["Start", "Middle", "End"]);
    expect(textInBox(words, { x: 16, y: 12, width: 58, height: 36 }).text).toBe("Start");
    const named = readDiagram({
      name: "shot.png",
      mime: "image/png",
      bytes,
      words,
    });
    expect(named.graph.nodes.map((node) => node.label)).toEqual(["Start", "Middle", "End"]);
    expect(named.graph.edges).toHaveLength(2);
    expect(named.uncertain).toEqual([]);
    expect(named.route).toBe("local");
    const blank = readDiagram({
      name: "blank.png",
      mime: "image/png",
      bytes: encodeRasterPng(blankRaster(32, 32)),
    });
    expect(blank.uncertain).toContain("diagram.unread");
    let calls = 0;
    const blocked = await buildFromDiagram(unreadGraph(), {
      forge: async () => {
        calls += 1;
        return { stage: "done", log: [] };
      },
    });
    expect(calls).toBe(0);
    expect(blocked.called).toBe(false);
  });

  it("decodes a JPEG of the same drawing", () => {
    const raster = blankRaster(90, 240);
    strokeRect(raster, 16, 12, 58, 36, 4);
    strokeRect(raster, 16, 96, 58, 36, 4);
    strokeRect(raster, 16, 180, 58, 36, 4);
    strokeLine(raster, 45, 48, 45, 96, 4);
    strokeLine(raster, 45, 132, 45, 180, 4);
    const jpeg = encodeJpeg({ data: raster.rgba, width: raster.width, height: raster.height }, 95);
    const read = readDiagram({
      name: "shot.jpg",
      mime: "image/jpeg",
      bytes: jpeg.data,
      ocr: () => ({ text: "Box", confidence: 0.92 }),
    });
    expect(read.graph.nodes.length).toBeGreaterThanOrEqual(3);
    expect(read.explanation.toLowerCase()).not.toContain("not read");
  });
});

function unreadGraph(): FlowGraph {
  return readDiagram({
    name: "shot.png",
    mime: "image/png",
    bytes: stack(),
  }).graph;
}

describe("diagram OCR host", () => {
  it("says when Tesseract is not installed and never throws", () => {
    expect(diagramOcr.recognize(Buffer.alloc(0))).toEqual({ ok: false, error: "no image" });
    const result = diagramOcr.recognize(Buffer.from(stack()));
    if (!hasCommand("tesseract")) {
      expect(result).toEqual({ ok: false, error: "Tesseract OCR is not installed" });
      return;
    }
    expect(result.ok === true || typeof result.error === "string").toBe(true);
  });
});

describe("flow PDF", () => {
  it("embeds Hindi, keeps every node, and uses more than one page", async () => {
    const nodes = Array.from({ length: 45 }, (_, index) =>
      nodeOf({
        id: `n${index}`,
        kind: "note",
        label: index === 0 ? "संदेश" : `Node ${index}`,
        module: "src/lib/friday/flow-pdf.ts",
        source: { adapter: "diagram", ref: `n${index}` },
      }),
    );
    const graph: FlowGraph = {
      version: 1,
      id: "pdf",
      title: "Pages",
      trusted: true,
      nodes,
      edges: [],
      groups: [],
    };
    const bytes = await exportPdf(graph);
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toMatch(/^%PDF-1\./);
    expect(await pdfPageCount(bytes)).toBeGreaterThan(1);
    const text = pdfPlainText(bytes);
    expect(text).toContain("संदेश");
    expect(text).toContain("Node 44");
    expect(text).toContain("Shape and words carry the status");
  });
});
