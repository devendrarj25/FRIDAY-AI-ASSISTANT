import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const projectRoot = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const contract = require_(join(projectRoot, "electron/friday-contract.cjs"));
const nsh = readFileSync(join(projectRoot, "installer/build/installer.nsh"), "utf8");

/**
 * ONE ROOT: the user picks a single folder; the program lives in <root>\App and
 * every data folder is its sibling. These tests EXECUTE the shipped
 * customUnInstall body against a real folder tree instead of only grepping it,
 * so "keep removes only App" and "delete removes the whole root" are proven
 * outcomes, not claims about text.
 */

/** Body of an NSIS macro from the shipped script. */
function macroBody(name: string): string {
  const start = nsh.indexOf(`!macro ${name}`);
  const end = nsh.indexOf("!macroend", start);
  return nsh.slice(nsh.indexOf("\n", start) + 1, end);
}

type Env = { vars: Record<string, string>; reg: Record<string, string>; deferred: string[] };

/**
 * Minimal NSIS interpreter covering exactly the instructions customUnInstall
 * uses. Anything it does not understand is a hard failure, so the test cannot
 * silently pass over a command that would delete data on Windows.
 */
function runNsis(body: string, env: Env): void {
  const expand = (text: string) =>
    text
      .replace(/\$\{PRODUCT_NAME\}/g, env.vars["PRODUCT_NAME"] ?? "")
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*|\d)/g, (whole, name: string) =>
        name in env.vars ? env.vars[name]! : whole,
      );
  // NSIS paths use backslashes; run them through the host separator so the
  // real filesystem work below happens on Linux CI exactly as on Windows.
  const arg = (text: string) => expand(text.trim().replace(/^"|"$/g, "")).replace(/\\/g, sep);

  const lines = body.split("\n").map((l) => l.trim());
  // Condition stack: each frame says whether its branch currently executes.
  const stack: { taken: boolean; active: boolean }[] = [];
  const live = () => stack.every((f) => f.active);

  const test = (condition: string): boolean => {
    const fileExists = /^\$\{FileExists\}\s+(.+)$/.exec(condition);
    if (fileExists) {
      const target = arg(fileExists[1]!).replace(/[\\/]\*\.\*$/, "");
      return existsSync(target);
    }
    if (condition === "${Errors}") return false;
    const compare = /^(.+?)\s+(==|!=)\s+(.+)$/.exec(condition);
    if (!compare) throw new Error(`unsupported condition: ${condition}`);
    const left = arg(compare[1]!);
    const right = arg(compare[3]!);
    return compare[2] === "==" ? left === right : left !== right;
  };

  for (const raw of lines) {
    const line = raw.replace(/^;.*/, "");
    if (!line) continue;

    const iff = /^\$\{If\}\s+(.+)$/.exec(line);
    if (iff) {
      const value = test(iff[1]!);
      stack.push({ taken: value, active: value });
      continue;
    }
    const andif = /^\$\{AndIf\}\s+(.+)$/.exec(line);
    if (andif) {
      const frame = stack[stack.length - 1]!;
      const value = frame.taken && test(andif[1]!);
      frame.taken = value;
      frame.active = value;
      continue;
    }
    if (line === "${Else}") {
      const frame = stack[stack.length - 1]!;
      frame.active = !frame.taken;
      continue;
    }
    if (line === "${EndIf}") {
      stack.pop();
      continue;
    }
    if (!live()) continue;

    if (/^(DetailPrint|ClearErrors|Pop|nsExec::ExecToLog|SetShellVarContext)\b/.test(line))
      continue;

    const rmdir = /^RMDir\s+(?:\/r\s+)?(.+)$/.exec(line);
    if (rmdir) {
      rmSync(arg(rmdir[1]!), { recursive: true, force: true });
      continue;
    }
    const del = /^Delete\s+(.+)$/.exec(line);
    if (del) {
      rmSync(arg(del[1]!), { force: true });
      continue;
    }
    const rename = /^Rename\s+(".*?")\s+(".*?")$/.exec(line);
    if (rename) {
      const from = arg(rename[1]!);
      if (existsSync(from)) renameSync(from, arg(rename[2]!));
      continue;
    }
    const strlen = /^StrLen\s+\$(\w+)\s+(.+)$/.exec(line);
    if (strlen) {
      env.vars[strlen[1]!] = String(arg(strlen[2]!).length);
      continue;
    }
    const strcpy = /^StrCpy\s+\$(\w+)\s+(".*?"|\S+)(?:\s+(\S+))?(?:\s+(\S+))?$/.exec(line);
    if (strcpy) {
      const source = arg(strcpy[2]!);
      const length = strcpy[3] !== undefined ? Number(expand(strcpy[3])) : null;
      const offset = strcpy[4] !== undefined ? Number(expand(strcpy[4])) : null;
      let value = source;
      if (offset !== null) value = offset < 0 ? source.slice(offset) : source.slice(offset);
      else if (length !== null)
        value = length < 0 ? source.slice(0, length) : source.slice(0, length);
      if (length !== null && offset !== null)
        value = length < 0 ? source.slice(offset) : source.slice(offset, offset + length);
      env.vars[strcpy[1]!] = value;
      continue;
    }
    const readReg = /^ReadRegStr\s+\$(\w+)\s+\w+\s+"(.+?)"\s+"(.+?)"$/.exec(line);
    if (readReg) {
      env.vars[readReg[1]!] = env.reg[`${readReg[2]}\\${readReg[3]}`] ?? "";
      continue;
    }
    const writeReg = /^WriteRegStr\s+\w+\s+"(.+?)"\s+"(.+?)"\s+(".*?")$/.exec(line);
    if (writeReg) {
      env.reg[`${writeReg[1]}\\${writeReg[2]}`] = arg(writeReg[3]!);
      continue;
    }
    const delRegValue = /^DeleteRegValue\s+\w+\s+"(.+?)"\s+"(.+?)"$/.exec(line);
    if (delRegValue) {
      delete env.reg[`${delRegValue[1]}\\${delRegValue[2]}`];
      continue;
    }
    const delRegKey = /^DeleteRegKey\s+(\/ifempty\s+)?\w+\s+"(.+?)"$/.exec(line);
    if (delRegKey) {
      const prefix = `${delRegKey[2]}\\`;
      const remaining = Object.keys(env.reg).filter((key) => key.startsWith(prefix));
      // "/ifempty" removes the key only when it still holds no values — that is
      // what keeps WorkspacePath alive through a keep-uninstall.
      if (delRegKey[1] && remaining.length) continue;
      for (const key of remaining) delete env.reg[key];
      continue;
    }
    // The detached sweeper runs after the uninstaller exits; record its targets.
    if (line.startsWith("nsExec::Exec ")) {
      for (const match of line.matchAll(/Remove-Item -LiteralPath \$\\?'(.+?)\$\\?'/g))
        env.deferred.push(expand(match[1]!));
      continue;
    }
    throw new Error(`unsupported NSIS instruction in customUnInstall: ${line}`);
  }
}

/** A real installed layout: <root>/App plus populated sibling data folders. */
function buildInstall(): { base: string; root: string; instdir: string; env: Env } {
  const base = mkdtempSync(join(tmpdir(), "friday-install-"));
  const root = join(base, "FRIDAY");
  const instdir = join(root, "App");
  mkdirSync(join(instdir, "resources"), { recursive: true });
  writeFileSync(join(instdir, "FRIDAY.exe"), "program");
  mkdirSync(join(instdir, "runtime"), { recursive: true });
  for (const folder of ["database", "memory", "models", "config", "agents", "skills"]) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, "user-content"), folder);
  }
  // Windows always has these; create them so real renames/copies can happen.
  for (const shell of ["profile", "appdata", "localappdata", "temp"])
    mkdirSync(join(base, shell), { recursive: true });
  const env: Env = {
    vars: {
      PRODUCT_NAME: "FRIDAY",
      INSTDIR: instdir,
      FridayUnRoot: "",
      FridayUnMode: "",
      PROFILE: join(base, "profile"),
      APPDATA: join(base, "appdata"),
      LOCALAPPDATA: join(base, "localappdata"),
      TEMP: join(base, "temp"),
      SYSDIR: join(base, "sysdir"),
    },
    reg: { "Software\\FRIDAY\\WorkspacePath": root, "Software\\FRIDAY\\InstallPath": instdir },
    deferred: [],
  };
  return { base, root, instdir, env };
}

describe("single-root install layout", () => {
  it("puts the program in <root>/App and every data folder beside it", () => {
    expect(contract.PROGRAM_FOLDER).toBe("app");
    expect(contract.FOLDERS.app.aliases).toContain("App");
    // The program folder is never a data store — Setup replaces it wholesale.
    expect(contract.FOLDERS.app.children).toEqual([]);
    for (const name of ["database", "memory", "models", "config"])
      expect(contract.NAMES).toContain(name);
  });

  it("asks one folder question and derives the program folder from the answer", () => {
    expect(nsh).toContain("Where should FRIDAY live?");
    expect(nsh).toContain('StrCpy $INSTDIR "$FridayRoot\\App"');
    expect(nsh).not.toContain("$FridayDataDir");
  });
});

describe("uninstall executed against a real folder tree", () => {
  it("keep mode removes only <root>/App and leaves all data byte-for-byte", () => {
    const { root, instdir, env } = buildInstall();
    runNsis(macroBody("customUnInstall"), env);
    // electron-builder's uninstall section ends with this unconditional line.
    rmSync(instdir, { recursive: true, force: true });

    expect(existsSync(instdir)).toBe(false);
    for (const folder of ["database", "memory", "models", "config", "agents", "skills"]) {
      expect(existsSync(join(root, folder, "user-content"))).toBe(true);
      expect(readFileSync(join(root, folder, "user-content"), "utf8")).toBe(folder);
    }
    expect(existsSync(root)).toBe(true);
    // The pointer survives so a later Setup reuses exactly this folder.
    expect(env.reg["Software\\FRIDAY\\WorkspacePath"]).toBe(root);
    expect(env.deferred).toEqual([]);
  });

  it("delete mode removes the entire root, program folder included", () => {
    const { root, instdir, env } = buildInstall();
    env.vars["FridayUnMode"] = "delete";
    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });
    // The detached sweeper finishes the job once the uninstaller exits.
    for (const target of env.deferred) rmSync(target, { recursive: true, force: true });

    expect(env.deferred).toContain(instdir);
    expect(existsSync(root)).toBe(false);
    expect(Object.keys(env.reg).filter((k) => k.startsWith("Software\\FRIDAY"))).toEqual([]);
  });

  it("rescues data that an older build left inside the program folder", () => {
    const { base, instdir, env } = buildInstall();
    // Pointer from a legacy install: the root sits *inside* $INSTDIR.
    const nested = join(instdir, "data-root");
    mkdirSync(join(nested, "memory"), { recursive: true });
    writeFileSync(join(nested, "memory", "user-content"), "memory");
    env.reg["Software\\FRIDAY\\WorkspacePath"] = nested;

    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });

    const preserved = join(base, "profile", "FRIDAY");
    expect(existsSync(join(preserved, "memory", "user-content"))).toBe(true);
    expect(env.reg["Software\\FRIDAY\\WorkspacePath"]).toBe(preserved);
  });
});
