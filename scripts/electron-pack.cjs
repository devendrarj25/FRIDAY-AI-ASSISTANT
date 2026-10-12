#!/usr/bin/env node
/**
 * FRIDAY · electron-builder wrapper.
 *
 * electron-builder reads package.json SemVer (npm encoding). Artifact names,
 * Windows FILEVERSION (via buildVersion / shortVersion) and the portable/setup filenames must
 * use the public four-part FRIDAY version from config/friday-version.json.
 *
 *   node scripts/electron-pack.cjs --win nsis portable
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const engine = require("./release-engine.cjs");

const ROOT = path.resolve(__dirname, "..");

/**
 * electron-builder 26 treats a CI run that is not a pull request as
 * `onTagOrDraft` and then requires GH_TOKEN. PR Validation's pack job has no
 * token. Official assets are uploaded later by `gh release create`.
 * An explicit `--publish` on the command line is left as the caller wrote it.
 */
function packPublishArgs(extra) {
  const args = Array.isArray(extra) ? extra : [];
  const listed = args.some(
    (arg) => arg === "--publish" || arg === "-p" || String(arg).startsWith("--publish="),
  );
  return listed ? args.slice() : ["--publish", "never", ...args];
}

function main() {
  const identity = engine.readCanonicalIdentity({ root: ROOT });
  if (!identity) {
    console.error("ERROR: Unable to resolve canonical FRIDAY version. Packaging stopped.");
    process.exit(1);
  }
  if (
    identity.releaseVersion.replace(/-.*$/, "") === "0.0.0" ||
    identity.releaseVersion.startsWith("0.0.0")
  ) {
    console.error("ERROR: refusing to package FRIDAY 0.0.0.");
    process.exit(1);
  }
  if (!identity.fourPart) {
    console.error(
      "ERROR: refusing to package a three-part identity. config/friday-version.json is required so CMD/CI never name artifacts from the npm encoding (1.0.0) as if they were public 1.0.0.0.",
    );
    process.exit(1);
  }

  const extra = packPublishArgs(process.argv.slice(2));
  const args = [
    path.join(ROOT, "node_modules", "electron-builder", "cli.js"),
    "--config",
    path.join(ROOT, "electron-builder.yml"),
    ...engine.electronBuilderArgs(identity),
    ...extra,
  ];

  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  const status = result.status === null ? 1 : result.status;
  if (status === 0) {
    // electron-builder's latest.yml uses the npm encoding. Rewrite it to the
    // public four-part identity before verify-build / checksums run.
    engine.syncLatestYml(identity, { root: ROOT });
  }
  process.exit(status);
}

module.exports = { packPublishArgs };

if (require.main === module) main();
