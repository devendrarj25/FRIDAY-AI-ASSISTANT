import manifestJson from "../../../config/toolchain-manifest.json";

export type PackTier = "bundled" | "on-demand" | "external";

export type ToolPack = {
  id: string;
  name: string;
  version: string;
  sha256: string;
  bytes: number;
  license: string;
  url: string;
  tier: PackTier;
  entry: string;
  kind: string;
};

export type ToolchainManifest = {
  checked: string;
  budgetBytes: number;
  budgetReason: string;
  packs: ToolPack[];
};

const HEX64 = /^[a-f0-9]{64}$/;

export function isCopyleft(license: string): boolean {
  return /GPL|LGPL/i.test(license);
}

export function toolchainManifest(): ToolchainManifest {
  return manifestJson as ToolchainManifest;
}

export function validateManifest(manifest: ToolchainManifest): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let bundled = 0;
  if (!Number.isFinite(manifest.budgetBytes) || manifest.budgetBytes <= 0) {
    errors.push("budget");
  }
  for (const pack of manifest.packs) {
    if (!pack.id || seen.has(pack.id)) errors.push(`id ${pack.id}`);
    seen.add(pack.id);
    if (!HEX64.test(pack.sha256)) errors.push(`hash ${pack.id}`);
    if (!pack.license) errors.push(`license ${pack.id}`);
    if (!Number.isFinite(pack.bytes) || pack.bytes <= 0) errors.push(`bytes ${pack.id}`);
    if (!/^https:\/\//.test(pack.url)) errors.push(`url ${pack.id}`);
    if (!pack.entry || pack.entry.includes("..")) errors.push(`entry ${pack.id}`);
    if (pack.tier === "bundled" && isCopyleft(pack.license))
      errors.push(`copyleft bundled ${pack.id}`);
    if (pack.tier === "bundled") bundled += pack.bytes;
  }
  if (bundled > manifest.budgetBytes) errors.push("over budget");
  return errors;
}

export function bundledBytes(manifest: ToolchainManifest = toolchainManifest()): number {
  return manifest.packs
    .filter((pack) => pack.tier === "bundled")
    .reduce((sum, pack) => sum + pack.bytes, 0);
}

export function packById(
  id: string,
  manifest: ToolchainManifest = toolchainManifest(),
): ToolPack | null {
  return manifest.packs.find((pack) => pack.id === id) ?? null;
}

export function licenseNotices(manifest: ToolchainManifest = toolchainManifest()): string {
  const lines = [
    "FRIDAY toolchain and speech pack notices",
    `Checked ${manifest.checked}. Bundled bytes ${bundledBytes(manifest)}. Budget ${manifest.budgetBytes}.`,
    "",
  ];
  for (const pack of manifest.packs) {
    lines.push(`${pack.name} ${pack.version}`);
    lines.push(`License: ${pack.license}`);
    lines.push(`Source: ${pack.url}`);
    lines.push(`SHA-256: ${pack.sha256}`);
    lines.push(`Bytes: ${pack.bytes}`);
    lines.push(`Tier: ${pack.tier}`);
    lines.push("");
  }
  return lines.join("\n");
}

export type EnvPreference = "bundled-first" | "on-demand-first" | "system-first";

/**
 * A PATH for one FRIDAY shell. The process environment is not changed.
 * Order follows the owner's preference. Missing directories are skipped.
 */
export function isolatedEnv(input: {
  root: string;
  present: Record<string, string>;
  systemPath?: string;
  preference?: EnvPreference;
}): { PATH: string; FRIDAY_TOOLCHAIN: "1"; entries: string[] } {
  const preference = input.preference ?? "bundled-first";
  const manifest = toolchainManifest();
  const rank = (tier: PackTier) => {
    if (preference === "system-first")
      return tier === "external" ? 0 : tier === "on-demand" ? 1 : 2;
    if (preference === "on-demand-first")
      return tier === "on-demand" ? 0 : tier === "bundled" ? 1 : 2;
    return tier === "bundled" ? 0 : tier === "on-demand" ? 1 : 2;
  };
  const dirs: string[] = [];
  const ordered = [...manifest.packs].sort((a, b) => rank(a.tier) - rank(b.tier));
  for (const pack of ordered) {
    const dir = input.present[pack.id];
    if (dir) dirs.push(dir);
  }
  if (input.systemPath) dirs.push(input.systemPath);
  return { PATH: dirs.join(";"), FRIDAY_TOOLCHAIN: "1", entries: dirs };
}

export function explainTool(id: string, present: boolean): string {
  const pack = packById(id);
  if (!pack) return `${id} is not in the toolchain manifest.`;
  const where = present ? "this copy is on disk" : "this copy is not on disk yet";
  return `${pack.name} ${pack.version} is ${pack.tier}. ${where}. License ${pack.license}.`;
}

export type DoctorRow = {
  id: string;
  label: string;
  group: string;
  status: "Ready" | "Warning" | "Missing" | "Error";
  detail: string;
  fixable: false;
};

export function toolchainDoctorRows(present: Record<string, boolean> = {}): DoctorRow[] {
  return toolchainManifest().packs.map((pack) => {
    const here = present[pack.id] === true;
    return {
      id: `toolchain:${pack.id}`,
      label: pack.name,
      group: "Toolchain",
      status: here ? "Ready" : "Missing",
      detail: explainTool(pack.id, here),
      fixable: false,
    };
  });
}
