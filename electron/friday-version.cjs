/**
 * FRIDAY · runtime product version.
 *
 * Canonical identity lives in config/friday-version.json (extraResources when
 * packaged). package.json `version` is the npm/electron-builder SemVer encoding
 * and must not be shown to the owner when it differs from the public version.
 *
 * Never falls back to 0.0.0. If the canonical file cannot be read, this module
 * throws so a release cannot silently advertise the wrong number.
 */
const fs = require("node:fs");
const path = require("node:path");
const engine = require(path.resolve(__dirname, "..", "scripts", "release-engine.cjs"));

function packagedCanonical() {
  try {
    const resources = process.resourcesPath;
    if (!resources) return null;
    const file = path.join(resources, "config", "friday-version.json");
    if (!fs.existsSync(file)) return null;
    return engine.identityFromCanonical(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function identity() {
  const packaged = packagedCanonical();
  if (packaged) return packaged;
  const fromRepo = engine.readCanonicalIdentity();
  if (fromRepo) return fromRepo;
  throw new Error(
    "ERROR: Unable to resolve canonical FRIDAY version (config/friday-version.json).",
  );
}

function displayVersion() {
  return identity().releaseVersion;
}

function npmVersion() {
  return identity().npmVersion;
}

module.exports = {
  identity,
  displayVersion,
  npmVersion,
};
