/**
 * FRIDAY · library engine
 *
 * One owner-facing Library: uploaded, generated, and modified files under
 * FRIDAY_ROOT. Desktop persists via `electron/library.cjs`. Tests and the
 * browser preview keep an in-memory copy of the same record shape — never a
 * second cloud drive, brain, or Import & Build.
 */

import { looksSensitive } from "./brain/memory-policy";
import { shouldRememberChats } from "./settings-runtime";
import { hisab } from "./hisab-kitab";
import { memory } from "./self/memory-engine";
import {
  archiveHonestyNote,
  capPromptText,
  chunkText,
  classifyLibraryType,
  isArchiveName,
  isSheetName,
  isTextFileName,
  libraryChunkSource,
  looksLikeLibraryCreate,
  looksLikeLibraryEdit,
  looksLikeLibraryTeach,
  type LibraryOrigin,
  type LibraryRecord,
  type LibrarySource,
  type LibraryType,
} from "./library-logic";

export type { LibraryOrigin, LibraryRecord, LibrarySource, LibraryType } from "./library-logic";
export {
  archiveHonestyNote,
  capPromptText,
  chunkText,
  classifyLibraryType,
  isArchiveName,
  isSheetName,
  isTextFileName,
  libraryChunkSource,
  looksLikeLibraryCreate,
  looksLikeLibraryEdit,
  looksLikeLibraryTeach,
  libraryTypeHonesty,
  LIBRARY_UPLOAD_CAP,
} from "./library-logic";

type IngestInput = {
  name: string;
  mime?: string;
  bytes?: Uint8Array | number[];
  text?: string;
  origin?: LibraryOrigin;
  source?: LibrarySource;
  extract?: {
    text?: string;
    error?: string;
    members?: { name: string; size: number; skipped?: string }[];
    skipped?: string[];
    truncated?: boolean;
    rows?: Record<string, string>[];
  };
};

type LibraryBridge = {
  libraryList?: () => Promise<{
    ok: boolean;
    items: LibraryRecord[];
    dir?: string;
    error?: string;
  }>;
  libraryIngest?: (
    payload: Record<string, unknown>,
  ) => Promise<{ ok: boolean; item?: LibraryRecord; error?: string }>;
  libraryGet?: (
    id: string,
  ) => Promise<{ ok: boolean; item?: LibraryRecord; text?: string; error?: string }>;
  libraryDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  libraryReveal?: (id: string) => Promise<boolean>;
  libraryZip?: (ids: string[]) => Promise<{ ok: boolean; item?: LibraryRecord; error?: string }>;
  libraryScan?: () => Promise<{ ok: boolean; items: LibraryRecord[]; error?: string }>;
  libraryWrite?: (
    payload: Record<string, unknown>,
  ) => Promise<{ ok: boolean; item?: LibraryRecord; error?: string }>;
  libraryPin?: (payload: {
    id: string;
    pinned: boolean;
  }) => Promise<{ ok: boolean; item?: LibraryRecord }>;
  libraryPatch?: (payload: {
    id: string;
    pinnedForAuto?: boolean;
    hisabLinked?: boolean;
    memoryIds?: string[];
  }) => Promise<{ ok: boolean; item?: LibraryRecord; error?: string }>;
  extractDocument?: (payload: {
    filename: string;
    bytes?: number[] | Uint8Array;
    text?: string;
  }) => Promise<{
    text?: string;
    error?: string;
    kind?: string;
    rows?: Record<string, string>[];
    members?: { name: string; size: number; skipped?: string }[];
    skipped?: string[];
    truncated?: boolean;
  }>;
};

function bridge(): LibraryBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.friday as unknown as LibraryBridge | undefined;
}

function sha256Lite(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let h = 2166136261;
  for (let i = 0; i < data.length; i += 1) h = Math.imul(h ^ data[i]!, 16777619);
  return `fnv1a-${(h >>> 0).toString(16)}-${data.length}`;
}

let seq = 0;
const nextId = () => `lib-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

class LibraryEngine {
  private items: LibraryRecord[] = [];
  private loaded = false;
  private dir = "";
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
  }

  resetForTests(): void {
    this.loaded = true;
    this.items = [];
    this.dir = "";
    this.emit();
  }

  dirPath(): string {
    return this.dir;
  }

  getSnapshot(): { items: LibraryRecord[]; desktop: boolean; dir: string } {
    this.load();
    return { items: [...this.items], desktop: Boolean(bridge()?.libraryList), dir: this.dir };
  }

  list(): LibraryRecord[] {
    this.load();
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): LibraryRecord | undefined {
    this.load();
    return this.items.find((item) => item.id === id);
  }

  pinnedForAuto(): LibraryRecord[] {
    return this.list().filter((item) => item.pinnedForAuto);
  }

  private upsert(record: LibraryRecord) {
    this.load();
    const idx = this.items.findIndex((item) => item.id === record.id);
    if (idx >= 0) this.items[idx] = record;
    else this.items.unshift(record);
    this.emit();
  }

  private persistMeta(item: LibraryRecord): void {
    const api = bridge();
    if (api?.libraryPatch) {
      void api.libraryPatch({
        id: item.id,
        pinnedForAuto: item.pinnedForAuto,
        hisabLinked: item.hisabLinked,
        memoryIds: item.memoryIds,
      });
    }
  }

  async refreshFromDesktop(): Promise<LibraryRecord[]> {
    const api = bridge();
    if (!api?.libraryList) return this.list();
    const listed = await api.libraryList();
    if (listed?.ok && Array.isArray(listed.items)) {
      this.items = listed.items;
      if (listed.dir) this.dir = listed.dir;
      this.loaded = true;
      this.emit();
    }
    return this.list();
  }

  async fetchText(id: string): Promise<LibraryRecord | null> {
    const api = bridge();
    if (api?.libraryGet) {
      const remote = await api.libraryGet(id);
      if (remote?.ok && remote.item) {
        const text = remote.text ?? remote.item.text;
        const item = text ? { ...remote.item, text } : { ...remote.item };
        this.upsert(item);
        return item;
      }
    }
    return this.get(id) ?? null;
  }

  async ingest(input: IngestInput): Promise<LibraryRecord> {
    this.load();
    const name = String(input.name || "untitled").replace(/[\\/]+/g, "_");
    const mime = input.mime || "application/octet-stream";
    const bytes = input.bytes
      ? input.bytes instanceof Uint8Array
        ? input.bytes
        : Uint8Array.from(input.bytes)
      : undefined;
    const extract = input.extract;
    const text = extract?.text || input.text || "";
    const now = Date.now();
    const hash = sha256Lite(bytes ?? text);
    const existing = this.items.find((item) => item.hash === hash && item.name === name);
    const id = existing?.id || nextId();
    const record: LibraryRecord = {
      id,
      name,
      type: classifyLibraryType(name, mime),
      origin: input.origin || existing?.origin || "uploaded",
      source: input.source || existing?.source || "chat",
      mime,
      size: bytes?.byteLength ?? text.length,
      hash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      relativePath: existing?.relativePath || `library/items/${id}/${name}`,
      truncated: Boolean(extract?.truncated) || text.length > 24_000,
      totalChars: text.length,
      chunkCount: chunkText(text).length,
      memoryIds: existing?.memoryIds ? [...existing.memoryIds] : [],
      hisabLinked: existing?.hisabLinked ?? false,
      pinnedForAuto: existing?.pinnedForAuto ?? false,
      version: existing ? existing.version + 1 : 1,
    };
    const honesty: Parameters<typeof archiveHonestyNote>[0] = { totalChars: text.length };
    if (record.truncated) honesty.truncated = true;
    if (extract?.skipped) honesty.skipped = extract.skipped;
    if (record.chunkCount) honesty.chunkCount = record.chunkCount;
    const note = extract?.error || archiveHonestyNote(honesty);
    if (note) record.extractNote = note;
    if (extract?.members) record.members = extract.members;
    if (extract?.skipped) record.skipped = extract.skipped;
    if (extract?.error) record.error = extract.error;
    if (text) record.text = text;
    if (existing?.versionOf) record.versionOf = existing.versionOf;
    const api = bridge();
    if (api?.libraryIngest && bytes) {
      const remote = await api.libraryIngest({
        name,
        mime,
        bytes: Array.from(bytes),
        origin: record.origin,
        source: record.source,
        text,
        extract,
        id,
      });
      if (remote?.ok && remote.item) {
        const item = { ...remote.item, text: remote.item.text ?? text };
        this.upsert(item);
        return item;
      }
    }
    this.upsert(record);
    return record;
  }

  async scan(): Promise<LibraryRecord[]> {
    const api = bridge();
    if (!api?.libraryScan) return this.list();
    const scanned = await api.libraryScan();
    if (scanned?.ok && Array.isArray(scanned.items)) {
      this.items = scanned.items;
      this.loaded = true;
      this.emit();
    }
    return this.list();
  }

  async writeText(input: {
    name: string;
    text: string;
    origin?: LibraryOrigin;
    source?: LibrarySource;
    versionOf?: string;
  }): Promise<LibraryRecord> {
    const body = String(input.text || "");
    const api = bridge();
    if (api?.libraryWrite) {
      const remote = await api.libraryWrite({
        name: input.name,
        text: body,
        origin: input.origin || "generated",
        source: input.source || "generate",
        versionOf: input.versionOf,
      });
      if (remote?.ok && remote.item) {
        const item = { ...remote.item, text: body };
        this.upsert(item);
        return item;
      }
    }
    return this.ingest({
      name: input.name,
      mime: "text/plain",
      text: body,
      origin: input.origin || "generated",
      source: input.source || "generate",
      extract: { text: body },
    });
  }

  async editText(
    id: string,
    nextText: string,
    confirmOverwrite = false,
  ): Promise<LibraryRecord | null> {
    const current = this.get(id);
    if (!current) return null;
    if (!confirmOverwrite) {
      return this.writeText({
        name: current.name,
        text: nextText,
        origin: "modified",
        source: "edit",
        versionOf: current.id,
      });
    }
    const updated: LibraryRecord = {
      ...current,
      text: nextText,
      origin: "modified",
      source: "edit",
      updatedAt: Date.now(),
      totalChars: nextText.length,
      chunkCount: chunkText(nextText).length,
      truncated: nextText.length > 24_000,
    };
    this.upsert(updated);
    return updated;
  }

  remove(id: string): boolean {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length !== before) this.emit();
    const api = bridge();
    if (api?.libraryDelete) void api.libraryDelete(id);
    return this.items.length !== before;
  }

  pin(id: string, pinned: boolean): LibraryRecord | null {
    const item = this.get(id);
    if (!item) return null;
    item.pinnedForAuto = pinned;
    item.updatedAt = Date.now();
    this.upsert(item);
    const api = bridge();
    if (api?.libraryPin) void api.libraryPin({ id, pinned });
    else this.persistMeta(item);
    return item;
  }

  async zipSelected(ids: string[]): Promise<LibraryRecord | { error: string }> {
    const api = bridge();
    if (api?.libraryZip) {
      const remote = await api.libraryZip(ids);
      if (remote?.ok && remote.item) {
        this.upsert(remote.item);
        return remote.item;
      }
      return { error: remote?.error || "Could not zip those Library items." };
    }
    const picked = ids.map((id) => this.get(id)).filter(Boolean) as LibraryRecord[];
    if (!picked.length) return { error: "Select Library items first." };
    const listing = picked.map((item) => `${item.name} (${item.size} B)`).join("\n");
    return this.writeText({
      name: `library-pack-${Date.now().toString(36)}.txt`,
      text: `Zip packing runs in the desktop app (store-method ZIP under FRIDAY_ROOT/library). Preview listing:\n${listing}`,
      origin: "generated",
      source: "library",
    });
  }

  /**
   * Persist extract chunks into the one memory engine with library source ids.
   * Sensitive / ledger-like text is refused. Hisab sheets belong on the ledger.
   */
  teach(
    id: string,
    reason = "teach",
  ): { ok: boolean; chunks: number; skipped: string; item?: LibraryRecord } {
    const item = this.get(id);
    if (!item) return { ok: false, chunks: 0, skipped: "No Library item with that id." };
    const body = String(item.text || "");
    if (!body.trim()) {
      return {
        ok: false,
        chunks: 0,
        skipped: "This item has no extractable text to remember.",
        item,
      };
    }
    if (looksSensitive(body) || looksSensitive(item.name)) {
      return {
        ok: false,
        chunks: 0,
        skipped:
          "This looks like secrets, keys, PIN, or ledger-marked text. I will not store it in casual memory. Hisab stays on the books ledger.",
        item,
      };
    }
    if (item.hisabLinked) {
      return {
        ok: false,
        chunks: 0,
        skipped:
          "This sheet is already on the hisab ledger. Ask by payee name; I will not copy money into casual memory.",
        item,
      };
    }
    const chunks = chunkText(body);
    const stored = memory.getSnapshot().items ?? [];
    const ids: string[] = [];
    chunks.forEach((chunk, index) => {
      const source = libraryChunkSource(item.id, item.name, index);
      const already = stored.find((row) => row.source === source && !row.supersededAt);
      if (already && already.text === chunk) {
        ids.push(already.id);
        return;
      }
      const remembered = memory.remember({
        tier: "semantic",
        kind: "episodic",
        title: `${item.name} · chunk ${index + 1}/${chunks.length}`,
        text: chunk,
        tags: ["library", "document", reason],
        source,
        confidence: 0.86,
        context: `library:${item.id}`,
        verified: true,
      });
      ids.push(remembered.id);
    });
    item.memoryIds = [...new Set([...item.memoryIds, ...ids])];
    item.chunkCount = chunks.length;
    item.updatedAt = Date.now();
    this.upsert(item);
    this.persistMeta(item);
    return { ok: true, chunks: chunks.length, skipped: "", item };
  }

  teachMany(ids: string[], reason = "teach"): { ok: boolean; chunks: number; notes: string[] } {
    const notes: string[] = [];
    let chunks = 0;
    let any = false;
    for (const id of ids) {
      const result = this.teach(id, reason);
      if (result.ok) {
        any = true;
        chunks += result.chunks;
        notes.push(`Taught ${result.item?.name ?? id}: ${result.chunks} chunk(s).`);
      } else {
        notes.push(result.skipped);
      }
    }
    return { ok: any, chunks, notes };
  }

  linkHisab(id: string): void {
    const item = this.get(id);
    if (!item) return;
    item.hisabLinked = true;
    item.updatedAt = Date.now();
    this.upsert(item);
    this.persistMeta(item);
  }

  importSheetIfBooks(id: string): { imported: number; skipped: number; note: string } | null {
    const item = this.get(id);
    if (!item || !isSheetName(item.name) || !item.text) return null;
    const result = hisab.importCsv(item.text, `library:${item.id}`);
    if (result.added) {
      this.linkHisab(id);
      return {
        imported: result.added,
        skipped: "skipped" in result ? Number(result.skipped) || 0 : 0,
        note: `Imported ${result.added} row(s) into the hisab ledger from Library ${item.name}. ${hisab.formatReport()}`,
      };
    }
    return {
      imported: 0,
      skipped: "skipped" in result ? Number(result.skipped) || 0 : 0,
      note: `I read ${item.name} as a table but could not turn any row into a debit or credit.`,
    };
  }
}

export const library = new LibraryEngine();

export function handleLibraryChat(prompt: string): { text: string } | null {
  const text = String(prompt || "").trim();
  if (!text) return null;

  const create = looksLikeLibraryCreate(text);
  if (create?.[1] && create[2]) {
    const name = create[1].trim();
    const body = create[2].trim();
    void library.writeText({ name, text: body, origin: "generated", source: "chat" });
    return {
      text: `Created Library file ${name} inside FRIDAY. Open Library to preview, teach, or zip it. I did not send it to an external editor.`,
    };
  }

  const edit = looksLikeLibraryEdit(text);
  if (edit?.[1] && edit[2] != null && edit[3] != null) {
    const name = edit[1].trim();
    const from = edit[2];
    const to = edit[3];
    const item = library.list().find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (!item?.text) {
      return {
        text: `I have no Library text file named ${name} yet. Attach it or create it first.`,
      };
    }
    if (!item.text.includes(from)) {
      return {
        text: `I found ${name} but that paragraph is not in the stored text. I will not guess a replacement.`,
      };
    }
    void library.editText(item.id, item.text.split(from).join(to), false);
    return {
      text: `Saved a modified copy of ${name} in Library (history kept; original not overwritten).`,
    };
  }

  return null;
}

export function shouldAutoTeach(): boolean {
  return shouldRememberChats();
}

export function formatLibraryCitation(item: LibraryRecord, chunkIndex?: number): string {
  const chunk = chunkIndex != null ? ` chunk ${chunkIndex + 1}` : "";
  return `${item.name} (library:${item.id}${chunk})`;
}
