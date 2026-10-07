/**
 * FRIDAY · core/paths
 *
 * Small real filesystem helpers shared by the installer/updater/builder/testing
 * modules. Everything is synchronous-but-cheap directory work; nothing here
 * fabricates a result — a missing path returns an empty list, not a fake entry.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface DirEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modified: number;
}

export function listDir(dir: string): DirEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DirEntry[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let size = 0;
    let modified = 0;
    try {
      const stat = fs.statSync(full);
      size = stat.size;
      modified = stat.mtimeMs;
    } catch {
      /* unreadable entry — reported with zeroes rather than dropped */
    }
    out.push({ name: entry.name, path: full, directory: entry.isDirectory(), size, modified });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function ensureDirs(
  root: string,
  folders: string[],
): { created: string[]; existing: string[] } {
  const created: string[] = [];
  const existing: string[] = [];
  for (const folder of folders) {
    const full = path.join(root, folder);
    if (fs.existsSync(full)) existing.push(folder);
    else {
      fs.mkdirSync(full, { recursive: true });
      created.push(folder);
    }
  }
  return { created, existing };
}

export function readJson<T = Record<string, unknown>>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(file: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Counts files under a folder without following symlinks; bounded for speed. */
export function countFiles(dir: string, limit = 20_000): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  const stack = [dir];
  while (stack.length && files < limit) {
    const current = stack.pop()!;
    for (const entry of listDir(current)) {
      if (entry.directory) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        folders += 1;
        stack.push(entry.path);
      } else files += 1;
    }
  }
  return { files, folders };
}

export function hashFile(file: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

export function exists(target: string): boolean {
  return fs.existsSync(target);
}

/** Recursively finds files matching a suffix (used by the testing modules). */
export function findFiles(dir: string, suffix: string, limit = 500): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const current = stack.pop()!;
    for (const entry of listDir(current)) {
      if (entry.directory) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist")
          continue;
        stack.push(entry.path);
      } else if (entry.name.endsWith(suffix)) out.push(entry.path);
    }
  }
  return out.sort();
}

/* --------------------------------------------------- canonical FRIDAY root */
// core/paths only provides filesystem helpers; the authoritative root and the
// canonical folder contract live in electron/friday-contract.cjs, which the
// Electron path service (friday-paths.cjs), workspace verification and
// capability discovery all read. These thin delegates exist so a TypeScript
// caller never rebuilds its own root or folder list.
import { createRequire } from "node:module";

const contract = createRequire(import.meta.url)("../electron/friday-contract.cjs") as {
  NAMES: string[];
  candidates: (name: string) => string[] | null;
  requiredFolders: () => string[];
  rootFromEnv: () => string | null;
  requireRoot: () => string;
};

/**
 * The one canonical FRIDAY root for this process. There is no process.cwd()
 * fallback: persistent FRIDAY data only ever lives inside the selected root.
 */
export const fridayRoot = (): string => contract.requireRoot();

/** The selected root, or null when the user has not chosen one yet. */
export const fridayRootOrNull = (): string | null => contract.rootFromEnv();

/** Absolute path of a canonical folder inside a root (existing alias wins). */
export function fridayDir(name: string, root: string = fridayRoot()): string {
  const options = contract.candidates(name);
  if (!options) throw new Error(`Unknown FRIDAY path: ${name}`);
  for (const option of options) {
    const full = path.join(root, ...option.split("/"));
    if (fs.existsSync(full)) return full;
  }
  return path.join(root, ...options[0]!.split("/"));
}

/** Every folder the canonical contract requires, as root-relative paths. */
export const fridayFolders = (): string[] => contract.requiredFolders();
