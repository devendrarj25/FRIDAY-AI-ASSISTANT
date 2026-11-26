/**
 * Hindi, English and Hinglish screens read properly: the OCR callers pick `hin+eng` when the Hindi data is installed,
 * the engine is found where its installer leaves it, and the Hindi data is added pinned and detect-first. No
 * network and no real Tesseract: the engine, the downloads and the file system are injected.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

type Env = Record<string, string>;
type Listing = (bin: string, env?: Env) => string[];
const ocr = require("../../electron/diagram-ocr.cjs") as {
  parseLangList: (text: string) => string[];
  findTesseract: (o: object) => string | null;
  chooseLanguages: (bin: string, o: object) => { lang: string; env: Env | null };
  ensureHindiData: (o: object) => Promise<{
    ok: boolean;
    skipped?: string;
    folder?: string;
    reason?: string;
  }>;
  userTessdataDir: (env: Env, platform: string) => string;
};

const tessFive =
  'List of available languages in "C:\\Program Files\\Tesseract-OCR/tessdata/" (3):\r\neng\r\nhin\r\nosd\r\n';

describe("parseLangList", () => {
  it("reads the codes under the header, CRLF or LF, and ignores everything else", () => {
    expect(ocr.parseLangList(tessFive)).toEqual(["eng", "hin", "osd"]);
    expect(ocr.parseLangList("List of available languages (2):\neng\nhin_old\n")).toEqual([
      "eng",
      "hin_old",
    ]);
    expect(ocr.parseLangList("Error opening data file\nFailed loading language 'hin'\n")).toEqual(
      [],
    );
    expect(ocr.parseLangList("")).toEqual([]);
  });
});

describe("chooseLanguages", () => {
  const bin = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";
  const lister =
    (map: Record<string, string[]>): Listing =>
    (_bin, env) =>
      map[env?.["TESSDATA_PREFIX"] ?? ""] ?? [];

  it("uses hin+eng when both are installed, eng alone otherwise", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
    expect(
      ocr.chooseLanguages(bin, {
        env,
        platform: "win32",
        listLangs: lister({ "": ["eng", "hin", "osd"] }),
        exists: () => false,
      }),
    ).toEqual({ lang: "hin+eng", env: null });
    expect(
      ocr.chooseLanguages(bin, {
        env,
        platform: "win32",
        listLangs: lister({ "": ["eng", "osd"] }),
        exists: () => false,
      }),
    ).toEqual({ lang: "eng", env: null });
    expect(
      ocr.chooseLanguages(bin, {
        env,
        platform: "win32",
        listLangs: lister({ "": ["hin"] }),
        exists: () => false,
      }).lang,
    ).toBe("hin");
    expect(
      ocr.chooseLanguages(bin, { env, platform: "win32", listLangs: () => [], exists: () => false })
        .lang,
    ).toBe("eng");
  });

  it("finds the per-user data folder when the engine's own folder has no Hindi", () => {
    const local = "C:\\Users\\a\\AppData\\Local";
    const folder = `${local}\\FRIDAY\\tools\\tessdata`;
    expect(ocr.userTessdataDir({ LOCALAPPDATA: local }, "win32")).toBe(folder);
    const picked = ocr.chooseLanguages(bin, {
      env: { LOCALAPPDATA: local },
      platform: "win32",
      listLangs: lister({ "": ["eng"], [folder]: ["eng", "hin", "osd"] }),
      exists: (file: string) => file === `${folder}\\hin.traineddata`,
    });
    expect(picked.lang).toBe("hin+eng");
    expect(picked.env?.["TESSDATA_PREFIX"]).toBe(folder);
  });

  it("never looks in a per-user folder off Windows", () => {
    expect(ocr.userTessdataDir({ LOCALAPPDATA: "/x" }, "linux")).toBe("");
  });
});

describe("findTesseract (the no-PATH problem)", () => {
  const win = { ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows\\system32" };

  it("falls back to Program Files when PATH does not have the engine", () => {
    const exe = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";
    expect(
      ocr.findTesseract({
        env: win,
        platform: "win32",
        toolDirs: [],
        exists: (f: string) => f === exe,
      }),
    ).toBe(exe);
  });

  it("prefers PATH, then the folders FRIDAY probes, then Program Files (x86)", () => {
    const onPath = "C:\\Tools\\tesseract.exe";
    expect(
      ocr.findTesseract({
        env: { ...win, PATH: "C:\\Tools" },
        platform: "win32",
        toolDirs: [],
        exists: () => true,
      }),
    ).toBe(onPath);
    const probed = "D:\\Probe\\tesseract.exe";
    expect(
      ocr.findTesseract({
        env: win,
        platform: "win32",
        toolDirs: ["D:\\Probe"],
        exists: (f: string) => f === probed,
      }),
    ).toBe(probed);
    const x86 = "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe";
    expect(
      ocr.findTesseract({
        env: { ...win, "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        platform: "win32",
        toolDirs: [],
        exists: (f: string) => f === x86,
      }),
    ).toBe(x86);
  });

  it("returns null when the engine is nowhere", () => {
    expect(
      ocr.findTesseract({ env: win, platform: "win32", toolDirs: [], exists: () => false }),
    ).toBeNull();
  });
});

describe("ensureHindiData", () => {
  const bytes = Buffer.from("fake hindi traineddata \u0939\u093f\u0928\u094d\u0926\u0940");
  const pin = {
    url: "https://example.invalid/hin.traineddata",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  const bin = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";
  const own = "C:\\Program Files\\Tesseract-OCR\\tessdata";
  const local = "C:\\Users\\a\\AppData\\Local";
  const user = `${local}\\FRIDAY\\tools\\tessdata`;

  /** An in-memory file system; `locked` folders refuse writes like Program Files without administrator rights. */
  function memory(initial: string[], locked: string[] = []) {
    const files = new Map<string, Buffer | string>(initial.map((f) => [f, "x"]));
    const folders = new Set<string>([own]);
    const isLocked = (file: string) => locked.some((dir) => file.startsWith(`${dir}\\`));
    return {
      files,
      api: {
        existsSync: (f: string) =>
          files.has(f) || folders.has(f) || [...files.keys()].some((k) => k.startsWith(`${f}\\`)),
        writeFileSync: (f: string, data: Buffer) => {
          if (isLocked(f)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          files.set(f, data);
        },
        renameSync: (from: string, to: string) => {
          files.set(to, files.get(from)!);
          files.delete(from);
        },
        mkdirSync: (f: string) => void folders.add(f),
        copyFileSync: (from: string, to: string) => void files.set(to, files.get(from)!),
        cpSync: (from: string, to: string) => {
          for (const [name, data] of [...files]) {
            if (name.startsWith(`${from}\\`)) files.set(`${to}${name.slice(from.length)}`, data);
          }
        },
      },
    };
  }
  /** `--list-langs` as the engine would answer: what is in the data folders it reads. */
  const listerFor =
    (files: Map<string, unknown>): Listing =>
    (_bin, env) => {
      const dir = env?.["TESSDATA_PREFIX"] || own;
      return ["eng", "hin", "osd"].filter((code) => files.has(`${dir}\\${code}.traineddata`));
    };

  const base = (extra: object = {}) => ({
    bin,
    pin,
    platform: "win32",
    env: { LOCALAPPDATA: local, ProgramFiles: "C:\\Program Files" } as Env,
    download: async () => bytes,
    ...extra,
  });

  it("skips when Hindi is already listed (detect first, no download)", async () => {
    const fs = memory([`${own}\\hin.traineddata`]);
    let downloads = 0;
    const result = await ocr.ensureHindiData(
      base({
        fsApi: fs.api,
        listLangs: listerFor(fs.files),
        download: async () => {
          downloads += 1;
          return bytes;
        },
      }),
    );
    expect(result).toEqual({ ok: true, skipped: "present" });
    expect(downloads).toBe(0);
  });

  it("skips offline and without an engine, and never downloads", async () => {
    const fs = memory([]);
    let downloads = 0;
    const download = async () => {
      downloads += 1;
      return bytes;
    };
    const offline = await ocr.ensureHindiData(
      base({
        fsApi: fs.api,
        listLangs: listerFor(fs.files),
        download,
        env: { FRIDAY_OFFLINE: "1", LOCALAPPDATA: local },
      }),
    );
    expect(offline.skipped).toBe("offline");
    expect((await ocr.ensureHindiData(base({ bin: "", download }))).skipped).toBe("engine-missing");
    expect(downloads).toBe(0);
    expect(fs.files.size).toBe(0);
  });

  it("writes the pinned data into the engine's own folder when it can", async () => {
    const fs = memory([`${own}\\eng.traineddata`]);
    const result = await ocr.ensureHindiData(
      base({ fsApi: fs.api, listLangs: listerFor(fs.files) }),
    );
    expect(result).toEqual({ ok: true, folder: own });
    expect(fs.files.get(`${own}\\hin.traineddata`)).toBe(bytes);
    expect(fs.files.has(`${own}\\hin.traineddata.part`)).toBe(false);
  });

  it("falls back to the per-user folder (eng and osd copied along) when Program Files is locked", async () => {
    const fs = memory(
      [`${own}\\eng.traineddata`, `${own}\\osd.traineddata`, `${own}\\configs\\tsv`],
      [own],
    );
    const result = await ocr.ensureHindiData(
      base({ fsApi: fs.api, listLangs: listerFor(fs.files) }),
    );
    expect(result).toEqual({ ok: true, folder: user });
    expect([...fs.files.keys()].sort()).toEqual(
      [
        `${own}\\eng.traineddata`,
        `${own}\\osd.traineddata`,
        `${own}\\configs\\tsv`,
        `${user}\\configs\\tsv`,
        `${user}\\eng.traineddata`,
        `${user}\\hin.traineddata`,
        `${user}\\osd.traineddata`,
      ].sort(),
    );
  });

  it("refuses data that does not match the pinned SHA-256 or size, and writes nothing", async () => {
    const fs = memory([]);
    const tampered = Buffer.from(bytes);
    tampered[3] = tampered[3]! ^ 0xff;
    const bad = await ocr.ensureHindiData(
      base({ fsApi: fs.api, listLangs: listerFor(fs.files), download: async () => tampered }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/SHA-256/);
    const short = await ocr.ensureHindiData(
      base({
        fsApi: fs.api,
        listLangs: listerFor(fs.files),
        download: async () => bytes.subarray(2),
      }),
    );
    expect(short.ok).toBe(false);
    expect(fs.files.size).toBe(0);
  });

  it("reports a failed download instead of throwing, and refuses an unpinned source", async () => {
    const fs = memory([]);
    const failed = await ocr.ensureHindiData(
      base({
        fsApi: fs.api,
        listLangs: listerFor(fs.files),
        download: async () => {
          throw new Error("offline proxy");
        },
      }),
    );
    expect(failed).toMatchObject({ ok: false });
    expect(failed.reason).toContain("offline proxy");
    const unpinned = await ocr.ensureHindiData(
      base({ fsApi: fs.api, listLangs: listerFor(fs.files), pin: { url: pin.url } }),
    );
    expect(unpinned.skipped).toBe("no-pin");
  });
});

describe("the wiring", () => {
  const versions = JSON.parse(read("config/toolchain-versions.json")) as {
    installerPins: Record<string, string>;
    tessdataHin: { url: string; sha256: string; bytes: number };
  };

  it("pins the Hindi data to a commit and a SHA-256, never to a moving branch", () => {
    expect(versions.tessdataHin.url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/tesseract-ocr\/tessdata_fast\/[0-9a-f]{40}\/hin\.traineddata$/,
    );
    expect(versions.tessdataHin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(versions.tessdataHin.bytes).toBeGreaterThan(1_000_000);
  });

  it("pins the Tesseract installer the setup downloads to the same hash the Install Manager pins", () => {
    const toolchain = read("electron/toolchain.cjs");
    const row = toolchain.slice(toolchain.indexOf('T("Tesseract OCR"'));
    const hash = /sha256: "([0-9a-f]{64})"/.exec(row.slice(0, 900))?.[1];
    const file = /releases\/download\/[^/]+\/([^"\s]+\.exe)/.exec(row.slice(0, 900))?.[1];
    expect(hash).toBeTruthy();
    expect(versions.installerPins[file!]).toBe(hash);
    expect(row.slice(0, 900)).toContain('postInstall: "tesseract-hindi"');
    expect(toolchain).toMatch(/postInstall === "tesseract-hindi"[\s\S]*ensureHindiData/);
  });

  it("no OCR caller hard-codes eng any more", () => {
    expect(read("electron/diagram-ocr.cjs")).not.toMatch(/"-l",\s*"eng"/);
    const control = read("kernel/control.py");
    expect(control).not.toMatch(/def read_text\([^)]*lang: str = "eng"/);
    expect(control).toContain("def ocr_language(");
    expect(read("kernel/tools.py")).not.toMatch(/control\.read_text[^\n]*"eng"/);
  });
});
