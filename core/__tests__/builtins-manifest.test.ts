/**
 * builtins.json is the build-time record of every capability the installer
 * ships. One generator (scripts/builtins-manifest.cjs) writes it, so a local
 * CMD build and every workflow produce the same bytes, and the runtime can
 * tell a shipped built-in from a copy the owner made.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");

type Entry = { id: string; segment: string; path: string; version: string | null; sha256: string };
type Trees = Record<string, Entry[]> & {
  agents?: Entry[];
  skills?: Entry[];
  tools?: Entry[];
  workflows?: Entry[];
  models?: Entry[];
};
type Manifest = { schema: number; release: string; trees: Trees };
const builtins = require_(path.join(ROOT, "scripts", "builtins-manifest.cjs")) as {
  generate: (appRoot: string, opts?: { release?: string }) => Manifest;
  write: (appRoot: string, outFile: string, opts?: { release?: string }) => Manifest;
  verify: (appRoot: string, file: string) => { ok: boolean; problems: string[] };
};

let app = "";
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

const put = (rel: string, body: string) => {
  const file = path.join(app, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const folder = (rel: string, version = "1.0.0", extra: Record<string, string> = {}) => {
  put(`${rel}/manifest.json`, JSON.stringify({ name: rel, version }));
  for (const [name, body] of Object.entries(extra)) put(`${rel}/${name}`, body);
};
const ids = (m: Manifest) =>
  Object.values(m.trees)
    .flat()
    .map((e) => e.id)
    .sort();

beforeEach(() => {
  app = fs.mkdtempSync(path.join(os.tmpdir(), "friday-builtins-"));
});
afterEach(() => {
  fs.rmSync(app, { recursive: true, force: true });
});

describe("builtins.json generator", () => {
  it("writes the same bytes on two runs, whatever the folder order or timestamps", () => {
    folder("agents/core/alpha", "1.2.0", { "agent.md": "hello" });
    folder("skills/core/beta", "2.0.0");
    const first = path.join(app, "one.json");
    const second = path.join(app, "two.json");
    builtins.write(app, first, { release: "1.2.5.8" });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(app, "agents", "core", "alpha", "agent.md"), later, later);
    builtins.write(app, second, { release: "1.2.5.8" });
    const a = fs.readFileSync(first);
    expect(a.equals(fs.readFileSync(second))).toBe(true);
    expect(a.toString("utf8")).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("lists exactly the capabilities in the tree, with schema, release and relative paths", () => {
    folder("agents/core/alpha", "1.2.0");
    folder("tools/system/gamma", "0.1.0");
    put("tools/manifests/flat.json", JSON.stringify({ id: "tools/manifests/flat", name: "Flat" }));
    const m = builtins.generate(app, { release: "1.2.5.8" });
    expect(m.schema).toBe(1);
    expect(m.release).toBe("1.2.5.8");
    expect(ids(m)).toEqual(["agents/core/alpha", "tools/manifests/flat", "tools/system/gamma"]);
    const alpha = m.trees.agents?.[0];
    expect(alpha).toMatchObject({
      id: "agents/core/alpha",
      segment: "core",
      path: "agents/core/alpha",
      version: "1.2.0",
    });
    expect(alpha?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(m)).not.toContain(app);
  });

  it("hashes the sorted relpath, NUL, file hash lines under the item folder", () => {
    folder("skills/core/beta", "2.0.0", { "b.txt": "bee", "a/inner.txt": "ay" });
    const manifestText = JSON.stringify({ name: "skills/core/beta", version: "2.0.0" });
    const lines = [
      ["a/inner.txt", sha("ay")],
      ["b.txt", sha("bee")],
      ["manifest.json", sha(manifestText)],
    ]
      .map(([rel, hash]) => `${rel}\0${hash}\n`)
      .join("");
    expect(builtins.generate(app, { release: "1" }).trees.skills?.[0]?.sha256).toBe(sha(lines));
  });

  it("changes the item hash when a file inside it changes and leaves the others alone", () => {
    folder("agents/core/alpha", "1.0.0", { "x.txt": "one" });
    folder("agents/core/omega", "1.0.0");
    const before = builtins.generate(app, { release: "1" }).trees.agents ?? [];
    put("agents/core/alpha/x.txt", "two");
    const after = builtins.generate(app, { release: "1" }).trees.agents ?? [];
    const pick = (list: Entry[], id: string) => list.find((e) => e.id === id)?.sha256;
    expect(pick(after, "agents/core/alpha")).not.toBe(pick(before, "agents/core/alpha"));
    expect(pick(after, "agents/core/omega")).toBe(pick(before, "agents/core/omega"));
  });

  it("hashes text the same with CRLF or LF line ends so CMD and CI agree", () => {
    folder("agents/core/alpha", "1.0.0", { "note.txt": "a\nb\n" });
    const lf = builtins.generate(app, { release: "1" }).trees.agents?.[0]?.sha256;
    put("agents/core/alpha/note.txt", "a\r\nb\r\n");
    expect(builtins.generate(app, { release: "1" }).trees.agents?.[0]?.sha256).toBe(lf);
  });

  it("fails when two ids differ only by case", () => {
    put("tools/manifests/one.json", JSON.stringify({ id: "tools/manifests/dup", name: "A" }));
    put("tools/manifests/two.json", JSON.stringify({ id: "tools/manifests/DUP", name: "B" }));
    expect(() => builtins.generate(app, { release: "1" })).toThrow(/duplicate|case/i);
  });

  it("fails on an id that is not lowercase", () => {
    put("tools/manifests/up.json", JSON.stringify({ id: "tools/manifests/Upper", name: "U" }));
    expect(() => builtins.generate(app, { release: "1" })).toThrow(/lowercase/i);
  });

  it("keeps user-state segments and the models tree out of the manifest", () => {
    folder("agents/core/alpha");
    folder("workflows/saved/shipped");
    folder("workflows/active/running");
    folder("workflows/history/old-run");
    folder("workflows/schedules/nightly");
    folder("models/downloaded/weights");
    const m = builtins.generate(app, { release: "1" });
    expect(ids(m)).toEqual(["agents/core/alpha", "workflows/saved/shipped"]);
    expect(m.trees.models).toBeUndefined();
    expect(m.trees.workflows?.map((e) => e.segment)).toEqual(["saved"]);
  });

  it("verify passes on the tree it came from and names what drifted", () => {
    folder("agents/core/alpha", "1.0.0", { "x.txt": "one" });
    folder("skills/core/beta");
    const out = path.join(app, "builtins.json");
    builtins.write(app, out, { release: "1.2.5.8" });
    expect(builtins.verify(app, out)).toEqual({ ok: true, problems: [] });
    put("agents/core/alpha/x.txt", "changed");
    fs.rmSync(path.join(app, "skills", "core", "beta"), { recursive: true });
    const res = builtins.verify(app, out);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("agents/core/alpha");
    expect(res.problems.join("\n")).toContain("skills/core/beta");
  });

  it("verify reports a missing or unreadable file instead of throwing", () => {
    expect(builtins.verify(app, path.join(app, "nope.json")).ok).toBe(false);
    fs.writeFileSync(path.join(app, "bad.json"), "{not json");
    expect(builtins.verify(app, path.join(app, "bad.json")).ok).toBe(false);
  });

  it("describes the real source tree: unique lowercase ids, every item hashed", () => {
    const m = builtins.generate(ROOT, { release: "9.9.9.9" });
    const all = Object.values(m.trees).flat();
    expect(all.length).toBeGreaterThan(100);
    expect(new Set(all.map((e) => e.id.toLowerCase())).size).toBe(all.length);
    expect(all.every((e) => e.id === e.id.toLowerCase() && /^[0-9a-f]{64}$/.test(e.sha256))).toBe(
      true,
    );
    expect(
      m.trees.workflows?.every((e) => e.segment === "saved" || e.segment === "templates"),
    ).toBe(true);
  });
});
