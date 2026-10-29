/**
 * FRIDAY · installer/registration
 *
 * Records this installation (root, version, platform, install time) so the updater and uninstaller know exactly what was installed and where.
 */
import path from "node:path";
import fs from "node:fs";
import { capabilities } from "../../core/discovery";
import {
  countFiles,
  ensureDirs,
  exists,
  findFiles,
  hashFile,
  isWritable,
  listDir,
  readJson,
  writeJson,
} from "../../core/paths";
import type { FridayModule, ModuleContext } from "../../core/types";

export interface Registration {
  root: string;
  version: string | null;
  platform: string;
  arch: string;
  registeredAt: number;
  executable: string;
}

const file = (root: string) => path.join(root, "config", "registration.json");

export function readRegistration(root = capabilities.getRoot()): Registration | null {
  return readJson<Registration>(file(root));
}

export function register(version: string | null, root = capabilities.getRoot()): Registration {
  const entry: Registration = {
    root,
    version,
    platform: process.platform,
    arch: process.arch,
    registeredAt: Date.now(),
    executable: process.execPath,
  };
  writeJson(file(root), entry);
  return entry;
}

export type RegistrationModule = FridayModule;

export const registrationModule: RegistrationModule = {
  id: "installer/registration",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "installer/registration ready");
  },
};

export default registrationModule;
