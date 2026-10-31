/**
 * FRIDAY · new files in the folders the owner already shares
 *
 * The kernel lists the top level of the folders FRIDAY may read (his workspace and `read_roots`) and says what
 * appeared since the last look. This keeps the last answer for the morning and evening digest to mention in
 * one line. It reads names only, never contents, and the first look of a folder only records what is there.
 */

import { kernelApi } from "./kernel-api";
import { prefOn } from "./settings-runtime";

export type NewFile = { folder: string; name: string; new: boolean };

let pending: NewFile[] = [];

export function takePendingFiles(): NewFile[] {
  const out = pending;
  pending = [];
  return out;
}

export function peekPendingFiles(): NewFile[] {
  return pending;
}

/** One short digest line, or null when nothing arrived. Several files in one folder are grouped. */
export function filesLine(files: readonly NewFile[]): string | null {
  if (!files.length) return null;
  const byFolder = new Map<string, string[]>();
  for (const file of files) {
    const list = byFolder.get(file.folder) ?? [];
    list.push(file.name);
    byFolder.set(file.folder, list);
  }
  const parts = [...byFolder].slice(0, 3).map(([folder, names]) => {
    const shown = names.slice(0, 2).join(", ");
    const more = names.length > 2 ? ` and ${names.length - 2} more` : "";
    return `${folder}: ${shown}${more}`;
  });
  return `New files: ${parts.join("; ")}.`;
}

export async function scanFolders(): Promise<{ added: number; note: string }> {
  if (!prefOn("proactiveDigest", true)) return { added: 0, note: "switched off" };
  try {
    const out = await kernelApi.watch.scan();
    const fresh = out?.files ?? [];
    pending = [...pending, ...fresh].slice(-40);
    return {
      added: fresh.length,
      note: fresh.length ? `${fresh.length} new file(s)` : "nothing new",
    };
  } catch {
    return { added: 0, note: "kernel offline" };
  }
}
