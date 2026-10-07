/**
 * FRIDAY · local diagram pixels.
 *
 * A photo or screenshot with no embedded boxes is decoded here, then boxes
 * and connecting lines are measured. Text comes from a local OCR callback.
 * This module does not call a cloud vision model.
 */

import { unzlibSync, zlibSync } from "fflate";
import { decode as decodeJpeg } from "jpeg-js";
import type { OcrBox } from "./flow-diagram";

export type Raster = { width: number; height: number; rgba: Uint8Array };

export type RegionOcr = (
  raster: Raster,
  box: { x: number; y: number; width: number; height: number },
) => { text: string; confidence: number };

export type DetectedDiagram = {
  decoded: boolean;
  boxes: OcrBox[];
  links: [number, number][];
};

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array | null {
  const stride = width * channels;
  const expected = height * (1 + stride);
  if (raw.length < expected) return null;
  const out = new Uint8Array(height * stride);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset]!;
    offset += 1;
    const row = y * stride;
    const prev = y === 0 ? -1 : row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[offset]!;
      offset += 1;
      const left = x >= channels ? out[row + x - channels]! : 0;
      const up = prev >= 0 ? out[prev + x]! : 0;
      const upLeft = prev >= 0 && x >= channels ? out[prev + x - channels]! : 0;
      let next = value;
      if (filter === 1) next = (value + left) & 255;
      else if (filter === 2) next = (value + up) & 255;
      else if (filter === 3) next = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) next = (value + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) return null;
      out[row + x] = next;
    }
  }
  return out;
}

function toRgba(pixels: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  if (channels === 4) return pixels;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += channels, j += 4) {
    if (channels === 1) {
      rgba[j] = pixels[i]!;
      rgba[j + 1] = pixels[i]!;
      rgba[j + 2] = pixels[i]!;
    } else {
      rgba[j] = pixels[i]!;
      rgba[j + 1] = pixels[i + 1]!;
      rgba[j + 2] = pixels[i + 2]!;
    }
    rgba[j + 3] = 255;
  }
  return rgba;
}

export function decodePng(bytes: Uint8Array): Raster | null {
  if (bytes.length < 8 || PNG.some((byte, index) => bytes[index] !== byte)) return null;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
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
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) return null;
  const size = idat.reduce((sum, part) => sum + part.length, 0);
  const packed = new Uint8Array(size);
  let at = 0;
  for (const part of idat) {
    packed.set(part, at);
    at += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(packed);
  } catch {
    return null;
  }
  const pixels = unfilter(raw, width, height, channels);
  if (!pixels) return null;
  return { width, height, rgba: toRgba(pixels, width, height, channels) };
}

function decodeJpegRaster(bytes: Uint8Array): Raster | null {
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  try {
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: 32,
    });
    if (!decoded.width || !decoded.height || !decoded.data?.length) return null;
    return { width: decoded.width, height: decoded.height, rgba: decoded.data };
  } catch {
    return null;
  }
}

export function decodeRaster(bytes: Uint8Array): Raster | null {
  return decodePng(bytes) || decodeJpegRaster(bytes);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i += 1) {
    crc ^= out[i]!;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}

export function encodeRasterPng(raster: Raster): Uint8Array {
  const { width, height, rgba } = raster;
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + stride);
    raw[row] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), row + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = new Uint8Array(PNG);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array()),
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

function put(raster: Raster, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
  const i = (y * raster.width + x) * 4;
  raster.rgba[i] = 16;
  raster.rgba[i + 1] = 16;
  raster.rgba[i + 2] = 16;
  raster.rgba[i + 3] = 255;
}

export function blankRaster(width: number, height: number): Raster {
  const rgba = new Uint8Array(width * height * 4);
  rgba.fill(255);
  return { width, height, rgba };
}

export function strokeRect(
  raster: Raster,
  x: number,
  y: number,
  width: number,
  height: number,
  thickness = 3,
): void {
  for (let t = 0; t < thickness; t += 1) {
    for (let i = 0; i < width; i += 1) {
      put(raster, x + i, y + t);
      put(raster, x + i, y + height - 1 - t);
    }
    for (let j = 0; j < height; j += 1) {
      put(raster, x + t, y + j);
      put(raster, x + width - 1 - t, y + j);
    }
  }
}

export function strokeLine(
  raster: Raster,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness = 3,
): void {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let t = -Math.floor(thickness / 2); t <= Math.floor(thickness / 2); t += 1) {
      put(raster, x + t, y);
      put(raster, x, y + t);
    }
  }
}

function dark(raster: Raster, x: number, y: number): boolean {
  const i = (y * raster.width + x) * 4;
  return (raster.rgba[i]! + raster.rgba[i + 1]! + raster.rgba[i + 2]!) / 3 < 96;
}

type Run = { a: number; b1: number; b2: number };

function runs(raster: Raster, horizontal: boolean): Run[] {
  const found: Run[] = [];
  const outer = horizontal ? raster.height : raster.width;
  const inner = horizontal ? raster.width : raster.height;
  for (let a = 0; a < outer; a += 1) {
    let start = -1;
    for (let b = 0; b <= inner; b += 1) {
      const on = b < inner && (horizontal ? dark(raster, b, a) : dark(raster, a, b));
      if (on && start < 0) start = b;
      if (!on && start >= 0) {
        if (b - start >= 16) found.push({ a, b1: start, b2: b - 1 });
        start = -1;
      }
    }
  }
  return found;
}

type Segment = { x1: number; y1: number; x2: number; y2: number; horizontal: boolean };

function cluster(rows: Run[], horizontal: boolean): Segment[] {
  const used = new Set<number>();
  const out: Segment[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (used.has(i)) continue;
    const seed = rows[i]!;
    let a1 = seed.a;
    let a2 = seed.a;
    const b1 = seed.b1;
    const b2 = seed.b2;
    used.add(i);
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < rows.length; j += 1) {
        if (used.has(j)) continue;
        const other = rows[j]!;
        if (other.a < a1 - 1 || other.a > a2 + 1) continue;
        if (Math.abs(other.b1 - b1) > 4 || Math.abs(other.b2 - b2) > 4) continue;
        used.add(j);
        a1 = Math.min(a1, other.a);
        a2 = Math.max(a2, other.a);
        grew = true;
      }
    }
    out.push(
      horizontal
        ? { x1: b1, y1: a1, x2: b2, y2: a2, horizontal: true }
        : { x1: a1, y1: b1, x2: a2, y2: b2, horizontal: false },
    );
  }
  return out;
}

function near(a: number, b: number, tol = 6): boolean {
  return Math.abs(a - b) <= tol;
}

type Box = { x: number; y: number; width: number; height: number };

function detectBoxes(raster: Raster): { boxes: Box[]; horizontal: Segment[]; vertical: Segment[] } {
  const horizontal = cluster(runs(raster, true), true);
  const vertical = cluster(runs(raster, false), false);
  const boxes: Box[] = [];
  for (const top of horizontal) {
    for (const bottom of horizontal) {
      if (bottom.y1 < top.y2 + 12 || bottom.y1 - top.y2 > 280) continue;
      if (!near(top.x1, bottom.x1) || !near(top.x2, bottom.x2)) continue;
      const left = vertical.find(
        (seg) => near(seg.x1, top.x1) && seg.y1 <= top.y2 + 6 && seg.y2 >= bottom.y1 - 6,
      );
      const right = vertical.find(
        (seg) => near(seg.x2, top.x2) && seg.y1 <= top.y2 + 6 && seg.y2 >= bottom.y1 - 6,
      );
      if (!left || !right) continue;
      const box = {
        x: Math.min(top.x1, bottom.x1),
        y: top.y1,
        width: Math.max(top.x2, bottom.x2) - Math.min(top.x1, bottom.x1),
        height: bottom.y2 - top.y1,
      };
      if (box.width < 16 || box.height < 12) continue;
      if (boxes.some((have) => near(have.x, box.x, 8) && near(have.y, box.y, 8))) continue;
      boxes.push(box);
    }
  }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  return { boxes, horizontal, vertical };
}

function endpointBox(boxes: Box[], x: number, y: number): number {
  let best = -1;
  let distance = 12;
  boxes.forEach((box, index) => {
    const cx = Math.min(Math.max(x, box.x), box.x + box.width);
    const cy = Math.min(Math.max(y, box.y), box.y + box.height);
    const gap = Math.hypot(x - cx, y - cy);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  });
  return best;
}

function linksFrom(boxes: Box[], segments: Segment[]): [number, number][] {
  const links: [number, number][] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    const from = endpointBox(boxes, seg.x1, seg.horizontal ? seg.y1 : seg.y1);
    const to = endpointBox(boxes, seg.x2, seg.horizontal ? seg.y2 : seg.y2);
    const start = endpointBox(boxes, seg.horizontal ? seg.x1 : seg.x1, seg.y1);
    const end = endpointBox(boxes, seg.horizontal ? seg.x2 : seg.x2, seg.y2);
    const a = start >= 0 ? start : from;
    const b = end >= 0 ? end : to;
    if (a < 0 || b < 0 || a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    const boxA = boxes[a]!;
    const boxB = boxes[b]!;
    const border =
      (near(seg.x1, boxA.x) && near(seg.x2, boxA.x) && near(seg.y1, boxA.y)) ||
      (near(seg.y1, boxA.y) && near(seg.y2, boxA.y) && near(seg.x1, boxA.x));
    if (border && near(seg.x2, boxA.x + boxA.width) && near(seg.y2, boxA.y + boxA.height)) continue;
    if (Math.hypot(boxA.x - boxB.x, boxA.y - boxB.y) < 8 && Math.abs(boxA.width - boxB.width) < 8)
      continue;
    seen.add(key);
    links.push([a, b]);
  }
  return links;
}

const EMPTY_OCR: RegionOcr = () => ({ text: "", confidence: 0.4 });

export function readPhotoDiagram(bytes: Uint8Array, ocr: RegionOcr = EMPTY_OCR): DetectedDiagram {
  const raster = decodeRaster(bytes);
  if (!raster) return { decoded: false, boxes: [], links: [] };
  const found = detectBoxes(raster);
  const links = linksFrom(found.boxes, [...found.horizontal, ...found.vertical]);
  const boxes = found.boxes.map((box) => {
    const read = ocr(raster, box);
    return {
      text: read.text,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      confidence: read.confidence,
    };
  });
  return { decoded: true, boxes, links };
}
