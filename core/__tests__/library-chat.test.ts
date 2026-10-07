/**
 * Chat + Library + hisab: zip extract, persist, teach/retrieve, attach CSV, payee, privacy.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  readAttachment,
  attachmentDirective,
  needsArchiveExtract,
} from "../../src/lib/friday/attachments";
import { library } from "../../src/lib/friday/library-engine";
import {
  looksLikeLibraryTeach,
  chunkText,
  classifyLibraryType,
} from "../../src/lib/friday/library-logic";
import { formatLibraryExtra, publishLibrarySession } from "../../src/lib/friday/library-awareness";
import { shouldAttachLibraryExtra } from "../../src/lib/friday/brain/library-observe";
import { sourceReliability } from "../../src/lib/friday/brain/retrieval";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { hisab } from "../../src/lib/friday/hisab-kitab";
import { parsePayeeAsk } from "../../src/lib/friday/owner-work-logic";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { looksSensitive } from "../../src/lib/friday/brain/memory-policy";

const require = createRequire(import.meta.url);
const extract = require("../../electron/document-extract.cjs");
const paths = require("../../electron/friday-paths.cjs");
const diskLibrary = require("../../electron/library.cjs");

describe("zip / archive extract", () => {
  it("unpacks a store-method zip and reads text members", () => {
    const packed = extract.packZip([
      { name: "notes.txt", data: Buffer.from("Ramesh wages unique-zip-token-42") },
      { name: "photo.bin", data: Buffer.from([0, 1, 2, 3, 4]) },
    ]);
    const out = extract.extract({ filename: "pack.zip", bytes: packed });
    expect(out.kind).toBe("zip");
    expect(out.text).toMatch(/unique-zip-token-42/);
    expect(out.text).toMatch(/photo.bin/);
    expect(out.skipped?.some((row: string) => /photo\.bin/.test(row))).toBe(true);
  });

  it("extracts a nested zip one level and reports a second level as skipped", () => {
    const inner = extract.packZip([{ name: "inner.txt", data: Buffer.from("inner-level-text") }]);
    const one = extract.extract({
      filename: "outer.zip",
      bytes: extract.packZip([{ name: "child.zip", data: inner }]),
    });
    expect(one.text).toMatch(/inner-level-text/);
    const deeper = extract.packZip([{ name: "deep.zip", data: inner }]);
    const two = extract.extract({
      filename: "outer.zip",
      bytes: extract.packZip([{ name: "child.zip", data: deeper }]),
    });
    expect(two.skipped?.join(" ") || "").toMatch(/nested zip/i);
  });

  it("does not pretend a zip was read when the desktop extract bridge is absent", async () => {
    expect(needsArchiveExtract("site.zip")).toBe(true);
    const packed = extract.packZip([{ name: "a.txt", data: Buffer.from("hello") }]);
    const file = new File([packed], "site.zip", { type: "application/zip" });
    const attachment = await readAttachment(file);
    expect(attachment.error ?? "").toMatch(/desktop|Windows|guess/i);
    expect(attachment.text).toBeUndefined();
  });
});

describe("library persist + teach retrieve", () => {
  beforeEach(() => {
    memory.resetForTests();
    library.resetForTests();
  });

  it("stores an uploaded text file and retrieves it after yaad rakh / teach", async () => {
    const item = await library.ingest({
      name: "labour-register.txt",
      text: "The labour register says Ramesh was paid 7000 rupees on 2026-09-01 for the north site.",
      origin: "uploaded",
      source: "chat",
      extract: {
        text: "The labour register says Ramesh was paid 7000 rupees on 2026-09-01 for the north site.",
      },
    });
    expect(library.get(item.id)?.name).toBe("labour-register.txt");
    expect(looksLikeLibraryTeach("yaad rakh this file")).toBe(true);
    const taught = library.teach(item.id);
    expect(taught.ok).toBe(true);
    expect(taught.chunks).toBeGreaterThan(0);
    const hits = memory.retrieve("Ramesh labour register north site 7000", 8);
    expect(hits.some((hit) => hit.item.text.includes("7000"))).toBe(true);
    expect(hits.some((hit) => String(hit.item.source).includes(`library:${item.id}`))).toBe(true);
  });

  it("chunks long books instead of keeping only a 24k prompt slice", () => {
    const book = "chapter ".repeat(8000);
    expect(book.length).toBeGreaterThan(24_000);
    const chunks = chunkText(book);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("refuses sensitive credential-like text as memory", async () => {
    const item = await library.ingest({
      name: "secrets.txt",
      text: "password is hunter2-secret and api_key is sk-abcdefghijklmnopqrstuv",
      extract: { text: "password is hunter2-secret and api_key is sk-abcdefghijklmnopqrstuv" },
    });
    expect(looksSensitive(item.text || "")).toBe(true);
    const taught = library.teach(item.id);
    expect(taught.ok).toBe(false);
    expect(taught.skipped).toMatch(/secret|ledger|PIN|memory/i);
  });
});

describe("hisab attach-import + per-payee", () => {
  beforeEach(() => {
    hisab.reset();
    library.resetForTests();
  });

  it("imports an attached CSV into the ledger and answers by payee from rows only", async () => {
    const csv = [
      "Date,Description,Amount,Type",
      "2026-09-07,Ramesh labour week,3000,expense",
      "2026-09-08,Ramesh labour week,2000,expense",
      "2026-09-08,Northwind invoice,12000,income",
    ].join("\n");
    const item = await library.ingest({
      name: "wages.csv",
      text: csv,
      extract: { text: csv },
    });
    const imported = library.importSheetIfBooks(item.id);
    expect(imported?.imported).toBe(3);
    expect(library.get(item.id)?.hisabLinked).toBe(true);
    const reply = baselineRespond("Ramesh ko kitna diya");
    expect(reply.text).toMatch(/5000/);
    expect(reply.text).toMatch(/imported rows/i);
    expect(reply.text).not.toMatch(/invent/i);
  });

  it("does not invent a payee that is not in the ledger", () => {
    hisab.importCsv("Date,Description,Amount,Type\n2026-09-08,Office rent,15000,expense", "csv");
    const reply = baselineRespond("Suresh ko kitna diya");
    expect(reply.text).toMatch(/No imported rows match/i);
  });
});

describe("disk library under a FRIDAY root", () => {
  it("writes index.json + item bytes and can zip selected", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-library-"));
    paths.setRoot(root);
    const packed = extract.packZip([{ name: "a.txt", data: Buffer.from("disk-zip-body") }]);
    const ingested = diskLibrary.ingest({
      name: "pack.zip",
      bytes: packed,
      origin: "uploaded",
      source: "chat",
    });
    expect(ingested.ok).toBe(true);
    expect(ingested.item.text).toMatch(/disk-zip-body/);
    const listed = diskLibrary.list();
    expect(listed.items.some((row: { id: string }) => row.id === ingested.item.id)).toBe(true);
    const zipped = diskLibrary.zipSelected([ingested.item.id]);
    expect(zipped.ok).toBe(true);
    expect(zipped.item.name).toMatch(/\.zip$/);
    paths.setRoot(null);
  });
});

describe("attachment directive honesty", () => {
  it("tells the model not to claim unread binary contents", () => {
    const extra = attachmentDirective([
      {
        id: "att-1",
        name: "clip.mp4",
        kind: "binary",
        size: 12,
        mime: "video/mp4",
        error: "I did not watch this video. I only have its name, type and size.",
      },
    ]).extra;
    expect(extra).toMatch(/Could not be read|did not watch/i);
    expect(extra).not.toMatch(/I watched/i);
  });
});

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function packDeflatedZip(name: string, data: Buffer): Buffer {
  const packed = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.write("PK\x03\x04", 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.write("PK\x01\x02", 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\x05\x06", 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + packed.length, 16);
  return Buffer.concat([local, nameBuf, packed, central, nameBuf, eocd]);
}

describe("library retrieve quality", () => {
  beforeEach(() => {
    memory.resetForTests();
    library.resetForTests();
  });

  it("does not merge overlapping book chunks into one memory row", async () => {
    const book = Array.from(
      { length: 12 },
      (_, i) => `Section-${i} unique-token-${i} ${"lorem ".repeat(220)}`,
    ).join("\n\n");
    const item = await library.ingest({
      name: "site-register.txt",
      text: book,
      extract: { text: book },
    });
    const taught = library.teach(item.id);
    expect(taught.chunks).toBeGreaterThan(2);
    const rows = memory
      .getSnapshot()
      .items.filter((row) => String(row.source).includes(`library:${item.id}`));
    expect(rows.length).toBe(taught.chunks);
    const again = library.teach(item.id);
    expect(again.chunks).toBe(taught.chunks);
    const after = memory
      .getSnapshot()
      .items.filter((row) => String(row.source).includes(`library:${item.id}`));
    expect(after.length).toBe(taught.chunks);
  });

  it("reuses the same Library id when the same bytes are ingested again", async () => {
    const first = await library.ingest({
      name: "notes.txt",
      text: "same-bytes-body",
      extract: { text: "same-bytes-body" },
    });
    const second = await library.ingest({
      name: "notes.txt",
      text: "same-bytes-body",
      extract: { text: "same-bytes-body" },
    });
    expect(second.id).toBe(first.id);
    expect(library.list().filter((row) => row.name === "notes.txt")).toHaveLength(1);
  });

  it("treats library: citations as owner-document sources, even when the filename contains chat", () => {
    expect(sourceReliability("library:lib-1:chat-notes.txt:chunk:0")).toBeGreaterThan(
      sourceReliability("unverified-chat"),
    );
  });
});

describe("hisab re-import", () => {
  beforeEach(() => {
    hisab.reset();
    library.resetForTests();
  });

  it("replaces rows from the same Library file instead of double-counting", async () => {
    const csv = ["Date,Description,Amount,Type", "2026-09-07,Ramesh labour,3000,expense"].join(
      "\n",
    );
    const item = await library.ingest({ name: "wages.csv", text: csv, extract: { text: csv } });
    expect(library.importSheetIfBooks(item.id)?.imported).toBe(1);
    expect(library.importSheetIfBooks(item.id)?.imported).toBe(1);
    const reply = baselineRespond("Ramesh ko kitna diya");
    expect(reply.text).toMatch(/3000/);
    expect(reply.text).not.toMatch(/6000/);
  });

  it("does not treat a news question as a payee name", () => {
    expect(
      parsePayeeAsk("who is the current prime minister of India and what happened this week"),
    ).toBeNull();
    expect(parsePayeeAsk("Ramesh this week")?.payee).toBe("Ramesh");
  });
});

describe("library extra + pin body", () => {
  beforeEach(() => {
    library.resetForTests();
    publishLibrarySession({ items: [], pinned: [], selectedId: null, dir: "", desktop: false });
  });

  it("classifies html/json/svg with the same types Chat and disk use", () => {
    expect(classifyLibraryType("note.html")).toBe("doc");
    expect(classifyLibraryType("data.json")).toBe("doc");
    expect(classifyLibraryType("icon.svg")).toBe("image");
    expect(classifyLibraryType("clip.flac")).toBe("audio");
  });

  it("injects pinned extract text into the live extra Chat/Voice/Auto share", async () => {
    const item = await library.ingest({
      name: "spec.md",
      text: "unique-library-pin-token-88 must stay in Auto extra",
      extract: { text: "unique-library-pin-token-88 must stay in Auto extra" },
    });
    library.pin(item.id, true);
    publishLibrarySession({
      items: library.list(),
      pinned: [item.id],
      selectedId: item.id,
      dir: "",
      desktop: false,
    });
    const extra = formatLibraryExtra();
    expect(extra).toMatch(/PINNED EXTRACT/);
    expect(extra).toMatch(/unique-library-pin-token-88/);
    expect(shouldAttachLibraryExtra("draft the next step")).toBe(true);
  });
});

describe("zip bomb honesty", () => {
  it("skips a huge compressible member instead of inflating it", () => {
    const packed = packDeflatedZip("zeros.bin", Buffer.alloc(3 * 1024 * 1024, 0));
    const out = extract.extract({ filename: "bomb.zip", bytes: packed });
    expect(out.skipped?.join(" ") || "").toMatch(/2 MB|zip bomb|skipped/i);
    expect(String(out.text || "")).not.toMatch(/[\s\S]{2000000}/);
  });
});
