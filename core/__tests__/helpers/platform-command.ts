/**
 * A command stub the host can execute. Windows gets a .cmd launcher.
 * POSIX gets a shell script. PATH uses the platform delimiter.
 */
import fs from "node:fs";
import path from "node:path";

function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function writeCommandStub(
  dir: string,
  name: string,
  nodeScript: string,
): { file: string; pathEnv: string } {
  fs.mkdirSync(dir, { recursive: true });
  const cmdFile = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(
    cmdFile,
    `@echo off\r\n${cmdQuote(process.execPath)} ${cmdQuote(nodeScript)} %*\r\n`,
  );
  const shFile = path.join(dir, name);
  fs.writeFileSync(
    shFile,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(nodeScript)} "$@"\n`,
  );
  fs.chmodSync(shFile, 0o755);
  return {
    file: process.platform === "win32" ? cmdFile : shFile,
    pathEnv: prependPath(dir),
  };
}

export function prependPath(dir: string, base = process.env["PATH"] || ""): string {
  return [dir, base].filter((part) => part.length > 0).join(path.delimiter);
}
