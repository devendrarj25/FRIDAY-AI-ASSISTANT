/**
 * The whole plugin life cycle on the real modules in a throwaway workspace: install from a GitHub-shaped archive,
 * verify, enable, fire a hook, disable, remove; every shipped plugin fires on exactly the hooks it declares and
 * survives odd payloads; and all of them can be switched on and off in one go.
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
const pluginPack = require("../../electron/plugin-pack.cjs") as Any;
const caps = require("../../electron/capabilities.cjs") as Any;
const verify = require("../../electron/capability-verify.cjs") as Any;
const plugins = require("../../electron/plugins.cjs") as Any;
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
    version: "1.0.0",
    entry: "index.cjs",
    enabled: false,
    category: "tests",
    description: `${name}: writes one file when a turn completes.`,
    permissions: [],
    hooks: ["on-turn-complete"],
  });
const code = (name: string) =>
  `module.exports={register(){},"on-turn-complete":async function(payload,ctx){ctx.fs.writeFile("seen.json",JSON.stringify({by:${JSON.stringify(name)},prompt:payload&&payload.prompt}));return {ok:true};},selfTest(){return {ok:true,loaded:true};}};\n`;

const repoZip = zipSync({
  "demo-plugins-main/README.md": strToU8("# demo"),
  "demo-plugins-main/plugins/turn-note/plugin.json": strToU8(
    manifest("gh-turn-note", "GH turn note"),
  ),
  "demo-plugins-main/plugins/turn-note/index.cjs": strToU8(code("gh-turn-note")),
  "demo-plugins-main/plugins/turn-mark/plugin.json": strToU8(
    manifest("gh-turn-mark", "GH turn mark"),
  ),
  "demo-plugins-main/plugins/turn-mark/index.cjs": strToU8(code("gh-turn-mark")),
});

function serve(body: Uint8Array) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(body.length),
    });
    res.end(Buffer.from(body));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/demo/archive/refs/heads/main.zip`,
        close: () => server.close(),
      });
    }),
  );
}

const fired = (r: Any) => (r.fired ?? []) as { id: string; ok: boolean; error?: string }[];

describe("plugin life cycle", () => {
  it("GitHub archive: download, install (off), verify, enable, fire, disable, remove", async () => {
    const server = await serve(repoZip);
    const ws = tmp("friday-pl-ws-");
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    try {
      const dl = await importer.downloadArchive({
        root: ws,
        url: server.url,
        name: "demo-plugins-main.zip",
      });
      expect(dl.ok, dl.error).toBe(true);
      const scan = await importer.scanImport({ root: ws, source: dl.file });
      expect(scan.ok, scan.error).toBe(true);
      const found = pluginPack.collectPluginPacksFromDir(scan.contentRoot);
      const prepared = pluginPack.preparePluginsOnly(found.packs, {
        nonPluginKinds: found.nonPluginKinds,
      });
      expect(prepared.ok, prepared.error).toBe(true);
      const ids: string[] = [];
      for (const pack of prepared.packs) {
        const installed = caps.installPack(roots, pack, "plugins");
        expect(installed.ok, installed.error).toBe(true);
        expect(caps.list(roots).items.find((i: Any) => i.id === installed.id).enabled).toBe(false);
        const verdict = await verify.verifyCapability(
          { root: ws },
          { id: installed.id, tree: "plugins", dir: caps.packPath(ws, installed.id) },
          { emit() {} },
        );
        caps.markVerified(roots, installed.id, verdict);
        ids.push(installed.id);
      }
      expect(ids.length).toBe(2);
      const first = ids[0]!;
      // Off: the hook does not reach it. On: it does, and its own data folder gets the file.
      const off = await plugins.dispatch(roots, "on-turn-complete", { prompt: "hi" }, {});
      expect(fired(off).some((f) => f.id.endsWith(first.split("/").pop()!))).toBe(false);
      caps.setEnabled(roots, first, true);
      expect(plugins.setEnabled(roots, first, true).ok).toBe(true);
      const on = await plugins.dispatch(roots, "on-turn-complete", { prompt: "hello" }, {});
      expect(fired(on).filter((f) => f.id.endsWith(first.split("/").pop()!) && f.ok).length).toBe(
        1,
      );
      const slug = first.split("/").pop()!;
      const seen = path.join(ws, "plugins", "data", slug, "seen.json");
      expect(JSON.parse(fs.readFileSync(seen, "utf8"))).toMatchObject({ prompt: "hello" });
      caps.setEnabled(roots, first, false);
      plugins.setEnabled(roots, first, false);
      const after = await plugins.dispatch(roots, "on-turn-complete", { prompt: "again" }, {});
      expect(fired(after).some((f) => f.id.endsWith(slug))).toBe(false);
      expect(caps.uninstallPack(roots, first).ok).toBe(true);
      expect(caps.list(roots).items.some((i: Any) => i.id === first)).toBe(false);
      expect(caps.list(roots).items.some((i: Any) => i.id === ids[1])).toBe(true);
    } finally {
      server.close();
    }
  }, 120000);

  it("every shipped plugin fires on exactly the hooks it declares and survives odd payloads", async () => {
    const ws = tmp("friday-pl-ws-");
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    const shipped = plugins.list(roots) as Any[];
    expect(shipped.length).toBe(107);
    const payloads: unknown[] = [
      { prompt: "hello", error: "boom", path: "a.txt", skillId: "x", ok: true },
      {},
      null,
      { prompt: "x".repeat(5000), nested: { a: [1, 2, { b: null }] } },
    ];
    for (const hook of plugins.HOOKS as string[]) {
      const want = shipped.filter((p) => (p.hooks as string[]).includes(hook)).length;
      for (const payload of payloads) {
        const r = await plugins.dispatch(roots, hook, payload, { allowDisabled: true });
        const results = fired(r);
        expect(
          results.filter((f) => !f.ok).map((f) => `${f.id}: ${f.error}`),
          hook,
        ).toEqual([]);
        expect(results.length, `${hook} fired`).toBe(want);
      }
    }
  }, 600000);

  it("all shipped plugins switch on and off together, and only enabled ones receive a hook", async () => {
    const ws = tmp("friday-pl-ws-");
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    const ids = caps
      .list(roots)
      .items.filter((i: Any) => i.tree === "plugins")
      .map((i: Any) => i.id as string);
    expect(ids.length).toBe(107);
    for (const id of ids) {
      caps.setEnabled(roots, id, true);
      plugins.setEnabled(roots, id, true);
    }
    expect(caps.list(roots).items.filter((i: Any) => i.tree === "plugins" && !i.enabled)).toEqual(
      [],
    );
    const start = await plugins.dispatch(roots, "on-app-start", {}, {});
    expect(fired(start).filter((f) => !f.ok)).toEqual([]);
    expect(fired(start).length).toBe(29);
    for (const id of ids) {
      caps.setEnabled(roots, id, false);
      plugins.setEnabled(roots, id, false);
    }
    expect(caps.list(roots).items.filter((i: Any) => i.tree === "plugins" && i.enabled)).toEqual(
      [],
    );
    expect(fired(await plugins.dispatch(roots, "on-app-start", {}, {}))).toEqual([]);
  }, 600000);
});
