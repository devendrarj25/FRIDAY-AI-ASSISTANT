/**
 * The branding step stamps the packaged FRIDAY.exe with resedit (pure JavaScript), so it can be proven here on a
 * small generated Windows executable instead of waiting for a Windows build. The result is read back with the same
 * library: the four-part version in the fixed block and in the strings, the publisher, the icon and the
 * normal-user execution level.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const brand = require(path.join(root, "scripts", "brand-windows.cjs"));
const IDENTITY = require(path.join(root, "scripts", "identity.cjs"));

/** The smallest PE32+ image resedit accepts: one empty code section, no resources yet. */
function minimalPe(): Buffer {
  const file = Buffer.alloc(0x400);
  file.write("MZ", 0, "latin1");
  file.writeUInt32LE(0x40, 0x3c);
  file.write("PE\0\0", 0x40, "latin1");
  let o = 0x44;
  file.writeUInt16LE(0x8664, o); // machine x64
  file.writeUInt16LE(1, o + 2); // sections
  file.writeUInt16LE(240, o + 16); // optional header size
  file.writeUInt16LE(0x0022, o + 18); // executable, large address aware
  o = 0x58;
  file.writeUInt16LE(0x20b, o); // PE32+
  file.writeUInt32LE(0x200, o + 4); // size of code
  file.writeUInt32LE(0x1000, o + 16); // entry point
  file.writeUInt32LE(0x1000, o + 20); // base of code
  file.writeBigUInt64LE(0x140000000n, o + 24); // image base
  file.writeUInt32LE(0x1000, o + 32); // section alignment
  file.writeUInt32LE(0x200, o + 36); // file alignment
  file.writeUInt16LE(6, o + 40); // os major
  file.writeUInt16LE(6, o + 48); // subsystem major
  file.writeUInt32LE(0x2000, o + 56); // size of image
  file.writeUInt32LE(0x200, o + 60); // size of headers
  file.writeUInt16LE(3, o + 68); // console
  file.writeBigUInt64LE(0x100000n, o + 72);
  file.writeBigUInt64LE(0x1000n, o + 80);
  file.writeBigUInt64LE(0x100000n, o + 88);
  file.writeBigUInt64LE(0x1000n, o + 96);
  file.writeUInt32LE(16, o + 108); // data directories
  o = 0x58 + 240;
  file.write(".text", o, "latin1");
  file.writeUInt32LE(0x10, o + 8); // virtual size
  file.writeUInt32LE(0x1000, o + 12); // virtual address
  file.writeUInt32LE(0x200, o + 16); // raw size
  file.writeUInt32LE(0x200, o + 20); // raw offset
  file.writeUInt32LE(0x60000020, o + 36); // code, executable, readable
  return file;
}

const MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
    <requestedExecutionLevel level="requireAdministrator" uiAccess="false"></requestedExecutionLevel>
  </requestedPrivileges></security></trustInfo>
</assembly>`;

async function withManifest(file: string, xml: string) {
  const ResEdit = await import("resedit");
  const exe = ResEdit.NtExecutable.from(minimalPe());
  const resources = ResEdit.NtExecutableResource.from(exe);
  const bytes = Buffer.from(xml, "utf8");
  resources.entries.push({
    type: 24,
    id: 1,
    lang: 1033,
    codepage: 1200,
    bin: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  resources.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
}

describe("Windows executable branding", () => {
  it("stamps version, publisher, icon and execution level in one pass", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-brand-"));
    try {
      const file = path.join(dir, "FRIDAY.exe");
      await withManifest(file, MANIFEST);
      const versionString = IDENTITY.windowsResourceStamp({
        productName: IDENTITY.PRODUCT,
        fileVersion: "1.1.4.7",
        productVersion: "1.1.4.7",
      });
      await brand.stampExecutable(file, {
        icon: path.join(root, "installer", "build", "icon.ico"),
        fileVersion: "1.1.4.7",
        versionString,
      });

      const ResEdit = await import("resedit");
      const resources = ResEdit.NtExecutableResource.from(
        ResEdit.NtExecutable.from(readFileSync(file)),
      );
      const info = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0]!;
      const strings = info.getStringValues(info.getAllLanguagesForStringValues()[0]!);
      expect(strings["ProductName"]).toBe(IDENTITY.PRODUCT);
      expect(strings["CompanyName"]).toBe(IDENTITY.PUBLISHER);
      expect(strings["FileVersion"]).toBe("1.1.4.7");
      expect(strings["ProductVersion"]).toBe("1.1.4.7");
      expect(strings["OriginalFilename"]).toBe("FRIDAY.exe");
      // 1.1.4.7 in the numeric block: MS = 1.1, LS = 4.7. The strings and the numbers cannot disagree.
      expect(info.fixedInfo.fileVersionMS).toBe(0x00010001);
      expect(info.fixedInfo.fileVersionLS).toBe(0x00040007);
      expect(info.fixedInfo.productVersionMS).toBe(0x00010001);
      expect(info.fixedInfo.productVersionLS).toBe(0x00040007);

      const manifest = resources.entries.find((entry) => entry.type === 24)!;
      const xml = Buffer.from(manifest.bin as ArrayBuffer).toString("utf8");
      expect(xml).toContain('requestedExecutionLevel level="asInvoker"');
      expect(xml).not.toContain("requireAdministrator");

      const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
      expect(groups.length).toBe(1);
      expect(resources.entries.filter((entry) => entry.type === 3).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stamping twice gives the same strings (no second pass is needed)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-brand-"));
    try {
      const file = path.join(dir, "FRIDAY.exe");
      await withManifest(file, MANIFEST);
      const options = {
        icon: path.join(root, "installer", "build", "icon.ico"),
        fileVersion: "1.0.0.0",
        versionString: IDENTITY.windowsResourceStamp({
          productName: IDENTITY.TEST_PRODUCT,
          fileVersion: "1.0.0.0",
          productVersion: "1.0.0.0-test.1",
        }),
      };
      await brand.stampExecutable(file, options);
      await brand.stampExecutable(file, options);
      const ResEdit = await import("resedit");
      const info = ResEdit.Resource.VersionInfo.fromEntries(
        ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(readFileSync(file))).entries,
      )[0]!;
      const strings = info.getStringValues(info.getAllLanguagesForStringValues()[0]!);
      expect(strings["ProductName"]).toBe(IDENTITY.TEST_PRODUCT);
      expect(strings["ProductVersion"]).toBe("1.0.0.0-test.1");
      // A TEST identity keeps the suffix in the string only; the numeric block stays a.b.c.d.
      expect(info.fixedInfo.productVersionLS).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a version that is not four numbers, and adds an execution level when the manifest has none", () => {
    expect(brand.withExecutionLevel('<assembly xmlns="x"></assembly>', "asInvoker")).toContain(
      'requestedExecutionLevel level="asInvoker" uiAccess="false"',
    );
    expect(() => brand.withExecutionLevel("<nothing/>", "asInvoker")).toThrow(/assembly/);
    return expect(
      brand.stampExecutable("does-not-matter.exe", {
        icon: "x.ico",
        fileVersion: "1.0.0",
        versionString: {},
      }),
    ).rejects.toThrow(/four-part/);
  });
});
