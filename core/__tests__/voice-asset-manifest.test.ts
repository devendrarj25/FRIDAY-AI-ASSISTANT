/**
 * The voice asset manifest: every registered voice model carries a non-empty licence and firewall class (internal
 * catalog metadata), the three single-file helpers (Silero VAD, Smart Turn, the wake embedding) get a `<id>-pin` Doctor
 * row from their SHA-256, a wake-embed repair id exists, and the Smart Turn row opens the file instead of saying
 * "present". Offline: the disk, the hash and the self-test runner are faked.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
type Row = { id: string; ok: boolean; detail: string; installId?: string; required?: boolean };
type Registry = { catalogId: string; license?: string; firewallClass?: string; kind: string };
const weights = req("../../electron/voice-weights.cjs") as {
  modelRegistry: () => Registry[];
  fileSets: () => Array<{ id: string }>;
  manifestOf: (id: string) => { license?: string; firewallClass?: string } | null;
  pinnedJobs: () => Array<{
    id: string;
    sha256: string;
    bytes: number;
    file: string;
    dir: string[];
  }>;
  pinChecks: (root: string, deps: Record<string, unknown>) => Promise<Row[]>;
  smartTurnLoadCheck: (root: string, deps: Record<string, unknown>) => Promise<Row | null>;
  FIREWALL_CLASSES: string[];
};
const catalog = req("../../electron/installer-catalog.cjs") as {
  voiceRows: (
    root: string,
  ) => Array<{ id: string; license?: string | null; firewallClass?: string }>;
};

const helpers = () => weights.pinnedJobs();

describe("voice asset manifest gate", () => {
  it("gives every registry row a non-empty licence and a known firewall class", () => {
    const rows = weights.modelRegistry();
    expect(rows.length).toBeGreaterThan(18);
    for (const row of rows) {
      expect(String(row.license || "").trim(), `${row.catalogId} licence`).not.toBe("");
      expect(weights.FIREWALL_CLASSES, `${row.catalogId} firewall class`).toContain(
        row.firewallClass,
      );
      const manifest = weights.manifestOf(row.catalogId);
      expect(manifest?.license, `${row.catalogId} manifest licence`).toBe(row.license);
      expect(manifest?.firewallClass, `${row.catalogId} manifest class`).toBe(row.firewallClass);
    }
  });

  it("carries the same two fields into the installer catalog voice rows", () => {
    const rows = catalog.voiceRows("/friday");
    // every registry model plus every pinned file set (several single files, no repository)
    expect(rows.length).toBe(weights.modelRegistry().length + weights.fileSets().length);
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining(weights.fileSets().map((set) => `voice:${set.id}`)),
    );
    for (const row of rows) {
      expect(String(row.license || "").trim(), `${row.id} licence`).not.toBe("");
      expect(weights.FIREWALL_CLASSES, `${row.id} firewall class`).toContain(row.firewallClass);
    }
  });
});

describe("single-file helper pin rows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-asset-"));
  for (const job of helpers()) {
    const dir = path.join(root, ...job.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, job.file), "x");
  }
  const exists = (file: string) => fs.existsSync(file);
  const good = (job: { sha256: string; bytes: number }) => ({
    fileSize: () => job.bytes,
    hashFile: () => job.sha256,
  });

  it("adds a green `<id>-pin` row for Silero, Smart Turn and the wake embedding when size and SHA-256 match", async () => {
    const byFile = new Map(helpers().map((job) => [job.file, job]));
    const rows = await weights.pinChecks(root, {
      exists,
      hash: true,
      fileSize: (file: string) => byFile.get(path.basename(file))!.bytes,
      hashFile: (file: string) => byFile.get(path.basename(file))!.sha256,
    });
    for (const id of ["silero-vad", "smart-turn", "wake-embed"]) {
      const row = rows.find((entry) => entry.id === `${id}-pin`);
      expect(row?.ok, id).toBe(true);
      expect(row?.required, id).toBe(false);
      expect(row?.detail, id).toMatch(/SHA-256/);
    }
  });

  it("goes red on a wrong digest, names it, and offers the helper's own repair id", async () => {
    const job = helpers().find((entry) => entry.id === "wake-embed")!;
    const rows = await weights.pinChecks(root, {
      exists,
      hash: true,
      fileSize: () => job.bytes,
      hashFile: () => "0".repeat(64),
    });
    const row = rows.find((entry) => entry.id === "wake-embed-pin");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/fails SHA-256/);
    expect(row?.installId).toBe("wake-embed");
  });

  it("goes red on a wrong size without reading the file when the hash is not asked for", async () => {
    let hashed = 0;
    const rows = await weights.pinChecks(root, {
      exists,
      fileSize: () => 1,
      hashFile: () => {
        hashed += 1;
        return "";
      },
    });
    const row = rows.find((entry) => entry.id === "smart-turn-pin");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/wrong size/);
    expect(hashed).toBe(0);
  });

  it("adds no row for a helper that is not installed", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "friday-asset-empty-"));
    const rows = await weights.pinChecks(empty, { exists });
    expect(rows.filter((row) => /^(silero-vad|smart-turn|wake-embed)-pin$/.test(row.id))).toEqual(
      [],
    );
  });

  it("a real file on disk is hashed by the default reader and fails against the pin", async () => {
    const rows = await weights.pinChecks(root, {
      exists,
      hash: true,
      fileSize: () => helpers()[0]!.bytes,
    });
    const bad = rows.filter((row) => /^(silero-vad|smart-turn|wake-embed)-pin$/.test(row.id));
    expect(bad.length).toBe(3);
    expect(bad.every((row) => row.ok === false)).toBe(true);
  });
});

describe("Smart Turn row opens the file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-turn-"));
  const dir = path.join(root, "models", "smart-turn");
  fs.mkdirSync(dir, { recursive: true });
  const exists = (file: string) => fs.existsSync(file);

  it("gives no row when the file is not in the registered folder", async () => {
    const row = await weights.smartTurnLoadCheck(root, {
      exists,
      runSelfTest: async () => ({ ok: true }),
    });
    expect(row).toBeNull();
  });

  it("runs the pinned signature self-test on the folder and reports its answer", async () => {
    fs.writeFileSync(path.join(dir, "smart-turn-v3.2-cpu.onnx"), "x");
    let seen: { dir: string; spec: Record<string, unknown> } | null = null;
    const green = await weights.smartTurnLoadCheck(root, {
      exists,
      runSelfTest: async (call: { dir: string; spec: Record<string, unknown> }) => {
        seen = call;
        return {
          ok: true,
          detail: "opens, declares the pinned signature and ran one pass of zeros",
        };
      },
    });
    expect(seen!.dir).toBe(dir);
    expect(seen!.spec).toMatchObject({
      kind: "onnx-signature",
      file: "smart-turn-v3.2-cpu.onnx",
      inputs: [{ name: "input_features", shape: ["B", 80, 800], run: [1, 80, 800] }],
      outputs: [{ name: "logits", shape: ["B", 1] }],
    });
    expect(green).toMatchObject({ id: "smart-turn", ok: true, required: false, optional: true });
    expect(green?.detail).toMatch(/ran one pass/);

    const red = await weights.smartTurnLoadCheck(root, {
      exists,
      runSelfTest: async () => ({ ok: false, reason: "cannot-open", detail: "InvalidProtobuf" }),
    });
    expect(red?.ok).toBe(false);
    expect(red?.detail).toMatch(/cannot-open|InvalidProtobuf/);
    expect(red?.installId).toBe("smart-turn");
  });

  it("a thrown runner or a missing runner is red, never a silent pass", async () => {
    const boom = await weights.smartTurnLoadCheck(root, {
      exists,
      runSelfTest: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(boom?.ok).toBe(false);
    expect(boom?.detail).toMatch(/spawn failed/);
    const none = await weights.smartTurnLoadCheck(root, { exists });
    expect(none?.ok).toBe(false);
  });
});

describe("voice-verify wiring", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../electron/voice-verify.cjs"), "utf8");

  it("maps the wake embedding to its own repair id", () => {
    expect(source).toMatch(/"wake-embed":\s*"wake-embed"/);
  });

  it("replaces the kernel 'file present' pass with the load check", () => {
    expect(source).toContain("smartTurnLoadCheck");
    expect(source).toMatch(/smartTurnLoadCheck\([\s\S]{0,160}runSelfTest: runPinSelfTest/);
  });
});
