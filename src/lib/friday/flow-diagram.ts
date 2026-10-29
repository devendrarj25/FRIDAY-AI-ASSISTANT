/**
 * FRIDAY · one diagram reader.
 *
 * Text diagrams use the existing importers. A picture is read from local OCR
 * boxes. Sensitive pictures stay on this PC. A cloud route is chosen only
 * when the firewall and the owner's setting both allow it, and this reader
 * still does not call a provider by itself.
 */

import { looksSensitive } from "./brain/memory-policy";
import { boxesFromTesseractTsv, textInBox } from "./diagram-ocr";
import { readPhotoDiagram, type RegionOcr } from "./diagram-raster";
import { makeReal } from "./flow-bind";
import { importChecked } from "./flow-codec";
import { importD2, importDrawio, importJsonCanvas, importSvg } from "./flow-depth";
import { explainGraph, nodeOf, safeFlowId, type FlowGraph, type FlowIssue } from "./flow-graph";

export type OcrBox = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export type DiagramRoute = "local" | "cloud";

export type DiagramRead = {
  format: string;
  graph: FlowGraph;
  explanation: string;
  uncertain: string[];
  issues: FlowIssue[];
  route: DiagramRoute;
};

const CONFIDENT = 0.6;

export function routeDiagramVision(input: {
  sensitive: boolean;
  cloudAllowed: boolean;
  ownerOptIn: boolean;
}): DiagramRoute {
  if (input.sensitive || !input.cloudAllowed || !input.ownerOptIn) return "local";
  return "cloud";
}

function languageOf(question: string): "hindi" | "hinglish" | "english" {
  if (/[\u0900-\u097F]/.test(question)) return "hindi";
  if (/\b(kya|kaise|hai|nahi)\b/i.test(question)) return "hinglish";
  return "english";
}

export function explainDiagram(graph: FlowGraph, question: string, uncertain: string[]): string {
  const body = explainGraph(graph, question);
  if (!uncertain.length) return body;
  const language = languageOf(question);
  const line =
    language === "hindi"
      ? `अनिश्चित: ${uncertain.join(", ")}. इन्हें बनाने से पहले जाँचें।`
      : language === "hinglish"
        ? `Uncertain: ${uncertain.join(", ")}. Build se pehle inhe check karo.`
        : `Uncertain: ${uncertain.join(", ")}. Confirm these before anything is built.`;
  return `${body}\n${line}`;
}

function diagramGraph(
  id: string,
  title: string,
  nodes: FlowGraph["nodes"],
  edges: FlowGraph["edges"],
): FlowGraph {
  return {
    version: 1,
    id,
    title,
    trusted: false,
    enabled: false,
    nodes,
    edges,
    groups: nodes.length
      ? [{ id: "diagram", title: "Diagram", nodeIds: nodes.map((node) => node.id) }]
      : [],
  };
}

export function graphFromBoxes(
  boxes: OcrBox[],
  title = "Uploaded diagram",
  links?: Array<[number, number]>,
): {
  graph: FlowGraph;
  uncertain: string[];
} {
  const ordered = boxes.map((box, index) => ({ ...box, index }));
  ordered.sort((a, b) => a.y - b.y || a.x - b.x);
  const uncertain = new Set<string>();
  const nodes = ordered.map((box) => {
    const id = safeFlowId(`box.${box.index}`);
    const low = box.confidence < CONFIDENT || !box.text.trim();
    if (low) uncertain.add(id);
    return nodeOf({
      id,
      kind: "note",
      label: box.text.trim() || "unlabeled",
      status: "unknown",
      module: "src/lib/friday/flow-diagram.ts",
      detail: low ? `uncertain: ${box.text || "empty"} (${box.confidence})` : box.text,
      source: { adapter: "diagram", ref: low ? `uncertain:${id}` : id },
    });
  });
  const at = new Map(ordered.map((box, pos) => [box.index, pos]));
  const edges: FlowGraph["edges"] = [];
  if (links) {
    const seen = new Set<string>();
    for (const [fromIndex, toIndex] of links) {
      const from = nodes[at.get(fromIndex) ?? -1];
      const to = nodes[at.get(toIndex) ?? -1];
      if (!from || !to || from.id === to.id) continue;
      if (uncertain.has(from.id) || uncertain.has(to.id)) continue;
      const id = `ocr-${from.id}-${to.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source: from.id, target: to.id, kind: "control" });
    }
  }
  const candidates = new Map<number, number[]>();
  let fork = false;
  if (!links) {
    ordered.forEach((box, index) => {
      const hits = ordered
        .map((other, otherIndex) => ({ other, otherIndex }))
        .filter(({ other, otherIndex }) => {
          if (otherIndex === index) return false;
          const dy = other.y - box.y;
          const dx = Math.abs(other.x - box.x);
          return dy > 8 && dy < 220 && dx < Math.max(box.width, 48);
        })
        .sort((a, b) => a.other.y - b.other.y);
      const nearest = hits[0];
      const second = hits[1];
      if (!nearest) {
        candidates.set(index, []);
        return;
      }
      if (second && second.other.y - nearest.other.y < 30) {
        fork = true;
        candidates.set(index, []);
        return;
      }
      candidates.set(index, [nearest.otherIndex]);
    });
  }
  if (!links && fork) {
    for (const node of nodes) uncertain.add(node.id);
  } else if (!links) {
    ordered.forEach((box, index) => {
      const hit = candidates.get(index)?.[0];
      if (hit === undefined) return;
      const from = nodes[index];
      const to = nodes[hit];
      if (!from || !to) return;
      if (uncertain.has(from.id) || uncertain.has(to.id)) return;
      edges.push({
        id: `ocr-${from.id}-${to.id}`,
        source: from.id,
        target: to.id,
        kind: "control",
      });
    });
  }
  for (const node of nodes) {
    if (!uncertain.has(node.id)) continue;
    if (!node.detail.startsWith("uncertain")) node.detail = `uncertain: ${node.detail}`;
    if (!node.source.ref.startsWith("uncertain")) {
      node.source = { adapter: "diagram", ref: `uncertain:${node.id}` };
    }
  }
  return { graph: diagramGraph("diagram-image", title, nodes, edges), uncertain: [...uncertain] };
}

function sniffText(name: string, text: string): string {
  const trimmed = text.trim();
  const lower = name.toLowerCase();
  if (/<mxfile\b|<mxGraphModel\b/i.test(trimmed) || lower.endsWith(".drawio")) return "drawio";
  if (/<svg\b/i.test(trimmed) || lower.endsWith(".svg")) return "svg";
  if (
    /^\s*(flowchart|graph\s+(TD|LR|TB|RL)|sequenceDiagram)\b/im.test(trimmed) ||
    lower.endsWith(".mmd")
  )
    return "mermaid";
  if (/^\s*(digraph|graph)\b/m.test(trimmed) || lower.endsWith(".dot")) return "dot";
  if (/^\s*direction\s*:/m.test(trimmed) || lower.endsWith(".d2")) return "d2";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        nodes?: { type?: string; text?: string }[];
        connections?: unknown;
        edges?: { fromNode?: string }[];
        wires?: unknown;
      };
      if (Array.isArray(parsed)) return "node-red";
      const nodes = parsed.nodes;
      if (Array.isArray(nodes) && nodes.some((node) => String(node.type || "").includes("n8n")))
        return "n8n";
      if (parsed.connections && Array.isArray(nodes)) return "n8n";
      if (
        Array.isArray(nodes) &&
        Array.isArray(parsed.edges) &&
        parsed.edges.some((edge) => edge.fromNode)
      )
        return "canvas";
      if (Array.isArray(nodes)) return "json";
    } catch {
      return "";
    }
  }
  return "";
}

function noteGraph(title: string, detail: string): FlowGraph {
  return diagramGraph(
    "diagram-unread",
    title,
    [
      nodeOf({
        id: "diagram.unread",
        kind: "note",
        label: "Not read",
        status: "unknown",
        module: "src/lib/friday/flow-diagram.ts",
        detail,
        source: { adapter: "diagram", ref: "uncertain:unread" },
      }),
    ],
    [],
  );
}

export function readDiagram(input: {
  name?: string;
  mime?: string;
  text?: string;
  boxes?: OcrBox[] | null;
  bytes?: Uint8Array | null;
  words?: OcrBox[] | null;
  ocr?: RegionOcr | null;
  sensitive?: boolean;
  cloudAllowed?: boolean;
  ownerOptIn?: boolean;
  question?: string;
}): DiagramRead {
  const name = input.name || "diagram";
  const text = input.text || "";
  const sensitive = input.sensitive ?? looksSensitive(`${name}\n${text}`);
  const route = routeDiagramVision({
    sensitive,
    cloudAllowed: Boolean(input.cloudAllowed),
    ownerOptIn: Boolean(input.ownerOptIn),
  });
  const question = input.question || "explain this";
  if (input.boxes) {
    const built = graphFromBoxes(input.boxes, name);
    return {
      format: "image",
      graph: built.graph,
      explanation: explainDiagram(built.graph, question, built.uncertain),
      uncertain: built.uncertain,
      issues: [],
      route: "local",
    };
  }
  const image = /^image\//.test(input.mime || "") || /\.(png|jpe?g|gif|webp)$/i.test(name);
  if (image && input.bytes?.length && !input.boxes) {
    const ocr =
      input.ocr || (input.words ? (_raster, box) => textInBox(input.words || [], box) : undefined);
    const photo = readPhotoDiagram(input.bytes, ocr);
    if (photo.decoded && photo.boxes.length) {
      const built = graphFromBoxes(photo.boxes, name, photo.links);
      return {
        format: "image",
        graph: built.graph,
        explanation: explainDiagram(built.graph, question, built.uncertain),
        uncertain: built.uncertain,
        issues: [],
        route: "local",
      };
    }
  }
  if (image && !text.trim()) {
    const detail =
      route === "cloud"
        ? "Cloud vision is allowed for this image. This reader did not call a provider. No boxes were returned."
        : "This image was not read on this PC. No local OCR boxes were available, and a cloud vision call was not used.";
    const graph = noteGraph(name, detail);
    return {
      format: "image",
      graph,
      explanation: explainDiagram(graph, question, ["diagram.unread"]),
      uncertain: ["diagram.unread"],
      issues: [{ code: "unread", message: detail }],
      route,
    };
  }
  const format = sniffText(name, text);
  if (!format) {
    const graph = noteGraph(name, "not recorded");
    return {
      format: "unknown",
      graph,
      explanation: explainDiagram(graph, question, ["diagram.unread"]),
      uncertain: ["diagram.unread"],
      issues: [{ code: "format", message: "That file is not a diagram this reader knows." }],
      route: "local",
    };
  }
  const imported =
    format === "d2"
      ? importD2(text)
      : format === "drawio"
        ? importDrawio(text)
        : format === "svg"
          ? importSvg(text)
          : format === "canvas"
            ? importJsonCanvas(text)
            : importChecked(format as "mermaid" | "dot" | "json" | "n8n" | "node-red", text);
  const uncertain = imported.graph.nodes
    .filter(
      (node) => node.detail.startsWith("uncertain") || node.source.ref.startsWith("uncertain"),
    )
    .map((node) => node.id);
  return {
    format,
    graph: imported.graph,
    explanation: explainDiagram(imported.graph, question, uncertain),
    uncertain,
    issues: imported.issues,
    route: "local",
  };
}

export type AttachmentDiagram = {
  id: string;
  name: string;
  kind: string;
  mime: string;
  text?: string;
  dataUrl?: string;
};

let pendingExplanation: string | null = null;

export function armDiagramExplanation(text: string): void {
  pendingExplanation = text;
}

export function takeDiagramExplanation(): string | null {
  const value = pendingExplanation;
  pendingExplanation = null;
  return value;
}

export function clearDiagramExplanation(): void {
  pendingExplanation = null;
}

function bytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const body = dataUrl.slice(comma + 1).replace(/=+$/, "");
  try {
    if (typeof atob === "function") {
      const binary = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
  } catch {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  for (let i = 0; i < body.length; i += 4) {
    const a = alphabet.indexOf(body[i] || "A");
    const b = alphabet.indexOf(body[i + 1] || "A");
    const c = alphabet.indexOf(body[i + 2] || "A");
    const d = alphabet.indexOf(body[i + 3] || "A");
    out.push((a << 2) | (b >> 4));
    if (body[i + 2]) out.push(((b & 15) << 4) | (c >> 2));
    if (body[i + 3]) out.push(((c & 3) << 6) | d);
  }
  return Uint8Array.from(out);
}

export function readAttachmentDiagrams(
  items: AttachmentDiagram[],
  options: {
    cloudAllowed?: boolean;
    ownerOptIn?: boolean;
    question?: string;
    words?: OcrBox[] | null;
    ocr?: RegionOcr | null;
  } = {},
): DiagramRead | null {
  for (const item of items) {
    let boxes: OcrBox[] | null = null;
    let bytes: Uint8Array | null = null;
    if (item.kind === "image" && item.dataUrl) {
      bytes = bytesFromDataUrl(item.dataUrl);
      boxes = bytes ? boxesFromPng(bytes) : null;
    }
    const text = item.text || "";
    const image = item.kind === "image";
    if (!image && !sniffText(item.name, text)) continue;
    return readDiagram({
      name: item.name,
      mime: item.mime,
      text: image ? "" : text,
      boxes,
      ...(bytes && !boxes ? { bytes } : {}),
      ...(options.cloudAllowed ? { cloudAllowed: true } : {}),
      ...(options.ownerOptIn ? { ownerOptIn: true } : {}),
      ...(options.question ? { question: options.question } : {}),
      ...(options.ocr ? { ocr: options.ocr } : {}),
      ...(options.words ? { words: options.words } : {}),
    });
  }
  return null;
}

type DiagramOcrBridge = (dataUrl: string) => Promise<{ ok: boolean; tsv?: string; error?: string }>;

function diagramOcrBridge(): DiagramOcrBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { friday?: { diagramOcr?: DiagramOcrBridge } }).friday
    ?.diagramOcr;
  return bridge || null;
}

/** Ask the desktop Tesseract host, then re-read the same attachment. */
export async function enrichDiagramOcr(
  items: AttachmentDiagram[],
  options: { cloudAllowed?: boolean; ownerOptIn?: boolean; question?: string } = {},
): Promise<DiagramRead | null> {
  const image = items.find((item) => item.kind === "image" && item.dataUrl);
  const bridge = diagramOcrBridge();
  if (!image?.dataUrl || !bridge) return null;
  const result = await bridge(image.dataUrl);
  if (!result?.ok || !result.tsv) return null;
  const words = boxesFromTesseractTsv(result.tsv);
  if (!words.length) return null;
  return readAttachmentDiagrams(items, { ...options, words });
}

const STAGES = ["plan", "code", "verify", "install"] as const;

export function recordedForgeStages(log: { text: string; ok: boolean }[]): string[] {
  const found: string[] = [];
  for (const line of log) {
    if (!line.ok) continue;
    const text = line.text;
    if (/\bplanned\b/i.test(text) && !found.includes("plan")) found.push("plan");
    else if (/\bwriting\b/i.test(text) && !found.includes("code")) found.push("code");
    else if (/\b(verifying|sandbox run passed)\b/i.test(text) && !found.includes("verify"))
      found.push("verify");
    else if (/\binstalled as\b/i.test(text) && !found.includes("install")) found.push("install");
  }
  return found;
}

export function diagramBlocksBuild(graph: FlowGraph): string {
  const uncertain = graph.nodes.filter(
    (node) => node.detail.startsWith("uncertain") || node.source.ref.startsWith("uncertain"),
  );
  if (!uncertain.length) return "";
  return `Confirm uncertain boxes before building: ${uncertain.map((node) => node.label).join(", ")}.`;
}

export async function buildFromDiagram(
  graph: FlowGraph,
  host: {
    forge: (
      goal: string,
    ) => Promise<{ stage: string; error?: string; log: { text: string; ok: boolean }[] }>;
  },
): Promise<{
  stage: string;
  applied: boolean;
  reason: string;
  ran: string[];
  called: boolean;
}> {
  const blocked = diagramBlocksBuild(graph);
  if (blocked) {
    return { stage: "failed", applied: false, reason: blocked, ran: [], called: false };
  }
  const goal = graph.nodes.map((node) => node.label).join(" → ") || graph.title;
  const run = await host.forge(goal);
  const ran = recordedForgeStages(run.log);
  const complete = STAGES.every((stage) => ran.includes(stage));
  if (run.stage !== "done" || run.error || !complete) {
    return {
      stage: run.stage === "done" ? "failed" : run.stage,
      applied: false,
      reason: run.error || "A forge stage was not recorded, so nothing was installed.",
      ran,
      called: true,
    };
  }
  const made = makeReal(
    { kind: "capability", ref: graph.id, value: goal, real: false },
    { stage: "done", ok: true },
  );
  return {
    stage: "done",
    applied: made.applied,
    reason: made.reason,
    ran,
    called: true,
  };
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out[0] = (data.length >>> 24) & 0xff;
  out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff;
  out[3] = data.length & 0xff;
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff;
  out[11 + data.length] = crc & 0xff;
  return out;
}

export function encodeDiagramPng(boxes: OcrBox[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr[0] = 0;
  ihdr[1] = 0;
  ihdr[2] = 0;
  ihdr[3] = 1;
  ihdr[4] = 0;
  ihdr[5] = 0;
  ihdr[6] = 0;
  ihdr[7] = 1;
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = new Uint8Array([0, 12, 16, 20]);
  const adler = (1 + raw[0]! + raw[1]! + raw[2]! + raw[3]!) & 0xffff;
  const sumB =
    (raw[0]! +
      (raw[0]! + raw[1]!) +
      (raw[0]! + raw[1]! + raw[2]!) +
      (raw[0]! + raw[1]! + raw[2]! + raw[3]!)) %
    65521;
  const idat = new Uint8Array([
    0x78,
    0x01,
    0x01,
    raw.length,
    0,
    ~raw.length & 0xff,
    (~raw.length >> 8) & 0xff,
    ...raw,
    (sumB >>> 8) & 0xff,
    sumB & 0xff,
    (adler >>> 8) & 0xff,
    adler & 0xff,
  ]);
  const text = new TextEncoder().encode(`friday-diagram\0${JSON.stringify(boxes)}`);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array()),
  ];
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

export function boxesFromPng(bytes: Uint8Array): OcrBox[] | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    if (offset + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (type === "tEXt") {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const zero = data.indexOf(0);
      const key = new TextDecoder().decode(data.subarray(0, Math.max(0, zero)));
      if (key === "friday-diagram") {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(data.subarray(zero + 1))) as OcrBox[];
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
    if (type === "IEND") break;
    offset += 12 + length;
  }
  return null;
}
