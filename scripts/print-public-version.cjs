/**
 * Print the public FRIDAY version from config/friday-version.json.
 * npm's own banner uses package.json, which must stay a three-part SemVer
 * encoding. This line is the version the product actually ships.
 */
const { readCanonicalIdentity } = require("./release-engine.cjs");

const identity = readCanonicalIdentity();
if (!identity?.releaseVersion) {
  console.error("FRIDAY version is not set. Publishing and typecheck stopped.");
  process.exit(1);
}
process.stdout.write(`FRIDAY ${identity.releaseVersion}\n`);
