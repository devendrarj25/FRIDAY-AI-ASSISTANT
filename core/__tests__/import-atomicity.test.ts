import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const importer = require_(path.resolve(process.cwd(), "electron/importer.cjs"));
const transaction = require_(path.resolve(process.cwd(), "electron/import-transaction.cjs"));
const roots: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-import-atomic-"));
  roots.push(dir);
  return dir;
};
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

describe("import transactions", () => {
  it("restores changed content and removes a top-level area that was newly created", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "settings.json"), "before");
    const saved = transaction.createBackup({
      root,
      prefix: "import",
      tops: ["config", "electron"],
    });
    fs.writeFileSync(path.join(root, "config", "settings.json"), "after");
    fs.mkdirSync(path.join(root, "electron"), { recursive: true });
    fs.writeFileSync(path.join(root, "electron", "main.cjs"), "new");

    expect(transaction.restoreBackup({ root, backup: saved.backup }).ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "config", "settings.json"), "utf8")).toBe("before");
    expect(fs.existsSync(path.join(root, "electron"))).toBe(false);
  });

  it("rejects a backup outside this workspace and a backup from another root", () => {
    const root = temp();
    const other = temp();
    const saved = transaction.createBackup({ root: other, prefix: "import", tops: ["config"] });
    expect(transaction.restoreBackup({ root, backup: saved.backup }).ok).toBe(false);
    expect(transaction.restoreBackup({ root, backup: root }).ok).toBe(false);
  });

  it("persists only validated staged scans and reloads them after a restart", () => {
    const root = temp();
    const contentRoot = path.join(root, "updates", "import-safe");
    fs.mkdirSync(contentRoot, { recursive: true });
    const scan = { ok: true, id: "safe", contentRoot, files: [], areas: [] };
    expect(importer.saveScan(root, scan)).toBe(true);
    expect(importer.loadScans(root).map((item: { id: string }) => item.id)).toEqual(["safe"]);
    expect(importer.saveScan(root, { ...scan, id: "outside", contentRoot: otherPath(root) })).toBe(
      false,
    );
  });
});

function otherPath(root: string) {
  return path.join(path.dirname(root), "outside-import");
}
