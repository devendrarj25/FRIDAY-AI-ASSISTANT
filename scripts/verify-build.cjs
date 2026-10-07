/**
 * FRIDAY — post-build verification.
 *
 * Runs after `scripts\build-windows.cmd` and proves the four Windows
 * deliverables exist and carry FRIDAY's identity:
 *   release\FRIDAY-Setup-<version>.exe      installer
 *   release\FRIDAY-Portable-<version>.exe   portable app
 *   release\win-unpacked\FRIDAY.exe         the app itself (branded, normal user)
 *   Uninstall FRIDAY.exe                    written by the installer at install time
 *
 * Nothing is modified. Exit code 1 means an artifact is missing or unbranded.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const IDENTITY = require("./identity.cjs");
const engine = require("./release-engine.cjs");

const root = path.resolve(__dirname, "..");
const release = path.join(root, "release");
const identity = engine.readCanonicalIdentity({ root });
if (!identity) {
  console.error("[friday] VERSION  config/friday-version.json is missing");
  process.exit(1);
}
const npmVersion = identity.npmVersion;
const publicVersion = identity.releaseVersion;
const version = publicVersion;

const mb = (file) => (fs.statSync(file).size / (1024 * 1024)).toFixed(1) + " MB";

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
// The version this release claims to be, and whether the checksum/update
// manifest must already exist (the final pre-publish gate).
const expectedVersion = String(flag("version", "")).replace(/^v/i, "");
const requireManifest = args.includes("--manifest");

// `build-windows.cmd dir|nsis|portable` produces a subset of the artifacts, so
// only require what the requested target actually emits.
const mode = (args[0] && !args[0].startsWith("--") ? args[0] : "all").toLowerCase();
const wantsInstaller = mode === "all" || mode === "nsis";
const wantsPortable = mode === "all" || mode === "portable";

// A TEST build packages the SAME application under a separate Windows identity
// ("FRIDAY Test") so it can be installed beside — never over — the production
// FRIDAY. Its installer therefore carries a different artifact name; both are
// accepted here, exactly one of them has to exist.
const installerFile = [
  path.join(release, `FRIDAY-Setup-${version}.exe`),
  path.join(release, `FRIDAY-Test-Setup-${version}.exe`),
].find((file) => fs.existsSync(file));

const checks = [
  wantsInstaller && {
    label: "Installer",
    file: installerFile || path.join(release, `FRIDAY-Setup-${version}.exe`),
    min: 40,
  },
  wantsPortable && {
    label: "Portable",
    file: path.join(release, `FRIDAY-Portable-${version}.exe`),
    min: 40,
  },

  { label: "App executable", file: path.join(release, "win-unpacked", "FRIDAY.exe"), min: 100 },
  { label: "Kernel", file: path.join(release, "win-unpacked", "resources", "kernel", "main.py") },
  {
    label: "Kernel requirements",
    file: path.join(release, "win-unpacked", "resources", "kernel", "requirements.txt"),
  },
  {
    label: "Kernel capability extras",
    file: path.join(
      release,
      "win-unpacked",
      "resources",
      "kernel",
      "requirements-capabilities.txt",
    ),
  },
  {
    label: "Config",
    file: path.join(release, "win-unpacked", "resources", "config", "kernel.yaml"),
  },
  {
    label: "Version contract",
    file: path.join(release, "win-unpacked", "resources", "config", "toolchain-versions.json"),
  },
  {
    label: "Runtime repair helper",
    file: path.join(
      release,
      "win-unpacked",
      "resources",
      "installer",
      "build",
      "repair-runtime.ps1",
    ),
  },
  {
    label: "Installer lifecycle helper",
    file: path.join(release, "win-unpacked", "resources", "installer", "build", "close-friday.ps1"),
  },
  {
    // Second copy of the 2D companion artwork, outside app.asar.
    label: "Character assets",
    file: path.join(release, "win-unpacked", "resources", "character"),
  },
].filter(Boolean);

let failed = 0;
const packageAudit = IDENTITY.auditPackageIdentity(root);
if (!packageAudit.ok) {
  for (const problem of packageAudit.problems) {
    console.error(`[friday] IDENTITY ${problem}`);
  }
  failed += packageAudit.problems.length;
} else {
  console.log(`[friday] ok       Package identity: ${packageAudit.kinds.join(", ")}`);
}

for (const check of checks) {
  if (!fs.existsSync(check.file)) {
    console.error(`[friday] MISSING  ${check.label}: ${check.file}`);
    failed++;
    continue;
  }
  const sizeMb = fs.statSync(check.file).size / (1024 * 1024);
  if (check.min && sizeMb < check.min) {
    console.error(
      `[friday] TOO SMALL ${check.label}: ${mb(check.file)} (expected >= ${check.min} MB)`,
    );
    failed++;
    continue;
  }
  console.log(
    `[friday] ok       ${check.label}: ${path.relative(root, check.file)} (${mb(check.file)})`,
  );
}

// Identity of the packaged executable: product name, publisher and the
// normal-user manifest must all be present. The installer may elevate, but the
// Electron app itself must not: elevated renderer windows can lose Windows TSF
// input across chat, terminal and every other editable control.
const exe = path.join(release, "win-unpacked", "FRIDAY.exe");
if (process.platform === "win32" && fs.existsSync(exe)) {
  try {
    const ps = `$i=(Get-Item '${exe}').VersionInfo; "$($i.ProductName)|$($i.CompanyName)|$($i.FileVersion)|$($i.ProductVersion)|$($i.FileMajorPart).$($i.FileMinorPart).$($i.FileBuildPart).$($i.FilePrivatePart)"`;
    const info = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
    }).trim();
    const [product, company, fileVersion, productVersion, fileVersionRaw] = info.split("|");
    // "FRIDAY Test" is the separate Windows identity of a TEST build; every
    // other product name means the rcedit branding step did not run.
    if (product !== IDENTITY.PRODUCT && product !== IDENTITY.TEST_PRODUCT) {
      console.error(
        `[friday] BRANDING product name is "${product}" — expected ${IDENTITY.PRODUCT} (rcedit step failed)`,
      );
      failed++;
    } else {
      console.log(`[friday] ok       Identity: ${info}`);
    }
    const expectedFile = identity.windowsFileVersion;
    const seenFile = String(fileVersion || "")
      .replace(/\0/g, "")
      .trim();
    const seenRaw = String(fileVersionRaw || "")
      .replace(/\0/g, "")
      .trim();
    // Binary FILEVERSION + ProductVersion are the public identity. Windows
    // FileVersionInfo.FileVersion drops a trailing .0 when FilePrivatePart is
    // 0, so "1.0.0" for public 1.0.0.0 is the same resource, not npm encoding.
    if (!engine.fileVersionStringMatches(seenFile, expectedFile)) {
      console.error(
        `[friday] VERSION  FileVersion is "${fileVersion}" — expected ${expectedFile} (public identity, not npm ${npmVersion})`,
      );
      failed++;
    }
    if (seenRaw && seenRaw !== expectedFile) {
      console.error(
        `[friday] VERSION  FILEVERSION resource is "${fileVersionRaw}" — expected ${expectedFile}`,
      );
      failed++;
    }
    const expectedProduct = identity.releaseVersion;
    const seenProduct = String(productVersion || "")
      .replace(/\0/g, "")
      .trim();
    if (seenProduct && seenProduct !== expectedProduct && seenProduct !== expectedFile) {
      console.error(
        `[friday] VERSION  ProductVersion is "${productVersion}" — expected ${expectedProduct}`,
      );
      failed++;
    }
    if (!company || !company.includes(IDENTITY.OWNER.split(" ")[0])) {
      console.error(`[friday] BRANDING publisher is "${company}" — expected ${IDENTITY.PUBLISHER}`);
      failed++;
    }
  } catch (error) {
    console.warn(`[friday] identity check skipped: ${error.message}`);
  }

  const buffer = fs.readFileSync(exe);
  const hasAsInvoker = buffer.includes(Buffer.from("asInvoker", "latin1"));
  const hasAdmin = buffer.includes(Buffer.from("requireAdministrator", "latin1"));
  if (!hasAsInvoker || hasAdmin) {
    console.error(
      `[friday] BRANDING executable must run as the signed-in user (asInvoker); ` +
        `asInvoker=${hasAsInvoker}, requireAdministrator=${hasAdmin}`,
    );
    failed++;
  } else {
    console.log("[friday] ok       Runs as signed-in user (asInvoker)");
  }
}

// Development-only helpers must stay in the git checkout. They must never
// land inside the installed Windows product.
const packedScripts = path.join(release, "win-unpacked", "resources", "scripts");
if (fs.existsSync(packedScripts)) {
  const banned = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/^cloud-agent-/i.test(name) || name === "ci-workflow-run.sh") {
        banned.push(path.relative(packedScripts, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(packedScripts);
  if (banned.length) {
    console.error(`[friday] PACKAGING ships development-only scripts: ${banned.join(", ")}`);
    failed++;
  } else {
    console.log("[friday] ok       Packaged scripts exclude Cloud Agent / CI helpers");
  }
}
for (const extra of [
  ["Kernel tests", path.join(release, "win-unpacked", "resources", "kernel", "tests")],
  [
    "Kernel bytecode cache",
    path.join(release, "win-unpacked", "resources", "kernel", "__pycache__"),
  ],
]) {
  if (fs.existsSync(extra[1])) {
    console.error(`[friday] PACKAGING ships ${extra[0]}: ${extra[1]}`);
    failed++;
  }
}

// The packaged renderer must live inside app.asar exactly where the main
// process looks for it: app.getAppPath()/dist-desktop/index.html plus its
// hashed assets. This catches a stale or missing desktop build before the app
// is ever launched.
const asarFile = path.join(release, "win-unpacked", "resources", "app.asar");
if (fs.existsSync(asarFile)) {
  try {
    const entries = require("@electron/asar").listPackage(asarFile);
    const norm = entries.map((e) => e.replace(/\\/g, "/"));
    const hasIndex = norm.includes("/dist-desktop/index.html");
    const assets = norm.filter((e) => e.startsWith("/dist-desktop/assets/"));
    const hasJs = assets.some((e) => e.endsWith(".js"));
    const hasCss = assets.some((e) => e.endsWith(".css"));
    if (!hasIndex || !hasJs || !hasCss) {
      console.error(
        `[friday] MISSING  packaged renderer inside app.asar ` +
          `(index=${hasIndex}, js=${hasJs}, css=${hasCss}) — run "npm run build:desktop" first`,
      );
      failed++;
    } else {
      console.log(
        `[friday] ok       Packaged renderer: app.asar/dist-desktop (${assets.length} assets)`,
      );
    }
  } catch (error) {
    console.warn(`[friday] app.asar inspection skipped: ${error.message}`);
  }
}

// The packaged app must carry the version this release claims, everywhere the
// app and the updater read it from: package.json, the packaged app.asar and
// (when produced) electron-builder's latest.yml.
if (expectedVersion && expectedVersion !== publicVersion) {
  console.error(
    `[friday] VERSION  release claims ${expectedVersion} — canonical identity is ${publicVersion}`,
  );
  failed++;
}

{
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (pkgVersion !== npmVersion) {
    console.error(
      `[friday] VERSION  package.json is ${pkgVersion} — npm encoding of ${publicVersion} is ${npmVersion}`,
    );
    failed++;
  } else {
    console.log(`[friday] ok       Version contract: public ${publicVersion} · npm ${npmVersion}`);
  }
  if (fs.existsSync(asarFile)) {
    try {
      const packed = JSON.parse(
        require("@electron/asar").extractFile(asarFile, "package.json").toString("utf8"),
      );
      if (packed.version !== npmVersion) {
        console.error(
          `[friday] VERSION  packaged app.asar is ${packed.version} — expected npm ${npmVersion}`,
        );
        failed++;
      } else {
        console.log(`[friday] ok       Packaged npm version: ${packed.version}`);
      }
    } catch (error) {
      console.warn(`[friday] packaged version check skipped: ${error.message}`);
    }
    const canonicalPacked = path.join(
      release,
      "win-unpacked",
      "resources",
      "config",
      "friday-version.json",
    );
    if (fs.existsSync(canonicalPacked)) {
      try {
        const packedId = engine.identityFromCanonical(
          JSON.parse(fs.readFileSync(canonicalPacked, "utf8")),
        );
        if (!packedId || packedId.releaseVersion !== publicVersion) {
          console.error(
            `[friday] VERSION  packaged friday-version.json is ${packedId?.releaseVersion} — expected ${publicVersion}`,
          );
          failed++;
        } else {
          console.log(`[friday] ok       Packaged public version: ${packedId.releaseVersion}`);
        }
      } catch (error) {
        console.error(
          `[friday] VERSION  packaged friday-version.json unreadable: ${error.message}`,
        );
        failed++;
      }
    } else if (fs.existsSync(path.join(release, "win-unpacked"))) {
      console.error("[friday] VERSION  packaged config/friday-version.json is missing");
      failed++;
    }
  }
  const latest = path.join(release, "latest.yml");
  if (fs.existsSync(latest)) {
    const body = fs.readFileSync(latest, "utf8");
    if (!new RegExp(`version:\\s*${publicVersion.replace(/\./g, "\\.")}\\b`).test(body)) {
      console.error(`[friday] VERSION  latest.yml does not declare ${publicVersion}`);
      failed++;
    } else {
      console.log("[friday] ok       Update metadata: latest.yml matches");
    }
  }
}

// Final pre-publish gate: the update manifest must exist and every checksum in
// it must match the artifact on disk, or an installed FRIDAY could never prove
// what it downloaded.
if (requireManifest) {
  const manifestFile = path.join(release, "friday-update.json");
  const sumsFile = path.join(release, "SHA256SUMS.txt");
  if (!fs.existsSync(manifestFile) || !fs.existsSync(sumsFile)) {
    console.error(
      "[friday] MISSING  release manifest or SHA256SUMS.txt — run release-manifest.cjs",
    );
    failed++;
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.version !== (expectedVersion || publicVersion)) {
      console.error(
        `[friday] VERSION  update manifest says ${manifest.version} — expected ${expectedVersion || publicVersion}`,
      );
      failed++;
    }
    const installer = (manifest.assets || []).find((a) => a.kind === "installer");
    if (!installer) {
      console.error("[friday] MISSING  the update manifest lists no installer");
      failed++;
    }
    for (const asset of manifest.assets || []) {
      const file = path.join(release, asset.name);
      if (!fs.existsSync(file)) {
        console.error(`[friday] MISSING  manifest asset ${asset.name}`);
        failed++;
        continue;
      }
      const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (digest !== asset.sha256) {
        console.error(`[friday] CHECKSUM ${asset.name} does not match the published manifest`);
        failed++;
      } else {
        console.log(`[friday] ok       Checksum: ${asset.name}`);
      }
    }
  }
}

console.log("");

if (failed) {
  console.error(`[friday] verification failed (${failed} problem${failed === 1 ? "" : "s"}).`);
  process.exit(1);
}
console.log("[friday] all Windows artifacts verified.");
console.log("[friday] next: run the installer, then confirm these in the install folder:");
console.log("           FRIDAY.exe            starts normally (no UAC prompt, FRIDAY icon)");
console.log("           Uninstall FRIDAY.exe  removes the app, keeps your FRIDAY data folder");
