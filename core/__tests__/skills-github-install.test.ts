/**
 * Install from GitHub, end to end on the real modules: the archive download (a local server stands in for
 * GitHub's archive URL), the scan of a repository-shaped zip with the usual single top folder, installing
 * several skills from it, verifying them, and running them. A broken or truncated download must fail cleanly
 * and leave nothing installed.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const importer = require("../../electron/importer.cjs") as Any;
const skillPack = require("../../electron/skill-pack.cjs") as Any;
const caps = require("../../electron/capabilities.cjs") as Any;
const verify = require("../../electron/capability-verify.cjs") as Any;
const skills = require("../../electron/skills.cjs") as Any;
const { zipSync, strToU8 } = require("fflate") as Any;

const temps: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const manifest = (id: string, name: string) =>
  JSON.stringify({
    id,
    name,
    summary: `${name} for tests`,
    category: "tests",
    capabilities: [],
    risk: "safe",
    inputs: ["text"],
    version: 1,
    author: "someone",
    enabled: true,
    permissions: [],
    description: `${name}: a test skill that returns its own name and the words it was given.`,
  });
const code = (name: string) =>
  `export async function run(input={}){const t=String(input.text??input.prompt??'');return {ok:true,skill:${JSON.stringify(name)},words:t.trim()?t.trim().split(/\\s+/).length:0};}\n`;

const repoZip = zipSync({
  "demo-skills-main/README.md": strToU8("# demo"),
  "demo-skills-main/skills/word-count/skill.json": strToU8(
    manifest("gh-word-count", "GH word count"),
  ),
  "demo-skills-main/skills/word-count/skill.mjs": strToU8(code("gh-word-count")),
  "demo-skills-main/skills/shout/skill.json": strToU8(manifest("gh-shout", "GH shout")),
  "demo-skills-main/skills/shout/skill.mjs": strToU8(code("gh-shout")),
});

function serve(body: Uint8Array | null, status = 200) {
  const server = http.createServer((_req, res) => {
    if (!body) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    res.writeHead(status, {
      "content-type": "application/zip",
      "content-length": String(body.length),
    });
    res.end(Buffer.from(body));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/demo-skills/archive/refs/heads/main.zip`,
        close: () => server.close(),
      });
    }),
  );
}

async function installFrom(file: string, ws: string) {
  const roots = { appRoot: ROOT, workspaceRoot: ws };
  const scan = await importer.scanImport({ root: ws, source: file });
  if (!scan.ok) return { scan, roots, ids: [] as string[] };
  const found = skillPack.collectSkillPacksFromDir(scan.contentRoot);
  const prepared = skillPack.prepareSkillsOnly(found.packs, { nonSkillKinds: found.nonSkillKinds });
  const ids: string[] = [];
  for (const pack of prepared.packs) {
    const installed = caps.installPack(roots, pack);
    if (!installed.ok) continue;
    const verdict = await verify.verifyCapability(
      { root: ws },
      { id: installed.id, tree: "skills", dir: caps.packPath(ws, installed.id) },
      { emit() {} },
    );
    caps.markVerified(roots, installed.id, verdict);
    ids.push(installed.id);
  }
  return { scan, roots, ids };
}

describe("install from a GitHub archive", () => {
  it("downloads the archive, installs every skill in it, verifies and runs them", async () => {
    const server = await serve(repoZip);
    const ws = tmp("friday-gh-ws-");
    try {
      const dl = await importer.downloadArchive({
        root: ws,
        url: server.url,
        name: "demo-skills-main.zip",
      });
      expect(dl.ok, dl.error).toBe(true);
      expect(fs.existsSync(dl.file)).toBe(true);
      const { roots, ids } = await installFrom(dl.file, ws);
      expect(ids.sort()).toEqual(["skills/custom/gh-shout", "skills/custom/gh-word-count"]);
      const listed = caps.list(roots).items.filter((i: Any) => ids.includes(i.id));
      expect(listed.every((i: Any) => i.enabled && i.origin === "workspace")).toBe(true);
      const ran = await skills.invoke(roots, "gh-word-count", { text: "a b c" }, {});
      expect(ran).toMatchObject({ ok: true, value: { skill: "gh-word-count", words: 3 } });
      // Remove one, the other stays.
      expect(caps.uninstallPack(roots, "skills/custom/gh-shout").ok).toBe(true);
      expect(caps.list(roots).items.some((i: Any) => i.id === "skills/custom/gh-shout")).toBe(
        false,
      );
      expect(caps.list(roots).items.some((i: Any) => i.id === "skills/custom/gh-word-count")).toBe(
        true,
      );
    } finally {
      server.close();
    }
  }, 60000);

  it("a missing repository (404) fails cleanly and installs nothing", async () => {
    const server = await serve(null);
    const ws = tmp("friday-gh-ws-");
    try {
      const dl = await importer.downloadArchive({ root: ws, url: server.url, name: "x.zip" });
      expect(dl.ok).toBe(false);
      expect(String(dl.error)).toBeTruthy();
      expect(fs.existsSync(path.join(ws, "skills"))).toBe(false);
    } finally {
      server.close();
    }
  }, 60000);

  it("a download that is not a zip is refused before anything is installed", async () => {
    const server = await serve(new Uint8Array(Buffer.from("<html>rate limited</html>")));
    const ws = tmp("friday-gh-ws-");
    try {
      const dl = await importer.downloadArchive({ root: ws, url: server.url, name: "x.zip" });
      if (dl.ok) {
        const { ids } = await installFrom(dl.file, ws);
        expect(ids).toEqual([]);
      } else {
        expect(dl.ok).toBe(false);
      }
      expect(fs.existsSync(path.join(ws, "skills"))).toBe(false);
    } finally {
      server.close();
    }
  }, 60000);

  it("a git URL that is not https or GitHub is rejected up front", async () => {
    const ws = tmp("friday-gh-ws-");
    const r = await skillPack.stageGitClone(
      ws,
      "ftp://example.com/x.git",
      importer.downloadArchive,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https git URL|GitHub/);
  });
});
