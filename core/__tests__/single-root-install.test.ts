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
import { join, normalize, resolve, sep } from "node:path";
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

type Env = {
  vars: Record<string, string>;
  reg: Record<string, string>;
  deferred: string[];
  /** Commands the script ran through nsExec::ExecToLog (a PowerShell helper cannot run here, so it is recorded). */
  ran?: string[];
  /** Environment variables the script set for the detached sweeper through System::Call. */
  sweepEnv?: Record<string, string>;
  /** The NSIS stack: Push and Pop of a variable save and restore it, as a function's scratch registers do. */
  stack?: string[];
};

/** Body of a named NSIS function from the shipped script. */
function functionBody(name: string): string {
  const start = nsh.indexOf(`Function ${name}`);
  const end = nsh.indexOf("FunctionEnd", start);
  return nsh.slice(nsh.indexOf("\n", start) + 1, end);
}

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
    // electron-builder's own switch: true in the old uninstaller that an upgrade runs first.
    if (condition === "${isUpdated}") return env.vars["__updated"] === "1";
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
    const ifnot = /^\$\{IfNot\}\s+(.+)$/.exec(line);
    if (ifnot) {
      const value = !test(ifnot[1]!);
      stack.push({ taken: value, active: value });
      continue;
    }
    const orif = /^\$\{OrIf\}\s+(.+)$/.exec(line);
    if (orif) {
      const frame = stack[stack.length - 1]!;
      const value = frame.taken || test(orif[1]!);
      frame.taken = value;
      frame.active = value;
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

    if (line.startsWith("nsExec::ExecToLog")) {
      (env.ran ??= []).push(expand(line));
      continue;
    }
    // A function the macro calls runs in the same state, exactly as NSIS shares its variables.
    const call = /^Call\s+(un\.\w+)$/.exec(line);
    if (call) {
      runNsis(functionBody(call[1]!), env);
      continue;
    }
    // Push and Pop of a variable save and restore it, so a function's scratch registers read as they do in NSIS.
    const push = /^Push\s+\$(\w+)$/.exec(line);
    if (push) {
      (env.stack ??= []).push(env.vars[push[1]!] ?? "");
      continue;
    }
    const pop = /^Pop\s+\$(\w+)$/.exec(line);
    if (pop) {
      env.vars[pop[1]!] = env.stack?.pop() ?? "";
      continue;
    }
    if (/^(DetailPrint|ClearErrors|SetShellVarContext|SetOutPath)\b/.test(line)) continue;

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
    // A macro with one text argument (the probes that pick a free preserved-folder name), run in the same state.
    const macroCall = /^!insertmacro\s+(\w+)\s+"(.*)"$/.exec(line);
    if (macroCall) {
      runNsis(macroBody(macroCall[1]!).replace(/\$\{Suffix\}/g, macroCall[2]!), env);
      continue;
    }
    const intop = /^IntOp\s+\$(\w+)\s+(\S+)\s+([+-])\s+(\S+)$/.exec(line);
    if (intop) {
      const a = Number(expand(intop[2]!));
      const b = Number(expand(intop[4]!));
      env.vars[intop[1]!] = String(intop[3] === "+" ? a + b : a - b);
      continue;
    }
    // The Windows path calls of the path normaliser, answered by the host: the full path resolves dot segments and
    // slashes; the long path answers only for what exists.
    const fullPathCall =
      /^System::Call 'Kernel32::GetFullPathNameW\(w (\w+),[^,]*,\s*w \.(\w+),[^)]*\)i \.(\w+)'$/.exec(
        line,
      );
    if (fullPathCall) {
      const input = env.vars[fullPathCall[1]!] ?? "";
      const out = input ? normalize(input) : "";
      env.vars[fullPathCall[2]!] = out;
      env.vars[fullPathCall[3]!] = String(out.length);
      continue;
    }
    const longPathCall =
      /^System::Call 'Kernel32::GetLongPathNameW\(w (\w+),\s*w \.(\w+),[^)]*\)i \.(\w+)'$/.exec(
        line,
      );
    if (longPathCall) {
      const input = env.vars[longPathCall[1]!] ?? "";
      const there = input !== "" && existsSync(input);
      env.vars[longPathCall[2]!] = there ? input : "";
      env.vars[longPathCall[3]!] = String(there ? input.length : 0);
      continue;
    }
    // The junction-following step of the path normaliser: this host has no junctions, so no folder is opened (a handle
    // of -1), and the spelling-only answer above stands.
    const openCall = /^System::Call 'Kernel32::CreateFileW\(w (\w+),[^)]*\)i \.(\w+)'$/.exec(line);
    if (openCall) {
      env.vars[openCall[2]!] = "-1";
      continue;
    }
    // The folders for the detached sweeper travel in its environment, not in its command line.
    const setEnv = /^System::Call 'Kernel32::SetEnvironmentVariable\(t "(\w+)", t "(.*)"\)'$/.exec(
      line,
    );
    if (setEnv) {
      (env.sweepEnv ??= {})[setEnv[1]!] = arg(setEnv[2]!);
      continue;
    }
    // The detached sweeper runs after the uninstaller exits; record its targets.
    if (line.startsWith("nsExec::Exec ")) {
      // The sweeper's targets are the variables in `$$t = @($$env:FRIDAY_SWEEP_APP, $$env:FRIDAY_SWEEP_ROOT)`;
      // an empty one is skipped by the helper (Where-Object { $$_ }).
      const list = /\$\$t = @\((.*?)\)/.exec(line)?.[1] ?? "";
      for (const match of list.matchAll(/\$\$env:(\w+)/g)) {
        const target = env.sweepEnv?.[match[1]!];
        if (target) env.deferred.push(target);
      }
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
    expect(nsh).toContain('StrCpy $INSTDIR "$FridayRoot\\${FRIDAY_APP_DIR}"');
    // The official program folder stays <root>\App; FRIDAY Test gets <root>\TestApp, so installing or removing Test
    // never touches the official program files (the two products share only the FRIDAY folder's resources).
    expect(nsh).toMatch(
      /!if "\$\{PRODUCT_NAME\}" == "FRIDAY Test"\r?\n\s+!define FRIDAY_APP_DIR "TestApp"[\s\S]*?!define FRIDAY_APP_TAIL "-8"\r?\n!else\r?\n\s+!define FRIDAY_APP_DIR "App"[\s\S]*?!define FRIDAY_APP_TAIL "-4"\r?\n!endif/,
    );
    // The installer smoke looks for the program where the installer puts it, for each product (FRIDAY Test Build
    // run 4 failed because the smoke still looked in <root>\\App after Test moved to <root>\\TestApp).
    const smoke = readFileSync(join(projectRoot, "scripts", "windows-installer-smoke.ps1"), "utf8");
    expect(smoke).toContain(
      '$appFolder = if ($Product -eq "FRIDAY Test") { "TestApp" } else { "App" }',
    );
    expect(smoke).toContain("$installDir = Join-Path $rootDir $appFolder");
    expect(smoke).not.toMatch(/\$installDir = Join-Path \$rootDir "App"/);
    // Defined for both passes: before the installer-only block, so the uninstaller pass sees it too.
    expect(nsh.indexOf('!define FRIDAY_APP_DIR "App"')).toBeLessThan(
      nsh.indexOf("!ifndef BUILD_UNINSTALLER"),
    );
    // No code line hard-codes the program folder any more.
    const code = nsh.split(/\r?\n/).filter((line) => !line.trim().startsWith(";"));
    expect(code.filter((line) => /"\\App"|\\App"|" -4$|" "" -4$/.test(line))).toEqual([]);
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

  it("delete mode never erases a stale pointer to a folder that is not FRIDAY's, and still erases one that carries a marker", () => {
    for (const named of [false, true]) {
      const { base, instdir, env } = buildInstall();
      const documents = join(base, "profile", "Documents");
      const plain = join(base, "profile", "Projects");
      for (const folder of [documents, plain]) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "mine.txt"), "the owner's file");
      }
      env.vars["DOCUMENTS"] = documents;
      env.vars["FridayUnMode"] = "delete";
      // A pointer left over, or edited, so that it names a folder FRIDAY never made: the shell folder and a plain one.
      for (const stale of [documents, plain]) {
        env.reg["Software\\FRIDAY\\WorkspacePath"] = stale;
        env.vars["FridayUnRoot"] = named ? stale : "";
        runNsis(macroBody("customUnInstall"), env);
        expect(readFileSync(join(stale, "mine.txt"), "utf8"), `${named} ${stale}`).toBe(
          "the owner's file",
        );
        // The program folder itself is still removed, so a failed pointer never keeps the uninstall from finishing.
        expect(env.deferred, `${named} ${stale}`).not.toContain(stale);
      }
      // The same folder, once it carries the marker FRIDAY writes, is the owner's FRIDAY folder and is erased.
      writeFileSync(join(plain, "workspace.json"), "{}");
      env.reg["Software\\FRIDAY\\WorkspacePath"] = plain;
      env.vars["FridayUnRoot"] = named ? plain : "";
      runNsis(macroBody("customUnInstall"), env);
      expect(existsSync(plain), `${named} marked`).toBe(false);
      expect(existsSync(instdir)).toBe(true);
    }
  });

  it("delete mode on a source checkout keeps the owner's source and Git history and hands the data to the helper", () => {
    const { root, instdir, env } = buildInstall();
    env.vars["FridayUnMode"] = "delete";
    // The FRIDAY folder is also the Git checkout the app was built from.
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export {}");
    mkdirSync(join(root, "kernel"), { recursive: true });
    writeFileSync(join(root, "kernel", "main.py"), "print('kernel')");
    env.ran = [];
    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });
    for (const target of env.deferred) rmSync(target, { recursive: true, force: true });

    // Nothing in the script removed the folder or the source in it.
    expect(existsSync(root)).toBe(true);
    expect(readFileSync(join(root, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main");
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe("export {}");
    expect(readFileSync(join(root, "kernel", "main.py"), "utf8")).toBe("print('kernel')");
    // The data is removed by the helper, which was asked about exactly this folder.
    expect(env.ran).toHaveLength(1);
    expect(env.ran[0]).toContain("remove-source-root-data.ps1");
    expect(env.ran[0]).toContain(`-Root "${root}"`);
    expect(env.deferred).not.toContain(root);
    // The rest of a complete removal still happens.
    expect(Object.keys(env.reg).filter((k) => k.startsWith("Software\\FRIDAY"))).toEqual([]);
  });

  it("delete mode on a source checkout removes the whole folder when the owner chose complete removal", () => {
    const { root, instdir, env } = buildInstall();
    env.vars["FridayUnMode"] = "delete";
    env.vars["FridayUnWipeSource"] = "1";
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export {}");
    mkdirSync(join(root, "release"), { recursive: true });
    writeFileSync(join(root, "release", "FRIDAY-Setup.exe"), "installer");
    // The stop script ships with the program; the uninstaller runs it only when it is there.
    const stopScript = join(instdir, "resources", "installer", "build");
    mkdirSync(stopScript, { recursive: true });
    writeFileSync(join(stopScript, "close-friday.ps1"), "param()");
    env.ran = [];
    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });
    for (const target of env.deferred) rmSync(target, { recursive: true, force: true });

    // The folder, the source, the Git history and the build output are all gone, like any FRIDAY folder.
    expect(existsSync(root)).toBe(false);
    expect(env.deferred).toContain(root);
    // Programs running from or standing in the folder were stopped first; the data-only helper never ran.
    expect(env.ran).toHaveLength(1);
    expect(env.ran[0]).toContain("close-friday.ps1");
    expect(env.ran[0]).toContain(`-ReleaseRoot "${root}"`);
    expect(env.ran.join("\n")).not.toContain("remove-source-root-data.ps1");
    expect(Object.keys(env.reg).filter((k) => k.startsWith("Software\\FRIDAY"))).toEqual([]);
  });

  it("a checkout is kept when the choice is unset or 0, as in a silent uninstall", () => {
    for (const wipe of [undefined, "0"]) {
      const { root, instdir, env } = buildInstall();
      env.vars["FridayUnMode"] = "delete";
      if (wipe !== undefined) env.vars["FridayUnWipeSource"] = wipe;
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");
      env.ran = [];
      runNsis(macroBody("customUnInstall"), env);
      rmSync(instdir, { recursive: true, force: true });
      for (const target of env.deferred) rmSync(target, { recursive: true, force: true });
      expect(existsSync(join(root, ".git", "HEAD"))).toBe(true);
      expect(env.deferred).not.toContain(root);
    }
  });

  it("a registered folder that is a whole drive is never deleted or released, even in delete mode", () => {
    for (const drive of ["D:\\", "D:", "D"]) {
      const { instdir, env } = buildInstall();
      env.vars["FridayUnMode"] = "delete";
      env.reg["Software\\FRIDAY\\WorkspacePath"] = drive;
      env.ran = [];
      runNsis(macroBody("customUnInstall"), env);
      // No stop script and no sweep for a drive root; only the program folder is the sweeper's target.
      expect(env.ran.join("\n")).not.toContain("ReleaseRoot");
      expect(env.deferred).toEqual([instdir]);
    }
  });

  it("sweeps the program folder and the root through the environment, not the command line", () => {
    const { root, instdir, env } = buildInstall();
    env.vars["FridayUnMode"] = "delete";
    runNsis(macroBody("customUnInstall"), env);
    expect(env.sweepEnv).toEqual({ FRIDAY_SWEEP_APP: instdir, FRIDAY_SWEEP_ROOT: root });
  });

  it("removes only the graphics choice FRIDAY itself wrote, and keeps one the owner made", () => {
    const key = "Software\\Microsoft\\DirectX\\UserGpuPreferences\\$INSTDIR\\FRIDAY.exe";
    for (const [value, kept] of [
      ["GpuPreference=2;", false],
      ["GpuPreference=1;", true],
    ] as const) {
      const { env } = buildInstall();
      env.reg[key] = value;
      runNsis(macroBody("customUnInstall"), env);
      expect(key in env.reg, value).toBe(kept);
    }
  });

  it("a source checkout is also recognised by its build script when there is no .git", () => {
    const { root, instdir, env } = buildInstall();
    env.vars["FridayUnMode"] = "delete";
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "build-windows.cmd"), "@echo off");
    env.ran = [];
    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });
    expect(existsSync(join(root, "scripts", "build-windows.cmd"))).toBe(true);
    expect(env.ran).toHaveLength(1);
  });

  it("keep mode on a source checkout never calls the helper", () => {
    const { root, instdir, env } = buildInstall();
    mkdirSync(join(root, ".git"), { recursive: true });
    env.ran = [];
    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });
    expect(env.ran).toEqual([]);
    expect(existsSync(join(root, "database", "user-content"))).toBe(true);
  });

  const RUN = "Software\\Microsoft\\Windows\\CurrentVersion\\Run\\FRIDAY";
  const APPROVED =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run\\FRIDAY";

  it("a real keep uninstall removes the sign-in start entry and the old run's markers, and nothing of the data", () => {
    const { root, instdir, env } = buildInstall();
    env.reg[RUN] = join(instdir, "FRIDAY.exe");
    env.reg[APPROVED] = "02 00 00 00";
    const userData = join(env.vars["APPDATA"]!, "FRIDAY");
    mkdirSync(userData, { recursive: true });
    for (const name of ["gpu-fallback.json", "lifecycle.json", "owned-pids.json", "Local State"]) {
      writeFileSync(join(userData, name), "x");
    }
    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });

    expect(env.reg[RUN]).toBeUndefined();
    expect(env.reg[APPROVED]).toBeUndefined();
    for (const name of ["gpu-fallback.json", "lifecycle.json", "owned-pids.json"]) {
      expect(existsSync(join(userData, name)), name).toBe(false);
    }
    // Other files of the app's user-data folder are not this uninstaller's to remove.
    expect(existsSync(join(userData, "Local State"))).toBe(true);
    for (const folder of ["database", "memory", "models", "config", "agents", "skills"]) {
      expect(existsSync(join(root, folder, "user-content"))).toBe(true);
    }
    expect(env.reg["Software\\FRIDAY\\WorkspacePath"]).toBe(root);
  });

  it("the uninstaller an upgrade runs first keeps the sign-in start entry", () => {
    const { instdir, env } = buildInstall();
    env.vars["__updated"] = "1";
    env.reg[RUN] = join(instdir, "FRIDAY.exe");
    env.reg[APPROVED] = "02 00 00 00";
    runNsis(macroBody("customUnInstall"), env);
    expect(env.reg[RUN]).toBe(join(instdir, "FRIDAY.exe"));
    expect(env.reg[APPROVED]).toBe("02 00 00 00");
  });

  it("a delete-all uninstall removes the sign-in entry and its approval flag", () => {
    const { instdir, env } = buildInstall();
    env.vars["FridayUnMode"] = "delete";
    env.reg[RUN] = join(instdir, "FRIDAY.exe");
    env.reg[APPROVED] = "02 00 00 00";
    runNsis(macroBody("customUnInstall"), env);
    expect(env.reg[RUN]).toBeUndefined();
    expect(env.reg[APPROVED]).toBeUndefined();
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

describe("Setup records the folder it was started from, for the app to find a CMD build beside it", () => {
  const install = macroBody("customInstall");
  const SOURCE = "Software\\FRIDAY\\InstallSourceDir";

  it("writes InstallSourceDir = $EXEDIR for each product, except when the update helper starts Setup", () => {
    expect(install).toContain('WriteRegStr HKCU "Software\\FRIDAY" "InstallSourceDir" "$EXEDIR"');
    expect(install).toContain(
      'WriteRegStr HKCU "Software\\FRIDAY Test" "InstallSourceDir" "$EXEDIR"',
    );
    // An update runs from the updater's own download folder: that must not replace the folder Setup came from.
    const at = install.indexOf('"InstallSourceDir"');
    expect(install.lastIndexOf("${IfNot} ${isUpdated}", at)).toBeGreaterThan(
      install.indexOf('"WorkspacePath"'),
    );
    // The registry key is written after the program folder pointer, never before the root is known.
    expect(at).toBeGreaterThan(install.indexOf('"WorkspacePath"'));
  });

  it("is never read by the uninstaller: nothing reads it for a delete", () => {
    expect(nsh).not.toMatch(/ReadReg\w*\s[^\n]*InstallSourceDir/);
    expect(nsh).not.toMatch(/\$\{?InstallSourceDir/);
    // Not a path any RMDir or Delete could take: the only mentions are the two writes and the two removals.
    const mentions = nsh.split(/\r?\n/).filter((l) => l.includes("InstallSourceDir"));
    expect(
      mentions.every(
        (l) => /^\s*(WriteRegStr|DeleteRegValue)\b/.test(l) || l.trim().startsWith(";"),
      ),
    ).toBe(true);
  });

  it("a real keep uninstall forgets it, an update's uninstall keeps it, a delete-all removes the whole key", () => {
    const keep = buildInstall();
    keep.env.reg[SOURCE] = "E:\\Builds\\1.2.5.8";
    runNsis(macroBody("customUnInstall"), keep.env);
    expect(keep.env.reg[SOURCE]).toBeUndefined();
    expect(keep.env.reg["Software\\FRIDAY\\WorkspacePath"]).toBe(keep.root);

    const update = buildInstall();
    update.env.vars["__updated"] = "1";
    update.env.reg[SOURCE] = "E:\\Builds\\1.2.5.8";
    runNsis(macroBody("customUnInstall"), update.env);
    expect(update.env.reg[SOURCE]).toBe("E:\\Builds\\1.2.5.8");

    const wipe = buildInstall();
    wipe.env.vars["FridayUnMode"] = "delete";
    wipe.env.reg[SOURCE] = "E:\\Builds\\1.2.5.8";
    runNsis(macroBody("customUnInstall"), wipe.env);
    expect(Object.keys(wipe.env.reg).filter((k) => k.startsWith("Software\\FRIDAY\\"))).toEqual([]);
  });
});

describe("a folder made by a CMD build reads as an existing FRIDAY folder", () => {
  const detect = functionBody("FridayRootDetect");
  // The folders named directly and the ones named through the one-line detection macro.
  const probed = [
    ...[...detect.matchAll(/\$FridayRoot\\([^"*\s]+?)\\\*\.\*/g)].map((m) => m[1]!),
    ...[...detect.matchAll(/!insertmacro FridayDetectFolder "([^"]+)"/g)].map((m) => m[1]!),
  ];
  const known = new Set(
    (contract.NAMES as string[]).flatMap((name: string) =>
      [name, ...contract.FOLDERS[name].aliases].map((x: string) =>
        x.replace(/\//g, "\\").toLowerCase(),
      ),
    ),
  );

  it("recognises the runtime, cache and installer folders and the contract's alias spellings", () => {
    for (const folder of ["runtime", "cache", "installer", "downloads", "updates"]) {
      expect(probed, folder).toContain(folder);
    }
    for (const alias of [
      "db",
      "data\\models",
      "data\\state",
      "cache\\models",
      "resources\\voices",
    ]) {
      expect(probed, alias).toContain(alias);
    }
  });

  it("looks only for folders the storage contract names (a name or an alias), so no folder is invented", () => {
    expect(probed.length).toBeGreaterThan(8);
    for (const folder of probed) expect(known.has(folder.toLowerCase()), folder).toBe(true);
  });

  it("only reports and reuses: detection creates, moves and removes nothing", () => {
    expect(detect).not.toMatch(/\b(CreateDirectory|RMDir|Rename|Delete|CopyFiles)\b/);
    expect(detect).toContain("it will be validated and reused, never overwritten");
  });
});

describe("no RMDir reaches above the program folder or into a folder the owner chose to keep", () => {
  it("every RMDir targets the program folder's own parts, FRIDAY's caches or - only in delete mode - the root", () => {
    const targets = nsh
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^RMDir\b/.test(l))
      .map((l) => l.replace(/^RMDir\s+(\/r\s+)?/, ""));
    for (const t of targets) {
      expect(t, t).not.toContain("..");
      expect(t, t).not.toMatch(/^"\$INSTDIR"$/);
      expect(t, t).not.toMatch(/^"\$FridayRoot/);
    }
    const root = targets.filter((t) => t.startsWith('"$FridayUnRoot'));
    expect(root.sort()).toEqual(['"$FridayUnRoot"', '"$FridayUnRoot\\profiles\\test"']);
    // The whole-root removal sits inside the delete branch, behind the explicit choice.
    const at = nsh.indexOf('RMDir /r "$FridayUnRoot"');
    expect(nsh.lastIndexOf('${If} $FridayUnMode == "delete"', at)).toBeGreaterThan(
      nsh.lastIndexOf('${If} $FridayUnMode == "keep"', at),
    );
    // Nothing removes a data folder of the root by name.
    for (const t of targets)
      expect(t, t).not.toMatch(/\\(database|memory|models|config|agents|skills)\b/);
  });
});

describe("the data guard sees through a path spelled to look outside the program folder", () => {
  it("rescues data whose pointer reaches the program folder through a dot segment", () => {
    const { base, root, instdir, env } = buildInstall();
    const nested = join(instdir, "data-root");
    mkdirSync(join(nested, "memory"), { recursive: true });
    writeFileSync(join(nested, "memory", "user-content"), "memory");
    // Starts in the data folder "database", walks back out and into App: it is inside App all the same.
    env.reg["Software\\FRIDAY\\WorkspacePath"] =
      `${root}${sep}database${sep}..${sep}App${sep}data-root`;

    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });

    const preserved = join(base, "profile", "FRIDAY");
    expect(existsSync(join(preserved, "memory", "user-content"))).toBe(true);
    expect(env.reg["Software\\FRIDAY\\WorkspacePath"]).toBe(preserved);
  });

  it("keeps a real FRIDAY folder in the profile and puts the rescued data beside it, in a free name", () => {
    const { base, instdir, env } = buildInstall();
    const nested = join(instdir, "data-root");
    mkdirSync(join(nested, "memory"), { recursive: true });
    writeFileSync(join(nested, "memory", "user-content"), "memory");
    env.reg["Software\\FRIDAY\\WorkspacePath"] = nested;
    for (const name of ["FRIDAY", "FRIDAY-preserved"]) {
      mkdirSync(join(base, "profile", name), { recursive: true });
      writeFileSync(join(base, "profile", name, "mine.txt"), name);
    }

    runNsis(macroBody("customUnInstall"), env);
    rmSync(instdir, { recursive: true, force: true });

    const preserved = join(base, "profile", "FRIDAY-preserved-2");
    expect(readFileSync(join(preserved, "memory", "user-content"), "utf8")).toBe("memory");
    expect(env.reg["Software\\FRIDAY\\WorkspacePath"]).toBe(preserved);
    for (const name of ["FRIDAY", "FRIDAY-preserved"]) {
      expect(readFileSync(join(base, "profile", name, "mine.txt"), "utf8")).toBe(name);
      expect(existsSync(join(base, "profile", name, "data-root"))).toBe(false);
    }
  });
});
