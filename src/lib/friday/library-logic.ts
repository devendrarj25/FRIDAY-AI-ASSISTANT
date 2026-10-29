/**
 * FRIDAY · library logic (pure)
 *
 * Chunking, type labels, teach-intent, archive notes, and citations. Disk and
 * IPC live in `electron/library.cjs` / `library-engine.ts`. No second vector DB.
 */

export const LIBRARY_CHUNK_CHARS = 3_600;
export const LIBRARY_CHUNK_OVERLAP = 400;
export const LIBRARY_PROMPT_CHARS = 24_000;
export const LIBRARY_PIN_CHARS = 1_800;
export const LIBRARY_MAX_TEACH_CHUNKS = 80;
export const LIBRARY_UPLOAD_CAP = 12;

export type LibraryOrigin = "uploaded" | "generated" | "modified";
export type LibrarySource = "chat" | "auto" | "teach" | "generate" | "edit" | "library";
export type LibraryType = "doc" | "sheet" | "image" | "audio" | "video" | "zip" | "other";

export type LibraryMember = {
  name: string;
  size: number;
  skipped?: string;
};

export type LibraryRecord = {
  id: string;
  name: string;
  type: LibraryType;
  origin: LibraryOrigin;
  source: LibrarySource;
  mime: string;
  size: number;
  hash: string;
  createdAt: number;
  updatedAt: number;
  relativePath: string;
  extractNote?: string;
  truncated?: boolean;
  totalChars?: number;
  chunkCount?: number;
  memoryIds: string[];
  hisabLinked: boolean;
  pinnedForAuto: boolean;
  version: number;
  versionOf?: string;
  members?: LibraryMember[];
  skipped?: string[];
  error?: string;
  /** Full extract kept for teach; not dumped wholesale into a chat prompt. */
  text?: string;
};

export type LibraryChunk = {
  index: number;
  text: string;
  source: string;
};

export function classifyLibraryType(name: string, mime = ""): LibraryType {
  const lower = String(name || "").toLowerCase();
  const kind = String(mime || "").toLowerCase();
  if (kind.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(lower)) return "image";
  if (kind.startsWith("audio/") || /\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(lower)) return "audio";
  if (kind.startsWith("video/") || /\.(mp4|mov|mkv|avi)$/i.test(lower)) return "video";
  if (/\.(zip|tar\.gz|tgz)$/i.test(lower)) return "zip";
  if (/\.(csv|tsv|xlsx|xlsm)$/i.test(lower)) return "sheet";
  if (/\.(pdf|docx|txt|md|markdown|json|jsonc|html?|xml)$/i.test(lower)) return "doc";
  return "other";
}

export function isArchiveName(name: string): boolean {
  return /\.(zip|tar\.gz|tgz)$/i.test(String(name || ""));
}

export function isOfficeName(name: string): boolean {
  return /\.(pdf|docx|xlsx|xlsm)$/i.test(String(name || ""));
}

export function isSheetName(name: string): boolean {
  return /\.(csv|tsv|xlsx|xlsm)$/i.test(String(name || ""));
}

export function isTextFileName(name: string): boolean {
  return /\.(txt|md|markdown|json|jsonc|csv|tsv|html?|xml)$/i.test(String(name || ""));
}

/** Honest empty-extract note so Chat/Auto never invent unread pixels or audio. */
export function libraryTypeHonesty(item: {
  type: LibraryType;
  text?: string;
  error?: string;
  name?: string;
}): string {
  if (item.error) return item.error;
  if (item.type === "image") {
    return "Image: chat IPC is text-only. I cannot see these pixels and will not invent what is in the picture.";
  }
  if (item.type === "audio") {
    return "Audio-file STT is not built. I will not invent a transcript.";
  }
  if (item.type === "video") {
    return "I did not watch this video. Name, type and size only.";
  }
  if (!String(item.text || "").trim()) return "No extractable text stored on this Library item.";
  return "";
}

export function isAudioName(name: string, mime = ""): boolean {
  return (
    String(mime || "").startsWith("audio/") ||
    /\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(String(name || ""))
  );
}

export function isVideoName(name: string, mime = ""): boolean {
  return (
    String(mime || "").startsWith("video/") || /\.(mp4|mov|mkv|avi)$/i.test(String(name || ""))
  );
}

function lastNaturalBreak(window: string): number {
  const tokens = ["\n\n", "\n", ". ", "। ", "? ", "! "];
  let best = -1;
  for (const token of tokens) {
    const idx = window.lastIndexOf(token);
    if (idx > best) best = idx + token.length;
  }
  return best;
}

/** Split long books/registers into overlapping chunks. Prefer sentence/paragraph cuts. Never silent 24k-only. */
export function chunkText(
  text: string,
  size = LIBRARY_CHUNK_CHARS,
  overlap = LIBRARY_CHUNK_OVERLAP,
): string[] {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  if (raw.length <= size) return [raw];
  const out: string[] = [];
  let start = 0;
  while (start < raw.length && out.length < LIBRARY_MAX_TEACH_CHUNKS) {
    let end = Math.min(raw.length, start + size);
    if (end < raw.length) {
      const cut = lastNaturalBreak(raw.slice(start, end));
      if (cut >= Math.floor(size * 0.6)) end = start + cut;
    }
    out.push(raw.slice(start, end));
    if (end >= raw.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

export function libraryChunkSource(
  itemId: string,
  filename: string,
  index: number,
  page?: number,
): string {
  const pageBit = page != null ? `:page:${page}` : "";
  return `library:${itemId}:${filename}${pageBit}:chunk:${index}`;
}

export function capPromptText(
  text: string,
  cap = LIBRARY_PROMPT_CHARS,
): { text: string; truncated: boolean; totalChars: number } {
  const raw = String(text || "");
  if (raw.length <= cap) return { text: raw, truncated: false, totalChars: raw.length };
  return {
    text: `${raw.slice(0, cap)}\n…[truncated ${raw.length - cap} characters; full text is stored on the Library item and will be taught in chunks if you say yaad rakh]`,
    truncated: true,
    totalChars: raw.length,
  };
}

export function looksLikeLibraryTeach(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  if (
    /\b(isse knowledge badhao|knowledge badhao|baad me isi se jawab|add to knowledge|sikhao|seekh(?:o|na)|teach (?:from |me )?(?:this|these|the file)|index this|grow knowledge)\b/i.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /^(?:please\s+)?(?:yaad rakh(?:na|o)?(?:\s+(?:yeh|this|these|isi|is file|the file))?|remember this(?: file| pdf| zip| document| sheet)?)\b/i.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /\bremember (?:this|these) (?:file|pdf|zip|document|sheet|image|attachment)s?\b/i.test(value)
  ) {
    return true;
  }
  return false;
}

export function looksLikeLibraryCreate(text: string): RegExpMatchArray | null {
  return String(text || "").match(
    /^(?:please\s+)?(?:create|write|banao|bana do|generate)\s+(?:a |an |ek )?(?:file |document )?(?:named |called |naam )?(?:[`"'“”]?)([^`"'“”\s]+\.(?:md|txt|csv|json))(?:[`"'“”]?)\s*(?:with|containing|jisme|:)\s+([\s\S]+)/i,
  );
}

export function looksLikeLibraryEdit(text: string): RegExpMatchArray | null {
  return String(text || "").match(
    /^(?:please\s+)?(?:in |file )?([^\s]+\.(?:md|txt|csv|json))\s+(?:replace|badlo|change)\s+["'“”](.+?)["'“”]\s+(?:with|se|to)\s+["'“”](.+?)["'“”]/i,
  );
}

export function archiveHonestyNote(record: {
  truncated?: boolean;
  skipped?: string[];
  totalChars?: number;
  chunkCount?: number;
}): string {
  const bits: string[] = [];
  if (record.truncated) bits.push("extract was partial");
  if (record.skipped?.length) bits.push(`skipped: ${record.skipped.slice(0, 6).join("; ")}`);
  if ((record.totalChars ?? 0) > LIBRARY_PROMPT_CHARS) {
    bits.push(
      `${record.totalChars} characters stored; prompt shows a cap of ${LIBRARY_PROMPT_CHARS}`,
    );
  }
  if (record.chunkCount && record.chunkCount > 1)
    bits.push(`${record.chunkCount} chunks for later retrieve`);
  return bits.join(". ");
}
