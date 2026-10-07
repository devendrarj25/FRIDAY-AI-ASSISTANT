/**
 * FRIDAY · chat attachments
 *
 * Real file intake for Manual Mode. A dropped or picked file is actually read
 * here — text and code are extracted verbatim, archives are listed and
 * unpacked in a capped sandbox, images become data URLs, and anything binary
 * is described by its real metadata. Nothing is invented: if a file cannot be
 * read, the attachment says so and FRIDAY is told not to pretend she saw it.
 *
 * Successful reads also become Library items (same SOT Chat and Library share).
 */

import { library } from "./library-engine";
import {
  capPromptText,
  classifyLibraryType,
  isArchiveName,
  isAudioName,
  isVideoName,
  LIBRARY_UPLOAD_CAP,
} from "./library-logic";

export type AttachmentKind = "text" | "image" | "binary" | "archive";

export type Attachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Bytes on disk, from the real File object. */
  size: number;
  mime: string;
  /** Extracted text for text-like files (truncated for the prompt). */
  text?: string;
  /** data: URL for images, so a vision model can actually see it. */
  dataUrl?: string;
  /** Set when the file could not be read. */
  error?: string;
  libraryId?: string;
  truncated?: boolean;
  totalChars?: number;
  extractNote?: string;
};

const MAX_TEXT = 24_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|html?|xml|svg|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|bat|cmd|sql|gradle|dockerfile|gitignore)$/i;

/** Office / PDF types the existing document-extract engine can read. */
export const OFFICE_EXT = /\.(pdf|docx|xlsx|xlsm)$/i;

type ExtractBridge = {
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

function extractApi(): ExtractBridge["extractDocument"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window.friday as unknown as ExtractBridge | undefined)?.extractDocument;
}

type ExtractPayload = NonNullable<Parameters<typeof library.ingest>[0]["extract"]>;

function compactExtract(extract: ExtractPayload): ExtractPayload {
  const payload: ExtractPayload = {};
  if (extract.text) payload.text = extract.text;
  if (extract.error) payload.error = extract.error;
  if (extract.members) payload.members = extract.members;
  if (extract.skipped) payload.skipped = extract.skipped;
  if (extract.truncated) payload.truncated = extract.truncated;
  if (extract.rows) payload.rows = extract.rows;
  return payload;
}

export function needsOfficeExtract(name: string): boolean {
  return OFFICE_EXT.test(name);
}

export function needsArchiveExtract(name: string): boolean {
  return isArchiveName(name);
}

let seq = 0;
const nextId = () => `att-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

function kindOf(file: File): AttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (isArchiveName(file.name)) return "archive";
  if (file.type.startsWith("text/") || TEXT_EXT.test(file.name)) return "text";
  if (/^(application\/(json|xml|javascript|x-yaml|sql))$/.test(file.type)) return "text";
  if (needsOfficeExtract(file.name)) return "text";
  return "binary";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function extractViaDesktop(name: string, buf: Uint8Array) {
  const api = extractApi();
  if (!api) {
    return {
      error: `${isArchiveName(name) ? "Zip/tar" : "Office/PDF"} extract runs in the desktop app. Open FRIDAY on Windows to analyse this file — I will not guess its contents.`,
    };
  }
  return api({ filename: name, bytes: Array.from(buf) });
}

async function ingestLibrary(
  file: File,
  buf: Uint8Array | undefined,
  extract: ExtractPayload | undefined,
): Promise<string | undefined> {
  try {
    const item = await library.ingest({
      name: file.name,
      mime: file.type || "application/octet-stream",
      origin: "uploaded",
      source: "chat",
      ...(buf ? { bytes: buf } : {}),
      ...(extract?.text ? { text: extract.text } : {}),
      ...(extract ? { extract: compactExtract(extract) } : {}),
    });
    return item.id;
  } catch {
    return undefined;
  }
}

/** Read one real File into an attachment FRIDAY can actually reason about. */
export async function readAttachment(file: File): Promise<Attachment> {
  const base: Attachment = {
    id: nextId(),
    name: file.name,
    kind: kindOf(file),
    size: file.size,
    mime: file.type || "application/octet-stream",
  };
  try {
    if (
      base.kind === "archive" ||
      (base.kind === "text" && (needsOfficeExtract(file.name) || isArchiveName(file.name)))
    ) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const extracted = await extractViaDesktop(file.name, buf);
      if (extracted?.error && !extracted.text) {
        const libraryId = await ingestLibrary(file, buf, extracted);
        return {
          ...base,
          kind: "binary",
          error: extracted.error,
          extractNote: extracted.error,
          ...(libraryId ? { libraryId } : {}),
        };
      }
      const raw = String(extracted?.text || "");
      const capped = capPromptText(raw, MAX_TEXT);
      const libraryId = await ingestLibrary(file, buf, {
        text: raw,
        ...(extracted?.error ? { error: extracted.error } : {}),
        ...(extracted?.members ? { members: extracted.members } : {}),
        ...(extracted?.skipped ? { skipped: extracted.skipped } : {}),
        truncated: Boolean(extracted?.truncated) || capped.truncated,
        ...(extracted?.rows ? { rows: extracted.rows } : {}),
      });
      const extractNote = [
        extracted?.skipped?.length ? `skipped: ${extracted.skipped.slice(0, 6).join("; ")}` : "",
        capped.truncated
          ? `prompt capped at ${MAX_TEXT}; full extract is on Library item ${libraryId || file.name}`
          : "",
      ]
        .filter(Boolean)
        .join(". ");
      return {
        ...base,
        kind: "text",
        text: capped.text,
        truncated: capped.truncated || Boolean(extracted?.truncated),
        totalChars: capped.totalChars,
        ...(extractNote ? { extractNote } : {}),
        ...(libraryId ? { libraryId } : {}),
      };
    }
    if (base.kind === "text") {
      const raw = await file.text();
      const buf = new TextEncoder().encode(raw);
      const capped = capPromptText(raw, MAX_TEXT);
      const libraryId = await ingestLibrary(file, buf, {
        text: raw,
        ...(capped.truncated ? { truncated: true } : {}),
      });
      return {
        ...base,
        text: capped.text,
        truncated: capped.truncated,
        totalChars: capped.totalChars,
        ...(capped.truncated
          ? {
              extractNote: `prompt capped at ${MAX_TEXT}; full text is stored on Library item ${libraryId || file.name}`,
            }
          : {}),
        ...(libraryId ? { libraryId } : {}),
      };
    }
    if (base.kind === "image") {
      if (file.size > MAX_IMAGE_BYTES) {
        return { ...base, error: `image is ${formatBytes(file.size)} — too large to analyse` };
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(file);
      });
      const libraryId = await ingestLibrary(file, buf, {
        error: "Chat IPC is text-only — I cannot see these pixels.",
      });
      return { ...base, dataUrl, ...(libraryId ? { libraryId } : {}) };
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const mediaError = isVideoName(file.name, file.type)
      ? "I did not watch this video. File STT/ffmpeg probe is not wired in this phase."
      : isAudioName(file.name, file.type)
        ? "Audio-file STT is not wired in this phase. Live mic STT stays on the existing voice path."
        : "";
    const libraryId = await ingestLibrary(
      file,
      buf,
      mediaError ? { error: mediaError } : undefined,
    );
    const ownerError = isVideoName(file.name, file.type)
      ? "I did not watch this video. I only have its name, type and size."
      : isAudioName(file.name, file.type)
        ? "Audio-file STT is not built yet. I will not invent a transcript."
        : "";
    return {
      ...base,
      ...(libraryId ? { libraryId } : {}),
      ...(ownerError ? { error: ownerError } : {}),
    };
  } catch (error) {
    return { ...base, error: (error as Error)?.message ?? "could not read this file" };
  }
}

export async function readAttachments(files: File[]): Promise<Attachment[]> {
  return Promise.all(files.slice(0, LIBRARY_UPLOAD_CAP).map((file) => readAttachment(file)));
}

/**
 * The instruction block handed to the model for this turn. Only real content
 * goes in; unreadable files are declared as unreadable.
 */
export function attachmentDirective(items: Attachment[]): {
  extra: string;
  hasImage: boolean;
} {
  if (!items.length) return { extra: "", hasImage: false };
  const parts: string[] = [
    `The owner attached ${items.length} file(s) to this message. Analyse what is actually below and answer about it. Never describe a file whose content is not present. Successful attaches are also Library items (same SOT).`,
  ];
  let hasImage = false;
  for (const item of items) {
    const lib = item.libraryId ? ` library:${item.libraryId}` : "";
    const head = `FILE: ${item.name} (${item.mime}, ${formatBytes(item.size)}${lib})`;
    if (item.error && !item.text) {
      parts.push(`${head}\n  Could not be read: ${item.error}. Say so instead of guessing.`);
      continue;
    }
    if (item.kind === "text" && item.text !== undefined) {
      const note = [
        item.truncated
          ? `Partial extract (${item.totalChars ?? item.text.length} chars total).`
          : "",
        item.extractNote || "",
      ]
        .filter(Boolean)
        .join(" ");
      parts.push(`${head}\n${note ? `  ${note}\n` : ""}--- content ---\n${item.text}\n--- end ---`);
      continue;
    }
    if (item.kind === "image" && item.dataUrl) {
      hasImage = true;
      parts.push(
        `${head}\n  An image was attached. A diagram reader may turn local OCR boxes into a flow chart. If that reader says the image was not read, say so. Do not guess pixels, and do not send a sensitive image to a cloud model.`,
      );
      continue;
    }
    parts.push(
      `${head}\n  Binary file — only its name, type and size are available. Do not claim to have read its contents.`,
    );
  }
  return { extra: parts.join("\n\n"), hasImage };
}

/** Image payloads for the vision route, in the order they were attached. */
export function imagePayloads(items: Attachment[]): string[] {
  return items
    .filter((item) => item.kind === "image" && item.dataUrl)
    .map((item) => item.dataUrl as string);
}

export { classifyLibraryType };
