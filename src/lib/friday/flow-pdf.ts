/**
 * FRIDAY · flow PDF.
 *
 * One multi-page PDF of the same graph the canvas draws. Latin uses the
 * standard Helvetica face. Devanagari is embedded from the bundled Noto face
 * so Hindi survives a round trip. There is no node cap.
 */

import regeneratorRuntime from "regenerator-runtime";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import * as fontkitModule from "@pdf-lib/fontkit";
import { unzlibSync } from "fflate";
import fontInline from "./fonts/NotoSansDevanagari-Regular.ttf?inline";
import { flowLine } from "./flow-copy";
import type { FlowGraph } from "./flow-graph";

const runtime = globalThis as { regeneratorRuntime?: object };
if (!runtime.regeneratorRuntime) runtime.regeneratorRuntime = regeneratorRuntime;

type FontkitEngine = Parameters<PDFDocument["registerFontkit"]>[0];

function fontkitEngine(): FontkitEngine {
  const bag = fontkitModule as unknown as FontkitEngine & { default?: FontkitEngine };
  if (typeof (bag as { create?: unknown }).create === "function") return bag;
  if (bag.default && typeof (bag.default as { create?: unknown }).create === "function") {
    return bag.default;
  }
  return bag;
}

/** Canvas token colors from the default theme in styles.css. */
export const FLOW_ROLE_OKLCH = {
  control: "oklch(0.79 0.15 213)",
  data: "oklch(0.85 0.2 150)",
  event: "oklch(0.84 0.025 225)",
  approval: "oklch(0.65 0.22 22)",
} as const;

const PAGE_W = 612;
const PAGE_H = 792;
const ROWS = 22;

type Rgb = { r: number; g: number; b: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function gamma(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** CSS Color 4 OKLab conversion, enough to paint the canvas role colors. */
export function oklchToRgb(spec: string): Rgb {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(spec);
  const L = Number(match?.[1] ?? 0);
  const C = Number(match?.[2] ?? 0);
  const H = Number(match?.[3] ?? 0);
  const hue = (H * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const ROLE_RGB = {
  control: oklchToRgb(FLOW_ROLE_OKLCH.control),
  data: oklchToRgb(FLOW_ROLE_OKLCH.data),
  event: oklchToRgb(FLOW_ROLE_OKLCH.event),
  approval: oklchToRgb(FLOW_ROLE_OKLCH.approval),
};

function paint(color: Rgb) {
  return rgb(color.r, color.g, color.b);
}

function fontBytes(): Uint8Array {
  const comma = fontInline.indexOf(",");
  const body = fontInline.slice(comma + 1);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Run = { font: "latin" | "dev"; text: string };

function runs(text: string): Run[] {
  const out: Run[] = [];
  let buf = "";
  let mode: Run["font"] | "" = "";
  for (const ch of text) {
    const next: Run["font"] = /[\u0900-\u097F]/.test(ch) ? "dev" : "latin";
    if (mode && next !== mode) {
      out.push({ font: mode, text: buf });
      buf = "";
    }
    mode = next;
    buf += ch;
  }
  if (buf && mode) out.push({ font: mode, text: buf });
  return out;
}

function drawMixed(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  latin: PDFFont,
  dev: PDFFont,
  color: Rgb,
): void {
  let cursor = x;
  for (const run of runs(text)) {
    const face = run.font === "dev" ? dev : latin;
    page.drawText(run.text, { x: cursor, y, size, font: face, color: paint(color) });
    cursor += face.widthOfTextAtSize(run.text, size);
  }
}

function legend(page: PDFPage, latin: PDFFont, dev: PDFFont): number {
  const ink = { r: 0.1, g: 0.12, b: 0.16 };
  drawMixed(page, flowLine("legend"), 48, 752, 11, latin, dev, ink);
  drawMixed(page, flowLine("legend", "hi"), 48, 736, 11, latin, dev, ink);
  const roles = [
    ["control", ROLE_RGB.control],
    ["data", ROLE_RGB.data],
    ["event", ROLE_RGB.event],
    ["approval", ROLE_RGB.approval],
  ] as const;
  roles.forEach(([name, color], index) => {
    const x = 48 + index * 130;
    page.drawRectangle({ x, y: 712, width: 18, height: 8, color: paint(color) });
    drawMixed(page, name, x + 24, 712, 10, latin, dev, ink);
  });
  drawMixed(
    page,
    "solid control · dashed data · dotted event · double approval",
    48,
    696,
    9,
    latin,
    dev,
    ink,
  );
  return 676;
}

export async function exportPdf(graph: FlowGraph): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitEngine());
  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  const dev = await pdf.embedFont(fontBytes());
  const nodes = graph.nodes;
  const pages = Math.max(1, Math.ceil(nodes.length / ROWS));
  const ink = { r: 0.1, g: 0.12, b: 0.16 };
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const top = legend(page, latin, dev);
    drawMixed(page, `${graph.title} · ${pageIndex + 1}/${pages}`, 48, top, 12, latin, dev, ink);
    const slice = nodes.slice(pageIndex * ROWS, pageIndex * ROWS + ROWS);
    slice.forEach((node, index) => {
      const y = top - 28 - index * 22;
      const role =
        node.kind === "approval"
          ? ROLE_RGB.approval
          : node.kind === "tool"
            ? ROLE_RGB.data
            : node.kind === "note"
              ? ROLE_RGB.event
              : ROLE_RGB.control;
      page.drawRectangle({ x: 48, y: y - 2, width: 8, height: 12, color: paint(role) });
      drawMixed(page, node.label, 64, y, 11, latin, dev, ink);
    });
  }
  return pdf.save({ useObjectStreams: false });
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  for (let i = from; i + needle.length <= hay.length; i += 1) {
    let found = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

/** Flate streams this exporter wrote. Length is the byte count, not a text search. */
function inflateStreams(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const marker = new TextEncoder().encode("stream\n");
  let offset = 0;
  while (offset < bytes.length) {
    const idx = indexOfBytes(bytes, marker, offset);
    if (idx < 0) break;
    const prior = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, idx - 160), idx));
    const length = /\/Length (\d+)\s*>>\s*$/.exec(prior);
    if (!length) {
      offset = idx + marker.length;
      continue;
    }
    const len = Number(length[1]);
    const start = idx + marker.length;
    const raw = bytes.subarray(start, start + len);
    const tail = new TextDecoder("latin1").decode(bytes.subarray(start + len, start + len + 12));
    if (!tail.startsWith("\nendstream") && !tail.startsWith("\r\nendstream")) {
      offset = idx + marker.length;
      continue;
    }
    try {
      out.push(new TextDecoder("latin1").decode(unzlibSync(raw)));
    } catch {
      out.push("");
    }
    offset = start + len;
  }
  return out;
}

function cmapOf(streams: string[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const stream of streams) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    if (!stream.includes("beginbfchar")) continue;
    let match = re.exec(stream);
    while (match) {
      const key = Number.parseInt(match[1]!, 16);
      const dest = match[2]!;
      let value = "";
      for (let i = 0; i < dest.length; i += 4) {
        value += String.fromCharCode(Number.parseInt(dest.slice(i, i + 4), 16));
      }
      map.set(key, value);
      match = re.exec(stream);
    }
  }
  return map;
}

function showText(hex: string, cmap: Map<number, string>): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  if (bytes.every((byte) => byte >= 32 && byte <= 126)) {
    return String.fromCharCode(...bytes);
  }
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const id = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
    out += cmap.get(id) || "";
  }
  return out;
}

/** Visible text from a PDF this exporter wrote, including Devanagari. */
export function pdfPlainText(bytes: Uint8Array): string {
  const streams = inflateStreams(bytes);
  const cmap = cmapOf(streams);
  const parts: string[] = [];
  for (const stream of streams) {
    const re = /<([0-9A-Fa-f]+)>\s*Tj/g;
    let match = re.exec(stream);
    while (match) {
      parts.push(showText(match[1]!, cmap));
      match = re.exec(stream);
    }
  }
  return parts.join("\n");
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}
