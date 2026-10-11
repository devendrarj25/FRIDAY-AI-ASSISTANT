/**
 * Compare paths without caring about slash direction. Windows also
 * ignores case. The comparison does not touch the filesystem.
 */
import path from "node:path";

export function canonicalPath(value: string): string {
  const slash = path.resolve(value).split(/[\\/]+/).join("/");
  return process.platform === "win32" ? slash.toLowerCase() : slash;
}

export function samePath(actual: string, expected: string): boolean {
  return canonicalPath(actual) === canonicalPath(expected);
}
