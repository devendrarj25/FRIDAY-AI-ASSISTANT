/**
 * One table of local engines (kernel/local_engines.json), read by the desktop through
 * electron/local-engines.cjs and by the kernel through kernel/local_engines.py. Fake files only.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..", "..");
const table = require_("../../electron/local-engines.cjs");
const models = require_("../../electron/models.cjs");
const router = require_("../../electron/model-router.cjs");
const access = require_("../../electron/model-access.cjs");
const firewall = require_("../../electron/billing-firewall.cjs");
const registry = require_("../../electron/provider-registry.cjs");

type Row = {
  id: string;
  name: string;
  wire: string;
  endpoint: string;
  platforms?: string[];
  aliases?: string[];
  alternates?: string[];
  env?: string;
};
const FILE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "kernel", "local_engines.json"), "utf8"),
) as {
  engines: Row[];
  genericKinds: string[];
};
const IDS = FILE.engines.map((row) => row.id);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const writeTemp = (text: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-engines-"));
  const file = path.join(dir, "local_engines.json");
  fs.writeFileSync(file, text);
  return file;
};

describe("the shipped table", () => {
  it("keeps every engine the product had, with its documented port", () => {
    expect(IDS.slice().sort()).toEqual([
      "gpt4all",
      "jan",
      "koboldcpp",
      "llamacpp",
      "lmstudio",
      "localai",
      "mlx",
      "ollama",
      "transformers",
      "vllm",
    ]);
    const ports = Object.fromEntries(table.engines().map((r: Row) => [r.id, r.endpoint]));
    expect(ports).toMatchObject({
      ollama: "http://127.0.0.1:11434",
      lmstudio: "http://127.0.0.1:1234",
      llamacpp: "http://127.0.0.1:8080",
      vllm: "http://127.0.0.1:8000",
      localai: "http://127.0.0.1:8081",
      jan: "http://127.0.0.1:1337",
      koboldcpp: "http://127.0.0.1:5001",
      transformers: "http://127.0.0.1:8083",
      gpt4all: "http://127.0.0.1:4891",
      mlx: "http://127.0.0.1:8082",
    });
  });

  it("is where the desktop looks for it in a checkout and where the build ships it", () => {
    expect(table.TABLE_FILE).toBe("kernel/local_engines.json");
    expect(table.engineIds()).toEqual(IDS);
    const builder = read("electron-builder.yml");
    expect(builder).toMatch(/from: kernel\n\s+to: kernel/);
    expect(builder).not.toMatch(/local_engines/);
  });
});

describe("every engine in the table reaches each desktop consumer", () => {
  it("the live engine list (Ollama is listed apart; MLX-LM is Apple silicon only)", () => {
    const listed = Object.keys(models.LOCAL_ENGINES);
    const openai = FILE.engines.filter((r) => r.wire === "openai" && !r.platforms?.length);
    expect(listed).toEqual(openai.map((r) => r.id));
    expect(Object.keys(table.listedEngines("darwin"))).toContain("mlx");
    expect(Object.keys(table.listedEngines("win32"))).not.toContain("mlx");
    expect(Object.keys(table.listedEngines("linux"))).not.toContain("ollama");
  });

  it("keeps Jan's alternate port and override variable", () => {
    expect(models.LOCAL_ENGINES.jan).toEqual({
      name: "Jan",
      endpoint: "http://127.0.0.1:1337",
      alternates: ["http://127.0.0.1:6767"],
      env: "FRIDAY_JAN_ENDPOINT",
    });
  });

  it("the router, the access rules, the billing firewall and the provider registry", () => {
    for (const id of IDS) {
      expect(router.LOCAL_PROVIDERS.has(id), `router ${id}`).toBe(true);
      expect(access.LOCAL_PROVIDERS.has(id), `access providers ${id}`).toBe(true);
      expect(access.LOCAL_KINDS.has(id), `access kinds ${id}`).toBe(true);
      expect(firewall.LOCAL_KINDS.has(id), `firewall ${id}`).toBe(true);
      expect(registry.LOCAL_PROVIDER_IDS.has(id), `registry ${id}`).toBe(true);
      expect(router.PROVIDER_NAMES[id], `name ${id}`).toBeTruthy();
    }
    for (const kind of ["local", "llama.cpp"]) {
      expect(firewall.LOCAL_KINDS.has(kind)).toBe(true);
      expect(access.LOCAL_KINDS.has(kind)).toBe(true);
    }
    expect(router.LOCAL_PROVIDERS.has("local")).toBe(true);
    expect(router.LOCAL_PROVIDERS.has("openai")).toBe(false);
    expect(firewall.LOCAL_KINDS.has("openai")).toBe(false);
  });

  it("an engine row's name is its label", () => {
    expect(router.PROVIDER_NAMES.llamacpp).toBe("llama.cpp");
    expect(router.PROVIDER_NAMES.transformers).toBe("Hugging Face runner");
    expect(router.PROVIDER_NAMES.local).toBe("Local");
    expect(router.PROVIDER_NAMES.openai).toBeTruthy();
  });

  it("the models, health and endpoint helpers", () => {
    expect(table.modelsPath("ollama")).toBe("/api/tags");
    expect(table.modelsPath("vllm")).toBe("/v1/models");
    expect(table.healthPath("llamacpp")).toBe("/health");
    expect(table.healthPath("jan")).toBe("/v1/models");
    expect(table.endpointFromEnv("ollama", {})).toBe("http://127.0.0.1:11434");
    expect(table.endpointFromEnv("ollama", { OLLAMA_HOST: "http://10.0.0.5:9/" })).toBe(
      "http://10.0.0.5:9",
    );
    expect(table.endpointFromEnv("ollama", { OLLAMA_HOST: "javascript:alert(1)" })).toBe(
      "http://127.0.0.1:11434",
    );
    expect(table.endpointFromEnv("nope", {})).toBe("");
    expect(table.supports("ollama", "keepAlive")).toBe(true);
    expect(table.supports("lmstudio", "needsLoad")).toBe(true);
    expect(table.supports("lmstudio", "keepAlive")).toBe(false);
    expect(table.supports("ollama", "endpoint")).toBe(false);
  });
});

describe("a new row, a bad row, a bad file", () => {
  const row = { id: "newengine", name: "New", wire: "openai", endpoint: "http://127.0.0.1:9999/" };

  it("a new engine is one row", () => {
    const next = table.tableFrom({ engines: [row], genericKinds: ["local"] });
    expect([...next.rows.keys()]).toEqual(["newengine"]);
    expect(next.rows.get("newengine").endpoint).toBe("http://127.0.0.1:9999");
    expect(table.kindsOf(next.rows, next.generic).has("newengine")).toBe(true);
  });

  it("an unknown or unusable row is ignored and the rest is kept", () => {
    const next = table.tableFrom({
      engines: [
        null,
        7,
        "x",
        [],
        { id: "nowire", endpoint: "http://127.0.0.1:1" },
        { id: "grpc", wire: "grpc", endpoint: "http://127.0.0.1:2" },
        { id: "noendpoint", wire: "openai" },
        { id: "file", wire: "openai", endpoint: "file:///etc/passwd" },
        { id: "Bad Id!", wire: "openai", endpoint: "http://127.0.0.1:3" },
        row,
        { ...row, endpoint: "http://127.0.0.1:1" },
      ],
    });
    expect([...next.rows.keys()]).toEqual(["newengine"]);
    expect(next.rows.get("newengine").endpoint).toBe("http://127.0.0.1:9999");
    expect(next.rows.get("newengine").keepAlive).toBe(false);
  });

  it("a flag counts only when it is a real true", () => {
    const next = table.cleanRow({ ...row, keepAlive: "yes", needsLoad: 1, offloadHint: true });
    expect([next.keepAlive, next.needsLoad, next.offloadHint]).toEqual([false, false, true]);
  });

  it("a missing, empty, or malformed file falls back to the built-in table and never throws", () => {
    const bad = [
      "{not json",
      "[]",
      "null",
      "",
      '{"engines": "x"}',
      '{"engines": []}',
      '{"engines": [{"id": 1}]}',
    ];
    for (const text of [...bad, null]) {
      const loaded = table.loadTable(
        text === null ? path.join(os.tmpdir(), "absent-engines.json") : writeTemp(text),
      );
      expect([...loaded.rows.keys()]).toEqual(["ollama", "lmstudio", "llamacpp"]);
      expect(loaded.generic).toEqual(["local"]);
    }
    expect([...table.loadTable(null).rows.keys()]).toEqual(["ollama", "lmstudio", "llamacpp"]);
  });

  it("a file saved with a byte order mark still loads", () => {
    const text = `\uFEFF${JSON.stringify({ engines: [row] })}`;
    expect([...table.loadTable(writeTemp(text)).rows.keys()]).toEqual(["newengine"]);
  });

  it("the built-in table agrees with the file row for row", () => {
    for (const fallback of table.FALLBACK_ROWS) {
      const wanted = table.cleanRow(FILE.engines.find((r) => r.id === fallback.id));
      expect(table.cleanRow(fallback)).toEqual(wanted);
    }
    expect(table.FALLBACK_GENERIC).toEqual(FILE.genericKinds);
  });
});

describe("no engine is spelled out anywhere else", () => {
  // LM Studio, Ollama and llama.cpp keep id-keyed behaviour (native catalogue, pull, health); a list names the rest.
  const LITERAL = /["'`](koboldcpp|gpt4all|localai|transformers)["'`]/;

  it("the consumers read the table instead of listing engines", () => {
    const consumers = [
      "electron/providers.cjs",
      "electron/service-health.cjs",
      "electron/model-router.cjs",
      "electron/model-access.cjs",
      "electron/billing-firewall.cjs",
      "electron/provider-registry.cjs",
      "kernel/router.py",
      "kernel/billing.py",
      "kernel/privacy.py",
    ];
    expect(consumers.filter((rel) => LITERAL.test(read(rel)))).toEqual([]);
    // models.cjs keeps per-engine start/stop handlers keyed by id; the engine rows themselves are gone from it.
    const modelsSource = read("electron/models.cjs");
    expect(modelsSource).toMatch(/LOCAL_ENGINES = localEngines\.listedEngines\(\)/);
    expect(modelsSource).not.toMatch(/endpoint: "http:\/\/127\.0\.0\.1:\d+"/);
  });

  it("the old default ports are not repeated in the consumers", () => {
    for (const rel of [
      "electron/providers.cjs",
      "electron/service-health.cjs",
      "electron/model-router.cjs",
      "electron/model-download.cjs",
      "kernel/router.py",
    ]) {
      expect(read(rel), rel).not.toMatch(/127\.0\.0\.1:(11434|1234|8080|1337|4891)/);
    }
  });

  it("only the installer catalogue and the owner's main process still name engines", () => {
    const allowed = new Set([
      "electron/local-engines.cjs", // the fallback rows
      "electron/models.cjs", // per-engine start and stop handlers, keyed by id
      "electron/startup.cjs", // the auto-start policy default, not an engine list
      "electron/toolchain.cjs",
      "electron/vendor-sources.cjs",
    ]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "handlers") walk(rel);
        } else if (entry.name.endsWith(".cjs") && /["'`](koboldcpp|gpt4all)["'`]/.test(read(rel))) {
          hits.push(rel);
        }
      }
    };
    walk("electron");
    expect(hits.filter((rel) => !allowed.has(rel))).toEqual([]);
  });
});
