import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keep-mode uninstall, data folder inside the program folder.
 *
 * An old pointer or a silent install can leave the FRIDAY root inside "<root>\App". The uninstaller moves the data
 * out before electron-builder's unconditional `RMDir /r $INSTDIR`. These tests EXECUTE the shipped guard region
 * against a simulated file tree (the move helper is a PowerShell process that cannot run here, so its three outcomes
 * are simulated): when the data could not be moved out in full, the uninstall must stop and remove nothing.
 */
const nsh = readFileSync(
  path.resolve(__dirname, "..", "..", "installer", "build", "installer.nsh"),
  "utf8",
).replace(/\r\n/g, "\n");

/** The shipped guard: from the keep-mode condition to the FRIDAY Test branch that follows it. */
function guardRegion(): string {
  const macroAt = nsh.indexOf("!macro customUnInstall");
  const guardAt = nsh.indexOf("LAST-LINE DATA GUARD", macroAt);
  const start = nsh.indexOf('${If} $FridayUnMode == "keep"', guardAt);
  const end = nsh.indexOf("; TEST is a separate installed product", start);
  expect(guardAt).toBeGreaterThan(macroAt);
  expect(end).toBeGreaterThan(start);
  return nsh.slice(start, end);
}

class UninstallAborted extends Error {}

type Move = "full" | "partial" | "none";
type World = {
  /** Every folder or file that exists, as backslash paths. */
  tree: Set<string>;
  vars: Record<string, string>;
  reg: Record<string, string>;
  boxes: string[];
  ran: string[];
  /** The process environment the installer sets for the helper it starts (System::Call SetEnvironmentVariable). */
  env: Record<string, string>;
  renameFails: boolean;
  helper: Move;
  /** A path the partial helper run could not move (a locked file). */
  locked: string;
};

const under = (tree: Set<string>, base: string) =>
  [...tree].filter((p) => p === base || p.startsWith(`${base}\\`));

function relocate(world: World, from: string, to: string, skip?: string): void {
  for (const item of under(world.tree, from)) {
    if (skip && item === skip) continue;
    world.tree.delete(item);
    world.tree.add(`${to}${item.slice(from.length)}`);
  }
}

function runGuard(world: World): void {
  const expand = (text: string) =>
    text.replace(/\$([A-Za-z_]\w*|\d)/g, (whole, name: string) => world.vars[name] ?? whole);
  const arg = (text: string) => expand(text.trim().replace(/^"|"$/g, ""));
  let errors = false;
  const stack: { taken: boolean; active: boolean }[] = [];
  const live = () => stack.every((f) => f.active);
  const test = (condition: string): boolean => {
    const exists = /^\$\{FileExists\}\s+(.+)$/.exec(condition);
    if (exists) return under(world.tree, arg(exists[1]!).replace(/\\\*\.\*$/, "")).length > 0;
    if (condition === "${Errors}") return errors;
    const compare = /^(.+?)\s+(==|!=)\s+(.+)$/.exec(condition);
    if (!compare) throw new Error(`unsupported condition: ${condition}`);
    const same = arg(compare[1]!) === arg(compare[3]!);
    return compare[2] === "==" ? same : !same;
  };
  for (const raw of guardRegion().split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const head = /^\$\{(If|AndIf|OrIf)\}\s+(.+)$/.exec(line);
    if (head) {
      const value = test(head[2]!);
      if (head[1] === "If") stack.push({ taken: value, active: value });
      else {
        const frame = stack[stack.length - 1]!;
        frame.taken = head[1] === "AndIf" ? frame.taken && value : frame.taken || value;
        frame.active = frame.taken;
      }
      continue;
    }
    if (line === "${EndIf}") {
      stack.pop();
      continue;
    }
    if (!live()) continue;
    if (/^(DetailPrint|Pop)\b/.test(line)) continue;
    if (line === "ClearErrors") {
      errors = false;
      continue;
    }
    if (line === "Abort") throw new UninstallAborted();
    const box = /^MessageBox\s+(\S+)\s+"(.*)"\s+\/SD\s+(\S+)$/.exec(line);
    if (box) {
      world.boxes.push(expand(box[2]!));
      continue;
    }
    if (line.startsWith("MessageBox"))
      throw new Error(`a MessageBox without /SD hangs a silent uninstall: ${line}`);
    const rename = /^Rename\s+(".*?")\s+(".*?")$/.exec(line);
    if (rename) {
      if (world.renameFails) errors = true;
      else relocate(world, arg(rename[1]!), arg(rename[2]!));
      continue;
    }
    const setEnv =
      /^System::Call\s+'Kernel32::SetEnvironmentVariable\(t "(\w+)",\s*t "(.*)"\)'$/.exec(line);
    if (setEnv) {
      world.env[setEnv[1]!] = expand(setEnv[2]!);
      continue;
    }
    if (line.startsWith("nsExec::ExecToLog")) {
      // What the helper process really receives: NSIS turns $$ into $ and $\' into a plain apostrophe.
      world.ran.push(expand(line).replace(/\$\$/g, "$").replace(/\$\\'/g, "'"));
      // The helper reads its two folders from its environment, as the shipped command does.
      const from = world.env["FRIDAY_UN_FROM"] ?? "";
      const to = world.env["FRIDAY_UN_TO"] ?? "";
      if (!from || !to) continue;
      if (world.helper === "full") relocate(world, from, to);
      if (world.helper === "partial") relocate(world, from, to, world.locked);
      continue;
    }
    const strlen = /^StrLen\s+\$(\w+)\s+(.+)$/.exec(line);
    if (strlen) {
      world.vars[strlen[1]!] = String(arg(strlen[2]!).length);
      continue;
    }
    const strcpy = /^StrCpy\s+\$(\w+)\s+(".*?")(?:\s+(\$?\w+))?$/.exec(line);
    if (strcpy) {
      const source = arg(strcpy[2]!);
      world.vars[strcpy[1]!] =
        strcpy[3] === undefined ? source : source.slice(0, Number(expand(strcpy[3])));
      continue;
    }
    const writeReg = /^WriteRegStr\s+\w+\s+"(.+?)"\s+"(.+?)"\s+(".*?")$/.exec(line);
    if (writeReg) {
      world.reg[`${writeReg[1]}\\${writeReg[2]}`] = arg(writeReg[3]!);
      continue;
    }
    throw new Error(`unsupported NSIS instruction in the move guard: ${line}`);
  }
}

const INSTDIR = "D:\\Apps\\FRIDAY\\App";
const DATA = `${INSTDIR}\\data-root`;
const POINTER = "Software\\FRIDAY\\WorkspacePath";

function world(over: Partial<World> = {}): World {
  const tree = new Set<string>([
    INSTDIR,
    `${INSTDIR}\\FRIDAY.exe`,
    DATA,
    `${DATA}\\memory`,
    `${DATA}\\memory\\notes.db`,
    `${DATA}\\database`,
    `${DATA}\\database\\friday.db`,
    "C:\\Users\\owner",
  ]);
  return {
    tree,
    vars: { INSTDIR, FridayUnRoot: DATA, FridayUnMode: "keep", PROFILE: "C:\\Users\\owner" },
    reg: { [POINTER]: DATA },
    boxes: [],
    ran: [],
    env: {},
    renameFails: false,
    helper: "full",
    locked: `${DATA}\\database\\friday.db`,
    ...over,
  };
}

describe("keep-mode uninstall with the data folder inside the program folder", () => {
  it("moves the data out by rename and re-points the pointer", () => {
    const w = world();
    runGuard(w);
    expect(w.tree.has("C:\\Users\\owner\\FRIDAY\\memory\\notes.db")).toBe(true);
    expect(w.tree.has("C:\\Users\\owner\\FRIDAY")).toBe(true);
    expect(w.tree.has(`${DATA}`)).toBe(false);
    expect(w.reg[POINTER]).toBe("C:\\Users\\owner\\FRIDAY");
    expect(w.boxes).toEqual([]);
    expect(w.ran).toEqual([]);
  });

  it("falls back to the move helper when the rename fails, and still succeeds when it moves everything", () => {
    const w = world({ renameFails: true, helper: "full" });
    runGuard(w);
    expect(w.ran).toHaveLength(1);
    expect(w.tree.has("C:\\Users\\owner\\FRIDAY\\database\\friday.db")).toBe(true);
    expect(under(w.tree, DATA)).toEqual([]);
    expect(w.reg[POINTER]).toBe("C:\\Users\\owner\\FRIDAY");
  });

  it("stops the uninstall, with a message, when the helper moves nothing", () => {
    const w = world({ renameFails: true, helper: "none" });
    expect(() => runGuard(w)).toThrow(UninstallAborted);
    expect(w.boxes).toHaveLength(1);
    expect(w.boxes[0]).toContain(DATA);
    // Nothing moved, nothing removed, and the pointer still names the folder that holds the data.
    expect(under(w.tree, DATA)).toHaveLength(5);
    expect(w.reg[POINTER]).toBe(DATA);
  });

  it("stops the uninstall when the helper moved only part of the data", () => {
    const w = world({ renameFails: true, helper: "partial" });
    expect(() => runGuard(w)).toThrow(UninstallAborted);
    expect(w.boxes).toHaveLength(1);
    // The locked file is still beside the program, so the pointer must not move to a half copy.
    expect(w.tree.has(w.locked)).toBe(true);
    expect(w.reg[POINTER]).toBe(DATA);
  });

  it("does nothing when the data folder is not inside the program folder", () => {
    const outside = "C:\\Users\\owner\\FRIDAY-data";
    const w = world({ reg: { [POINTER]: outside } });
    w.vars["FridayUnRoot"] = outside;
    w.tree.add(outside);
    w.tree.add(`${outside}\\memory`);
    runGuard(w);
    expect(w.tree.has(`${outside}\\memory`)).toBe(true);
    expect(w.reg[POINTER]).toBe(outside);
    expect(w.boxes).toEqual([]);
  });

  it("stops with a message that also names where the part that was already moved went", () => {
    const w = world({ renameFails: true, helper: "partial" });
    expect(() => runGuard(w)).toThrow(UninstallAborted);
    expect(w.boxes[0]).toContain(DATA);
    expect(w.boxes[0]).toContain("C:\\Users\\owner\\FRIDAY");
    // The log line names it too, and the stop branch still only reports and stops.
    expect(guardRegion()).toMatch(
      /DetailPrint "[^"\n]*\$4[^"\n]*"\n\s*MessageBox MB_OK\|MB_ICONSTOP/,
    );
  });

  it("does not take a sibling folder whose name starts with the program folder's name for a folder inside it", () => {
    const sibling = "D:\\Apps\\FRIDAY\\App-data";
    const w = world({ reg: { [POINTER]: sibling }, renameFails: true, helper: "full" });
    w.vars["FridayUnRoot"] = sibling;
    w.tree.add(sibling);
    w.tree.add(`${sibling}\\memory`);
    runGuard(w);
    expect(w.tree.has(`${sibling}\\memory`)).toBe(true);
    expect(w.reg[POINTER]).toBe(sibling);
    expect(w.ran).toEqual([]);
    expect(w.boxes).toEqual([]);
    expect(w.tree.has("C:\\Users\\owner\\FRIDAY")).toBe(false);
  });

  it("still takes a folder inside the program folder, however deep, and the program folder itself", () => {
    const deep = `${INSTDIR}\\a\\b`;
    const w = world();
    w.vars["FridayUnRoot"] = deep;
    w.tree.add(`${INSTDIR}\\a`);
    w.tree.add(deep);
    w.tree.add(`${deep}\\memory`);
    runGuard(w);
    expect(w.tree.has("C:\\Users\\owner\\FRIDAY\\memory")).toBe(true);
    const same = world();
    same.vars["FridayUnRoot"] = INSTDIR;
    runGuard(same);
    expect(same.reg[POINTER]).toBe("C:\\Users\\owner\\FRIDAY");
  });

  it("passes the two folders to the move helper in its environment, never inside its command line", () => {
    const w = world({ renameFails: true, helper: "full" });
    runGuard(w);
    expect(w.env["FRIDAY_UN_FROM"]).toBe(DATA);
    expect(w.env["FRIDAY_UN_TO"]).toBe("C:\\Users\\owner\\FRIDAY");
    expect(w.ran).toHaveLength(1);
    expect(w.ran[0]).toContain("$env:FRIDAY_UN_FROM");
    expect(w.ran[0]).toContain("$env:FRIDAY_UN_TO");
    expect(w.ran[0]).not.toContain(DATA);
    expect(w.ran[0]).not.toMatch(/-(LiteralPath|Destination) '/);
    expect(under(w.tree, DATA)).toEqual([]);
  });

  it("moves a folder whose name, or whose owner's profile name, holds an apostrophe, without injection", () => {
    const quoted = `${INSTDIR}\\O'Brien'; Remove-Item C:\\ -Recurse; '`;
    const w = world({ renameFails: true, helper: "full" });
    w.vars["FridayUnRoot"] = quoted;
    w.vars["PROFILE"] = "C:\\Users\\O'Neil";
    w.tree.add(quoted);
    w.tree.add(`${quoted}\\memory`);
    w.tree.add("C:\\Users\\O'Neil");
    runGuard(w);
    // No part of either path is in the command text, so no apostrophe in a name can end a quote.
    expect(w.ran[0]).not.toContain("O'");
    expect(w.ran[0]).not.toContain("Remove-Item");
    expect(w.env["FRIDAY_UN_FROM"]).toBe(quoted);
    expect(w.env["FRIDAY_UN_TO"]).toBe("C:\\Users\\O'Neil\\FRIDAY");
    expect(w.tree.has("C:\\Users\\O'Neil\\FRIDAY\\memory")).toBe(true);
  });
});
