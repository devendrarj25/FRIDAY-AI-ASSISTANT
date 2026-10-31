/**
 * FRIDAY · project context for desktop work
 *
 * When a desktop request names a project folder or a file inside one ("open C:\work\shop\app.py and add a
 * header"), the run gets the repo map for that project (`code.map`, a safe read-only tool) so the plan and
 * the report know the files and symbols around the task. The map is tool output: it is trimmed, its secrets are
 * scrubbed and any line that reads as an order is cut before it is shown. A path outside the folders FRIDAY may
 * read simply gives no context; nothing here writes or opens anything.
 */

import { quarantine } from "../brain/quarantined-reader";

export type CodeMapPort = (
  path: string,
  budget: number,
) => Promise<{ ok?: boolean; text?: string } | null | undefined>;

const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s]+\\?)+/g;
const POSIX_PATH = /(?<![\w.])\/(?:[\w.@-]+\/)+[\w.@-]*/g;
const FILE_SUFFIX = /\.[A-Za-z0-9]{1,6}$/;

/** Folders named in the text, with a file's folder standing in for the file. First two only. */
export function projectFoldersIn(text: string): string[] {
  const found = [...(text.match(WINDOWS_PATH) ?? []), ...(text.match(POSIX_PATH) ?? [])]
    .map((raw) => raw.replace(/[.,;:)\]]+$/, ""))
    .map((raw) => {
      if (!FILE_SUFFIX.test(raw)) return raw.replace(/[\\/]+$/, "");
      const cut = Math.max(raw.lastIndexOf("\\"), raw.lastIndexOf("/"));
      return cut > 2 ? raw.slice(0, cut) : "";
    })
    .filter((folder) => folder.length > 3);
  return [...new Set(found)].slice(0, 2);
}

export type CodeContext = { folder: string; text: string };

export async function codeContextFor(
  request: string,
  codeMap: CodeMapPort,
  budget = 600,
): Promise<CodeContext[]> {
  const out: CodeContext[] = [];
  for (const folder of projectFoldersIn(String(request || ""))) {
    try {
      const map = await codeMap(folder, budget);
      if (!map?.ok || !map.text) continue;
      const safe = quarantine(map.text).text.slice(0, 1500);
      if (safe.trim()) out.push({ folder, text: safe });
    } catch {
      /* no context is not an error */
    }
  }
  return out;
}
