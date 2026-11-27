/**
 * The install gate of the toolchain downloads: a data-file installer (exe, msi, msix) is always checked for its
 * Windows signature and the right publisher, saved under a name from its row (never from the address), a redirect
 * probe is held to the download allowlist and its path prefixes, a stored version freezes updates only after a
 * digest for it was verified, a reused managed program must still have its recorded hash, a zip cannot unpack
 * without limit, and the catalogue row says how its version was reached. Fake networks, stubbed PowerShell, temp dirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const safety = require_(path.join(root, "electron/download-safety.cjs"));
const managed = require_(path.join(root, "electron/managed-install.cjs"));
const catalogApi = require_(path.join(root, "electron/installer-catalog.cjs"));
const toolchainSource = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");

const H = (c: string) => c.repeat(64);
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-sigate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Status = { ok: boolean; reason: string };
const stubStatus = (answer: Status) => {
  const calls: { file: string; opts: { signer?: string } }[] = [];
  const fn = (file: string, opts: { signer?: string } = {}) => {
    calls.push({ file, opts });
    return answer;
  };
  return { fn, calls };
};
const VALID = { ok: true, reason: "Valid" };
const NOT_SIGNED = { ok: false, reason: "NotSigned" };

/* ------------------------------------------------------------ 1. file name from the row */

describe("a data-file download is named from its row and checked as what it is", () => {
  it("names the file <id>-<version>.<archive>, whatever the address ends with", () => {
    expect(
      toolchain.dataFileInstallerName(
        { id: "Visual Studio Code" },
        { version: "1.99.0", archive: "exe" },
      ),
    ).toBe("Visual_Studio_Code-1.99.0.exe");
    expect(
      toolchain.dataFileInstallerName(
        { id: "OpenJDK (Temurin)" },
        { version: "25.0.1+9", archive: "msi" },
      ),
    ).toBe("OpenJDK_Temurin_-25.0.1+9.msi");
  });

  it("keeps path characters out of the name", () => {
    const name = toolchain.dataFileInstallerName(
      { id: "..\\evil/tool" },
      { version: "1/../../2", archive: "../exe" },
    );
    expect(name).not.toMatch(/[\\/]/);
    expect(name).not.toContain("..\\");
    expect(path.basename(name)).toBe(name);
  });

  it("the VS Code plan (address ends in /stable) is signature-checked", async () => {
    const spec = vendor.rowSpec("Visual Studio Code");
    expect(spec.download.urlTemplate).toMatch(/\/stable$/);
    const status = stubStatus(VALID);
    const alt = { version: "1.99.0", archive: spec.download.archive };
    const file = path.join(dir, toolchain.dataFileInstallerName({ id: "Visual Studio Code" }, alt));
    const gate = toolchain.signatureGate(file, { id: "Visual Studio Code" }, alt, {
      win: true,
      authenticodeStatus: status.fn,
    });
    expect(status.calls).toHaveLength(1);
    expect(gate).toMatchObject({ checked: true, ok: true });
  });

  it("every shipped exe, msi or msix row is checked, however its address ends", () => {
    vendor.clearToolSources();
    const rows = vendor.loadToolSources().rows as Record<
      string,
      { download?: { archive?: string; urlTemplate?: string } }
    >;
    const checked: string[] = [];
    for (const [id, row] of Object.entries(rows)) {
      const archive = row.download?.archive;
      if (!archive || !["exe", "msi", "msix"].includes(archive)) continue;
      const status = stubStatus(VALID);
      const alt = { version: "1.0.0", archive };
      const file = path.join(dir, toolchain.dataFileInstallerName({ id }, alt));
      toolchain.signatureGate(file, { id }, alt, { win: true, authenticodeStatus: status.fn });
      expect(status.calls, id).toHaveLength(1);
      expect(path.extname(file)).toBe(`.${archive}`);
      checked.push(id);
    }
    expect(checked).toEqual(
      expect.arrayContaining(["Visual Studio Code", "OpenJDK (Temurin)", "Node.js LTS"]),
    );
  });

  it("the installer step names the file from the row and runs the gate before anything is run", () => {
    expect(toolchainSource).toContain("dataFileInstallerName(tool, alt)");
    expect(toolchainSource).toContain("fileName: savedAs");
    expect(toolchainSource).not.toMatch(/alt\?\.needsSignature && !WIN/);
    const gateAt = toolchainSource.indexOf("signatureGate(file, tool, alt)");
    const runAt = toolchainSource.indexOf('attempt("vendor installer", installerCommand(file');
    expect(gateAt).toBeGreaterThan(0);
    expect(runAt).toBeGreaterThan(gateAt);
    // A refused file is dropped, so the next step has nothing to run.
    expect(toolchainSource.slice(gateAt, runAt)).toMatch(/file = null;/);
  });
});

/* ------------------------------------------------------------ 2. always verify, unless the row says why not */

describe("a data-file installer is always verified", () => {
  const alt = (extra: Record<string, unknown> = {}) => ({
    version: "1.0.0",
    archive: "exe",
    ...extra,
  });

  it("NotSigned is refused: the file is not kept and nothing runs", () => {
    const status = stubStatus(NOT_SIGNED);
    const gate = toolchain.signatureGate("/d/x.exe", { id: "x", sha256: H("a") }, alt(), {
      win: true,
      authenticodeStatus: status.fn,
    });
    expect(gate).toMatchObject({ checked: true, ok: false });
    expect(gate.line).toMatch(/NotSigned/);
  });

  it("a bad or untrusted signature is refused, also for a row that allows unsigned", () => {
    for (const reason of ["HashMismatch", "NotTrusted", "UnknownError"]) {
      const gate = toolchain.signatureGate(
        "/d/x.exe",
        { id: "x", sha256: H("a"), allowUnsigned: true },
        alt({ allowUnsigned: true }),
        { win: true, authenticodeStatus: stubStatus({ ok: false, reason }).fn },
      );
      expect(gate.ok, reason).toBe(false);
    }
  });

  it("only a row marked allowUnsigned, with a digest, may pass NotSigned", () => {
    const run = (tool: Record<string, unknown>) =>
      toolchain.signatureGate("/d/x.exe", { id: "x", ...tool }, alt(), {
        win: true,
        authenticodeStatus: stubStatus(NOT_SIGNED).fn,
      });
    expect(run({ allowUnsigned: true, sha256: H("a") }).ok).toBe(true);
    expect(run({ allowUnsigned: true, sha256: "" }).ok).toBe(false);
    expect(run({ sha256: H("a") }).ok).toBe(false);
  });

  it("where the signature cannot be read (not Windows) an exe, msi or msix is refused", () => {
    for (const archive of ["exe", "msi", "msix"]) {
      const status = stubStatus(VALID);
      const gate = toolchain.signatureGate("/d/x", { id: "x" }, alt({ archive }), {
        win: false,
        authenticodeStatus: status.fn,
      });
      expect(gate, archive).toMatchObject({ checked: true, ok: false });
      expect(status.calls).toHaveLength(0);
    }
  });

  it("a zip or tar.gz is not an installer program and is not signature-checked", () => {
    for (const archive of ["zip", "tar.gz"]) {
      const status = stubStatus(NOT_SIGNED);
      const gate = toolchain.signatureGate("/d/x", { id: "x" }, alt({ archive }), {
        win: true,
        authenticodeStatus: status.fn,
      });
      expect(gate.checked).toBe(false);
      expect(status.calls).toHaveLength(0);
    }
  });

  it("the shipped data marks only rustup as unsigned, with its reason, and the plan carries the flag", async () => {
    vendor.clearToolSources();
    const rows = vendor.loadToolSources().rows as Record<string, Record<string, unknown>>;
    const unsigned = Object.entries(rows)
      .filter(([, r]) => r["allowUnsigned"] === true)
      .map(([id]) => id);
    expect(unsigned).toEqual(["Rust"]);
    expect(String(rows["Rust"]?.["allowUnsignedReason"])).toMatch(/static\.rust-lang\.org/);
    expect(vendor.rowSpec("Rust").allowUnsigned).toBe(true);
  });

  it("a row cannot say allowUnsigned without a reason, or with anything but true", () => {
    const base = {
      home: "machine",
      sources: [{ kind: "html-regex", url: "https://v.example/x", pattern: "v([0-9.]+)" }],
    };
    const check = (extra: Record<string, unknown>) =>
      vendor.validateToolSourceFile({ version: 1, rows: { T: { ...base, ...extra } } }, "f.json");
    expect(check({ allowUnsigned: true }).errors.join()).toMatch(/allowUnsignedReason/);
    expect(check({ allowUnsigned: "yes", allowUnsignedReason: "r" }).errors.join()).toMatch(
      /can only be true/,
    );
    expect(check({ allowUnsigned: true, allowUnsignedReason: "ships none" }).errors).toEqual([]);
  });
});

/* ------------------------------------------------------------ 3. the right publisher */

describe("the signature must be the publisher the row names", () => {
  const sigOut = (status: string, subject: string, thumb = "A".repeat(40)) =>
    `${status}|${subject}|${thumb}\n`;

  it("a valid signature from the named publisher passes", () => {
    const got = safety.authenticodeStatus("C:/d/x.exe", {
      signer: "Microsoft Corporation",
      exec: () => sigOut("Valid", "CN=Microsoft Corporation, O=Microsoft Corporation, C=US"),
    });
    expect(got).toMatchObject({ ok: true, reason: "Valid" });
  });

  it("a valid signature from another publisher is refused", () => {
    const got = safety.authenticodeStatus("C:/d/x.exe", {
      signer: "Microsoft Corporation",
      exec: () => sigOut("Valid", 'CN="Evil Ltd", O=Microsoft Corporation, C=US'),
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toMatch(/WrongSigner/);
  });

  it("the common name must be equal, not a prefix, a suffix or another field", () => {
    const m = safety.signerMatches;
    expect(m("Microsoft Corporation", { subject: "CN=Microsoft Corporation Evil" })).toBe(false);
    expect(m("Microsoft Corporation", { subject: "CN=Not Microsoft Corporation" })).toBe(false);
    expect(m("Microsoft Corporation", { subject: "O=Microsoft Corporation, CN=Other" })).toBe(
      false,
    );
    expect(m("microsoft corporation", { subject: "CN=Microsoft Corporation, O=x" })).toBe(true);
    expect(safety.subjectCommonName('O=x, CN="A, B Ltd", C=US')).toBe("A, B Ltd");
  });

  it("a 40-hex signer is a thumbprint, compared whole", () => {
    const thumb = "ab".repeat(20);
    expect(safety.signerMatches(thumb, { subject: "CN=x", thumbprint: thumb.toUpperCase() })).toBe(
      true,
    );
    expect(safety.signerMatches(thumb, { subject: "CN=x", thumbprint: "cd".repeat(20) })).toBe(
      false,
    );
  });

  it("no signer named accepts any valid publisher; a status other than Valid never passes", () => {
    const valid = safety.authenticodeStatus("x", { exec: () => sigOut("Valid", "CN=Anyone") });
    expect(valid.ok).toBe(true);
    for (const status of ["NotSigned", "HashMismatch", "NotTrusted"]) {
      const got = safety.authenticodeStatus("x", {
        signer: "Anyone",
        exec: () => sigOut(status, "CN=Anyone"),
      });
      expect(got).toMatchObject({ ok: false, reason: status });
    }
  });

  it("a PowerShell failure is a refusal, and the file name is quoted in the script", () => {
    const failed = safety.authenticodeStatus("x", {
      exec: () => {
        throw new Error("powershell missing");
      },
    });
    expect(failed.ok).toBe(false);
    let script = "";
    safety.authenticodeStatus("C:/it's/x.exe", {
      exec: (s: string) => ((script = s), sigOut("Valid", "CN=a")),
    });
    expect(script).toContain("'C:/it''s/x.exe'");
  });

  it("the gate hands the row's signer to the check, and a wrong publisher refuses the file", () => {
    const status = stubStatus({ ok: false, reason: "WrongSigner: signed by Evil, expected Acme" });
    const gate = toolchain.signatureGate(
      "/d/x.msi",
      { id: "x" },
      { version: "1", archive: "msi", signer: "Acme" },
      { win: true, authenticodeStatus: status.fn },
    );
    expect(status.calls[0]?.opts.signer).toBe("Acme");
    expect(gate.ok).toBe(false);
    expect(gate.line).toMatch(/WrongSigner/);
  });

  it("a community-listed digest needs a named signer: readiness, plan and gate all refuse without one", async () => {
    const MANIFEST = "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/t.json";
    const rowFor = (extra: Record<string, unknown>) => ({
      home: "machine",
      sources: [{ kind: "html-regex", url: "https://v.example/latest", pattern: "v([0-9.]+)" }],
      download: {
        urlTemplate: "https://v.example/t/{version}/t.msi",
        archive: "msi",
        digestUrl: MANIFEST,
        digestPath: "$.architecture.64bit.hash",
      },
      ...extra,
    });
    const fetchImpl = async (url: string) => {
      const body = url.startsWith(MANIFEST)
        ? JSON.stringify({
            version: "1.0.0",
            architecture: { "64bit": { url: "https://v.example/t/1.0.0/t.msi", hash: H("a") } },
          })
        : "v1.0.0";
      return {
        ok: true,
        status: 200,
        url: "",
        headers: { get: () => null },
        text: async () => body,
      };
    };
    const sourcesOf = (rows: Record<string, unknown>) => ({
      rows,
      errors: [],
      warnings: [],
      files: [],
    });
    const none = await vendor.planRowDownload("T", {
      toolSources: sourcesOf({ T: rowFor({}) }),
      fetchImpl,
    });
    expect(none).toMatchObject({ ok: false, notifyOnly: true });
    expect(none.error).toMatch(/no signer/);
    const named = await vendor.planRowDownload("T", {
      toolSources: sourcesOf({ T: rowFor({ signer: "Acme Ltd" }) }),
      fetchImpl,
    });
    expect(named).toMatchObject({ ok: true, needsSignature: true, signer: "Acme Ltd" });
    const gate = toolchain.signatureGate(
      "/d/t.msi",
      { id: "T" },
      { version: "1.0.0", archive: "msi", needsSignature: true },
      { win: true, authenticodeStatus: stubStatus(VALID).fn },
    );
    expect(gate).toMatchObject({ checked: true, ok: false });
    expect(gate.line).toMatch(/no signer/);
  });

  it("no shipped community-digest row is installable without a signer, and none has a guessed one", () => {
    vendor.clearToolSources();
    const rows = vendor.loadToolSources().rows as Record<
      string,
      { download?: { digestUrl?: string; archive?: string }; signer?: string }
    >;
    let community = 0;
    for (const [id, row] of Object.entries(rows)) {
      if (
        !row.download?.digestUrl ||
        !/raw\.githubusercontent\.com\/ScoopInstaller/.test(row.download.digestUrl)
      )
        continue;
      if (!["exe", "msi", "msix"].includes(String(row.download.archive))) continue;
      community += 1;
      const ready = vendor.downloadReadiness(vendor.rowSpec(id)).installable;
      expect(ready, id).toBe(Boolean(row.signer));
    }
    expect(community).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------ 4. redirect probe and the version floor */

describe("redirect-regex checks its final address; a stored version is a floor only once verified", () => {
  const reply = (url: string, status = 200) => ({
    ok: status < 400,
    status,
    url,
    headers: { get: () => null },
    text: async () => "",
    body: { cancel: async () => {} },
  });
  const spec = {
    kind: "redirect-regex",
    url: "https://aka.ms/vs/latest",
    pattern: "tool-([0-9.]+[0-9])",
  };

  it("a redirect that led off the allowlist is refused even though no body was read", async () => {
    const got = await vendor.resolveLatest("r", [spec], {
      fetchImpl: async () => reply("https://evil.example/tool-9.9.9.exe"),
    });
    expect(got.ok).toBe(false);
    expect(got.attempts[0].error).toMatch(/not an allowed host/);
  });

  it("an allowed host passes, and so does the HEAD-refused retry as a GET", async () => {
    const seen: string[] = [];
    const got = await vendor.resolveLatest("r", [spec], {
      fetchImpl: async (_u: string, init: { method?: string }) => {
        seen.push(init.method || "GET");
        return init.method === "HEAD"
          ? reply("", 405)
          : reply("https://github.com/o/r/tool-2.3.4.exe");
      },
    });
    expect(got).toMatchObject({ ok: true, version: "2.3.4" });
    expect(seen).toEqual(["HEAD", "GET"]);
  });

  it("a final address on a pinned host but another path is refused", async () => {
    const got = await vendor.resolveLatest("r", [spec], {
      fetchImpl: async () => reply("https://gitlab.com/someone/else/tool-3.0.0.exe"),
    });
    expect(got.ok).toBe(false);
    expect(got.attempts[0].error).toMatch(/not an allowed host/);
  });

  const page = (version: string) => ({
    ok: true,
    status: 200,
    url: "",
    headers: { get: () => null },
    text: async () => `v${version}`,
  });
  const html = { kind: "html-regex", url: "https://v.example/latest", pattern: "v([0-9.]+)" };

  it("an inflated 999 from a page that never had a digest does not freeze the real updates", async () => {
    const store = vendor.createFeedStore({ file: "" });
    await vendor.resolveLatest("x", [html], { fetchImpl: async () => page("999.0.0"), store });
    const real = await vendor.resolveLatest("x", [html], {
      fetchImpl: async () => page("5.0.0"),
      store,
    });
    expect(real).toMatchObject({ ok: true, version: "5.0.0", stale: false });
  });

  it("a version whose digest was verified is a floor", async () => {
    const store = vendor.createFeedStore({ file: "" });
    await vendor.resolveLatest("x", [html], { fetchImpl: async () => page("5.0.0"), store });
    store.markVerified("x", "5.0.0");
    const older = await vendor.resolveLatest("x", [html], {
      fetchImpl: async () => page("4.0.0"),
      store,
    });
    expect(older).toMatchObject({ version: "5.0.0", stale: true });
  });

  it("the verified mark survives a save and reload, and a different version is not covered by it", () => {
    const file = path.join(dir, "feeds.json");
    const a = vendor.createFeedStore({ file });
    a.putRow("x", { value: { version: "5.0.0" }, source: "html-regex", checkedAt: 1 });
    a.markVerified("x", "5.0.0");
    expect(a.flush()).toBe(true);
    const b = vendor.createFeedStore({ file });
    expect(b.isVerified("x", "5.0.0")).toBe(true);
    expect(b.isVerified("x", "999.0.0")).toBe(false);
    expect(b.isVerified("other", "5.0.0")).toBe(false);
  });

  it("a plan marks its version verified only for a digest from the data file's own source", async () => {
    const sourcesOf = (rows: Record<string, unknown>) => ({
      rows,
      errors: [],
      warnings: [],
      files: [],
    });
    const row = {
      home: "machine",
      sources: [html],
      download: {
        urlTemplate: "https://v.example/t/{version}/tool.zip",
        archive: "zip",
        digestUrl: "https://v.example/sums-{version}",
      },
    };
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      url: "",
      headers: { get: () => null },
      text: async () => (url.includes("sums") ? `${H("a")}\n` : "v3.1.0"),
    });
    const store = vendor.createFeedStore({ file: "" });
    const plan = await vendor.planRowDownload("Z", {
      toolSources: sourcesOf({ Z: row }),
      fetchImpl,
      store,
    });
    expect(plan.ok).toBe(true);
    expect(store.isVerified("Z", "3.1.0")).toBe(true);
    const lonely = vendor.createFeedStore({ file: "" });
    await vendor.planRowDownload("Z", {
      toolSources: sourcesOf({
        Z: { ...row, download: { ...row.download, digestUrl: "https://v.example/none-{version}" } },
      }),
      fetchImpl: async (url: string) =>
        url.includes("none")
          ? { ...(await fetchImpl("")), ok: false, status: 404 }
          : fetchImpl(url),
      store: lonely,
    });
    expect(lonely.isVerified("Z", "3.1.0")).toBe(false);
  });
});

/* ------------------------------------------------------------ 5. a reused managed program is checked */

describe("a managed program is reused only while it has the hash recorded at install time", () => {
  const tool = { id: "Demo Tool", archiveBin: "bin/demo.exe", pinVersion: "1.0.0" };
  const install = (text: string) => {
    const bin = path.join(managed.toolRoot(dir, tool), "bin", "demo.exe");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, text);
    return bin;
  };

  it("the marker stores the program's SHA-256 and the program verifies against it", () => {
    install("real program");
    expect(managed.writeMarker(dir, tool, { version: "2.0.0", bin: "bin/demo.exe" })).toBe(true);
    const marker = managed.readMarker(dir, tool);
    expect(marker.binSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(managed.verifyBin(dir, tool)).toEqual({ ok: true, managed: true });
  });

  it("a program swapped after the install is not trusted: its marker version is not reused", () => {
    const bin = install("real program");
    managed.writeMarker(dir, tool, { version: "2.0.0", bin: "bin/demo.exe" });
    writeFileSync(bin, "something else");
    const got = managed.verifyBin(dir, tool);
    expect(got.ok).toBe(false);
    expect(got.reason).toMatch(/differs/);
  });

  it("a marker from before hashes were recorded is installed again once", () => {
    install("real program");
    const file = path.join(managed.toolRoot(dir, tool), managed.MARKER);
    writeFileSync(file, JSON.stringify({ id: tool.id, version: "9.9.9", bin: "bin/demo.exe" }));
    expect(managed.verifyBin(dir, tool)).toMatchObject({ ok: false, managed: true });
  });

  it("no marked copy means nothing to distrust, and an unreadable program hashes to nothing", () => {
    expect(managed.verifyBin(dir, tool)).toEqual({ ok: true, managed: false });
    expect(managed.hashFile(path.join(dir, "missing.bin"))).toBe("");
  });

  it("the data-file step asks verifyBin before it counts the installed version", () => {
    const at = toolchainSource.indexOf("tryDataFileInstaller = async");
    const body = toolchainSource.slice(at, at + 3000);
    expect(body).toContain('require("./managed-install.cjs").verifyBin(root, tool)');
    expect(body.indexOf("verifyBin")).toBeLessThan(body.indexOf("await dataFileDownload("));
  });
});

/* ------------------------------------------------------------ 6. zip limits */

/** A one-entry zip whose central directory may declare a different size than the real one. */
function zipOf(name: string, data: Buffer, { declared = data.length, method = 8 } = {}): string {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const localAll = Buffer.concat([local, nameBuf, body]);
  const dir_ = Buffer.concat([central, nameBuf]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir_.length, 12);
  end.writeUInt32LE(localAll.length, 16);
  const file = path.join(dir, `z-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(file, Buffer.concat([localAll, dir_, end]));
  return file;
}

describe("extractZip refuses a zip bomb", () => {
  it("a normal zip still unpacks", () => {
    const out = path.join(dir, "ok");
    toolchain.extractZip(zipOf("a/b.txt", Buffer.from("hello world")), out);
    expect(readFileSync(path.join(out, "a/b.txt"), "utf8")).toBe("hello world");
  });

  it("an entry whose declared size is over the per-entry cap is refused before anything is written", () => {
    const out = path.join(dir, "o1");
    const file = zipOf("big.bin", Buffer.alloc(4096), { declared: 4096 });
    expect(() => toolchain.extractZip(file, out, { maxEntryBytes: 1024 })).toThrow(/refused/);
    expect(existsSync(path.join(out, "big.bin"))).toBe(false);
  });

  it("an entry that declares a small size but inflates past the cap is stopped while it inflates", () => {
    const out = path.join(dir, "o2");
    const file = zipOf("lie.bin", Buffer.alloc(64 * 1024), { declared: 10 });
    expect(() => toolchain.extractZip(file, out, { maxEntryBytes: 4096 })).toThrow(/refused/);
    expect(existsSync(path.join(out, "lie.bin"))).toBe(false);
  });

  it("the total over every entry is capped too", () => {
    const out = path.join(dir, "o3");
    const file = zipOf("t.bin", Buffer.alloc(8192));
    expect(() =>
      toolchain.extractZip(file, out, { maxEntryBytes: 16_384, maxTotalBytes: 4096 }),
    ).toThrow(/refused/);
  });

  it("a stored entry over the cap is refused as well", () => {
    const out = path.join(dir, "o4");
    const file = zipOf("raw.bin", Buffer.alloc(8192, 1), { method: 0 });
    expect(() => toolchain.extractZip(file, out, { maxEntryBytes: 1000 })).toThrow(/refused/);
  });

  it("the built-in caps are finite and generous (a real tool is far below them)", () => {
    const source = toolchainSource;
    expect(source).toMatch(/ZIP_ENTRY_MAX_BYTES = 2 \* 1024 \*\* 3/);
    expect(source).toMatch(/ZIP_TOTAL_MAX_BYTES = 8 \* 1024 \*\* 3/);
    expect(source).toContain("maxOutputLength");
  });
});

/* ------------------------------------------------------------ 8. host path prefixes */

describe("hosts that serve anyone's files are pinned to the paths the data files use", () => {
  const ok = (url: string) => expect(() => safety.assertAllowedUrl(url)).not.toThrow();
  const refused = (url: string) =>
    expect(() => safety.assertAllowedUrl(url), url).toThrow(/path is not allowed/);

  it("gitlab.com: Graphviz's project only", () => {
    ok("https://gitlab.com/api/v4/projects/4207231/packages/generic/g/1/x.zip");
    ok("https://gitlab.com/api/v4/projects/graphviz%2Fgraphviz/releases?per_page=1");
    refused("https://gitlab.com/someone/else/-/raw/main/payload.exe");
    refused("https://gitlab.com/api/v4/projects/999/packages/generic/g/1/x.zip");
  });

  it("sourceforge: the NSIS and Lua projects only", () => {
    ok("https://sourceforge.net/projects/nsis/best_release.json");
    ok("https://downloads.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11-setup.exe");
    refused("https://sourceforge.net/projects/evil/best_release.json");
    refused("https://downloads.sourceforge.net/project/evil/x.exe");
  });

  it("aka.ms, go.microsoft.com and jb.gg: only the paths the data files use", () => {
    ok("https://aka.ms/vs/18/stable/vs_community.exe");
    ok("https://aka.ms/dotnet/10.0/dotnet-sdk-win-x64.exe");
    refused("https://aka.ms/evil");
    ok("https://go.microsoft.com/fwlink/?linkid=2382519");
    refused("https://go.microsoft.com/other/page");
    ok("https://jb.gg/android-studio-releases-list.json");
    refused("https://jb.gg/anything-else");
  });

  it("a path trick does not get out: dot segments, encoded dots, a look-alike folder", () => {
    refused("https://aka.ms/vs/../evil");
    refused("https://aka.ms/vs/%2e%2e/evil");
    refused("https://aka.ms/vsevil/x.exe");
    refused("https://jb.gg/android-studio-releases-list.json/../x");
  });

  it("a host with no entry is unchanged", () => {
    ok("https://nodejs.org/dist/v24.0.0/node-v24.0.0-x64.msi");
    ok("https://github.com/any/repo/releases/download/v1/x.zip");
  });

  it("a redirect hop to another path on a pinned host is refused by the downloader", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url: unknown) =>
        new Response(null, {
          status: 302,
          headers: { location: String(url).includes("/vs/") ? "https://aka.ms/evil/x.exe" : "" },
        }),
    );
    await expect(safety.fetchAllowlisted("https://aka.ms/vs/18/stable/x.exe")).rejects.toThrow(
      /path is not allowed/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("the file is well formed and every shipped data-file address passes it", () => {
    const policy = safety.hostPolicy();
    for (const [host, list] of Object.entries(policy.pathPrefixes as Record<string, string[]>)) {
      expect(
        policy.families.some((f: { hosts?: string[] }) => f.hosts?.includes(host)),
        host,
      ).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      for (const entry of list) expect(entry.startsWith("/")).toBe(true);
    }
    vendor.clearToolSources();
    const rows = vendor.loadToolSources().rows as Record<
      string,
      { sources?: { url?: string }[]; download?: { urlTemplate?: string; digestUrl?: string } }
    >;
    let checked = 0;
    for (const [id, row] of Object.entries(rows)) {
      const urls = [
        ...(row.sources || []).map((s) => s.url),
        row.download?.urlTemplate,
        row.download?.digestUrl,
      ].filter(Boolean) as string[];
      for (const raw of urls) {
        const url = raw.replace(/\{\w+\}/g, "1.2.3");
        if (!/^https:/.test(url)) continue;
        expect(() => safety.assertAllowedUrl(url), `${id}: ${url}`).not.toThrow();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

/* ------------------------------------------------------------ 9. the catalogue row says how it was reached */

describe("the catalogue row carries via and installable", () => {
  const reply = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    url: "",
    headers: new Headers(),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const FACTS = {
    ramGb: 16,
    ramFreeGb: 10,
    gpus: [],
    sources: ["os-memory"],
    os: { is64Bit: true },
    cpu: { avx2: true },
    modelDrive: { freeGb: 100 },
    cuda: {},
    network: { online: true, metered: false },
    power: { onAc: true },
    vulkan: false,
  };
  const build = (fetchImpl: (url: string) => Promise<unknown>) =>
    catalogApi.createInstallerCatalog({
      root: () => dir,
      facts: () => FACTS,
      tools: () => [
        { id: "ripgrep", category: "Dev", latest: { kind: "github", ref: "BurntSushi/ripgrep" } },
        { id: "Visual Studio Code", category: "Dev" },
        { id: "7-Zip", category: "Dev" },
        { id: "Pinned", category: "Dev", pinnedLatest: { version: "1.0.0" } },
      ],
      detected: () => ({ tools: [] }),
      packs: () => [],
      voice: () => [],
      runners: () => [],
      fetchImpl,
      now: () => 1_800_000_000_000,
      privacy: () => false,
      online: () => true,
    });
  type Row = { id: string; via?: string; installable?: boolean; downloadReady?: boolean };
  const rowOf = (snap: { rows: Row[] }, id: string) => snap.rows.find((r) => r.id === id) as Row;

  it("a first-source answer reads primary, a later source reads fallback", async () => {
    const primary = build(async (url) => {
      if (url.startsWith("https://api.github.com/repos/BurntSushi/ripgrep"))
        return reply({ tag_name: "14.2.0", assets: [] });
      throw new Error("down");
    });
    await primary.refresh({ trigger: "startup" });
    expect(rowOf(primary.snapshot(), "ripgrep").via).toBe("primary");
    const fallbackDir = mkdtempSync(path.join(tmpdir(), "friday-sigate-fb-"));
    try {
      const fallback = catalogApi.createInstallerCatalog({
        root: () => fallbackDir,
        facts: () => FACTS,
        tools: () => [
          { id: "ripgrep", category: "Dev", latest: { kind: "github", ref: "BurntSushi/ripgrep" } },
        ],
        detected: () => ({ tools: [] }),
        packs: () => [],
        voice: () => [],
        runners: () => [],
        fetchImpl: async (url: string) => {
          if (url.includes("/releases.atom"))
            return reply(
              `<feed><entry><id>tag:github.com,2008:Repository/1/14.3.0</id><link href="https://github.com/BurntSushi/ripgrep/releases/tag/14.3.0"/><title>14.3.0</title></entry></feed>`,
            );
          throw new Error("api down");
        },
        now: () => 1_800_000_000_000,
        privacy: () => false,
        online: () => true,
      });
      await fallback.refresh({ trigger: "startup" });
      const via = rowOf(fallback.snapshot(), "ripgrep").via;
      expect(["fallback", "primary"]).toContain(via);
      expect(via).toBe("fallback");
    } finally {
      rmSync(fallbackDir, { recursive: true, force: true });
    }
  });

  it("a row that only has its pin reads pinned", () => {
    const snap = build(async () => {
      throw new Error("down");
    }).snapshot();
    expect(rowOf(snap, "Pinned").via).toBe("pinned");
  });

  it("a fresh catalogue still reads how the stored answer was reached", async () => {
    const net = async (url: string) => {
      if (url.startsWith("https://api.github.com/"))
        return reply({ tag_name: "14.2.0", assets: [] });
      throw new Error("down");
    };
    await build(net).refresh({ trigger: "startup" });
    vendor.storeFor(dir, { fresh: true });
    expect(rowOf(build(net).snapshot(), "ripgrep").via).toBe("primary");
  });

  it("tool rows say whether FRIDAY can install them itself: a published digest with a signer-free source yes, a community-only digest no", () => {
    const snap = build(async () => {
      throw new Error("down");
    }).snapshot();
    expect(rowOf(snap, "Visual Studio Code")).toMatchObject({
      installable: true,
      downloadReady: true,
    });
    expect(rowOf(snap, "7-Zip")).toMatchObject({ installable: false, downloadReady: false });
  });
});
