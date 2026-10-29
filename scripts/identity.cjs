/**
 * FRIDAY · one identity, everywhere.
 *
 * Every place that stamps a name on a build — the Windows executable resources,
 * the release manifest, the build verifier and the documentation checks — reads
 * these constants instead of repeating string literals. Changing the owner or
 * the product name is therefore a one-line change that the identity contract
 * test immediately validates across the whole pipeline.
 *
 * PRODUCT is the Windows/product/executable name ("FRIDAY") and must stay in
 * sync with package.json `productName`, electron-builder `productName` and the
 * FRIDAY-Setup / FRIDAY-Portable artifact names. APP is the human display name
 * used in documentation, About screens and release metadata.
 */

const fs = require("node:fs");
const path = require("node:path");

const APP = "FRIDAY AI";
const PRODUCT = "FRIDAY";
const OWNER = "Devendra Singh Meena";
const GITHUB = "devendrarj25";
const REPOSITORY = `https://github.com/${GITHUB}/FRIDAY-AI-ASSISTANT`;
const PUBLISHER = `${OWNER} (${GITHUB})`;
const MADE_BY = `Made by ${PUBLISHER}`;
const COPYRIGHT = `Copyright © 2026 ${PUBLISHER}`;
const DESCRIPTION = "FRIDAY - Personal AI Assistant";
const EXECUTABLE = "FRIDAY.exe";
/** The Windows product name of a TEST build (a separate identity on purpose). */
const TEST_PRODUCT = "FRIDAY Test";

/**
 * Every shippable package. Windows CMD verifies the EXE resources.
 * The same stamp is checked here for the other package kinds.
 */
const PACKAGE_KINDS = ["npm", "nsis", "portable", "unpacked", "source-zip", "update-manifest"];

const CONTACT_KEY =
  /^(e-?mail|phone|mobile|telephone|tel|address|street|streetaddress|postal|postcode|zipcode)$/i;

function contactKeyPaths(value, prefix = "") {
  const found = [];
  if (!value || typeof value !== "object") return found;
  for (const key of Object.keys(value)) {
    const here = prefix ? `${prefix}.${key}` : key;
    if (CONTACT_KEY.test(key)) found.push(here);
    found.push(...contactKeyPaths(value[key], here));
  }
  return found;
}

/** String table rcedit writes onto the unpacked FRIDAY.exe. */
function windowsResourceStamp({ productName, fileVersion, productVersion }) {
  return {
    CompanyName: PUBLISHER,
    FileDescription: DESCRIPTION,
    LegalCopyright: COPYRIGHT,
    LegalTrademarks: DESCRIPTION,
    ProductName: productName,
    InternalName: productName,
    OriginalFilename: EXECUTABLE,
    FileVersion: fileVersion,
    ProductVersion: productVersion,
  };
}

/** Identity block for the source zip and its side manifest. */
function archiveStamp({ version, builtAt } = {}) {
  return {
    product: PRODUCT,
    owner: OWNER,
    github: GITHUB,
    publisher: PUBLISHER,
    repository: REPOSITORY,
    version: String(version || ""),
    builtAt: builtAt || null,
  };
}

/** Fields every friday-update.json carries, ahead of version and assets. */
function updateManifestIdentity() {
  return {
    product: PRODUCT,
    app: APP,
    owner: OWNER,
    github: GITHUB,
    publisher: PUBLISHER,
    repository: REPOSITORY,
  };
}

function readText(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/**
 * Prove each package kind carries the project id (owner + GitHub username)
 * and does not carry an email, a phone number, or a street address.
 * This does not open a built EXE. The Windows resource read stays in
 * verify-build.cjs and runs only on a Windows host that has the EXE.
 */
function auditPackageIdentity(root) {
  const problems = [];
  const pkg = JSON.parse(readText(root, "package.json"));
  if (pkg.productName !== PRODUCT) problems.push("npm: productName");
  if (pkg.author?.name !== OWNER) problems.push("npm: author name");
  const authorUrl = String(pkg.author?.url || "");
  if (!authorUrl.includes(`github.com/${GITHUB}`)) problems.push("npm: github username");
  if (pkg.homepage !== REPOSITORY) problems.push("npm: homepage");
  if (pkg.repository?.url !== `${REPOSITORY}.git`) problems.push("npm: repository");
  for (const key of contactKeyPaths(pkg.author || {}, "author")) {
    problems.push(`npm: ${key}`);
  }
  for (const key of ["email", "phone", "address"]) {
    if (Object.prototype.hasOwnProperty.call(pkg, key)) problems.push(`npm: ${key}`);
  }

  const builder = readText(root, "electron-builder.yml");
  if (!builder.includes(`copyright: ${COPYRIGHT}`)) problems.push("nsis: copyright");
  if (!builder.includes(`publisherName: ${PUBLISHER}`)) problems.push("nsis: publisher");
  if (!builder.includes(`productName: ${PRODUCT}\n`)) problems.push("nsis: product");
  if (!builder.includes("artifactName: FRIDAY-Setup-")) problems.push("nsis: setup name");
  if (!builder.includes(`shortcutName: ${PRODUCT}`)) problems.push("nsis: shortcut");
  if (!builder.includes("artifactName: FRIDAY-Portable-")) problems.push("portable: artifact");
  if (/@gmail\.com|mailto:/i.test(builder)) problems.push("nsis: email");

  const brand = readText(root, "scripts/brand-windows.cjs");
  if (!brand.includes("windowsResourceStamp")) problems.push("unpacked: stamp");
  if (brand.includes(`"${PUBLISHER}"`)) problems.push("unpacked: retyped publisher");
  const unpacked = windowsResourceStamp({
    productName: PRODUCT,
    fileVersion: "0.0.0.0",
    productVersion: "0.0.0.0",
  });
  if (unpacked.CompanyName !== PUBLISHER) problems.push("unpacked: publisher");
  if (unpacked.ProductName !== PRODUCT) problems.push("unpacked: product");
  if (unpacked.OriginalFilename !== EXECUTABLE) problems.push("unpacked: executable");
  if (!unpacked.CompanyName.includes(GITHUB)) problems.push("unpacked: github username");
  if (contactKeyPaths(unpacked).length) problems.push("unpacked: contact");

  const cli = readText(root, "builder/cli.mjs");
  if (!cli.includes("archiveStamp")) problems.push("source-zip: stamp");
  const zip = archiveStamp({ version: "0.0.0.0", builtAt: "1970-01-01T00:00:00.000Z" });
  if (zip.github !== GITHUB || zip.owner !== OWNER || zip.publisher !== PUBLISHER) {
    problems.push("source-zip: identity");
  }
  if (contactKeyPaths(zip).length) problems.push("source-zip: contact");

  const manifestSrc = readText(root, "scripts/release-manifest.cjs");
  if (!manifestSrc.includes("updateManifestIdentity")) problems.push("update-manifest: stamp");
  const update = updateManifestIdentity();
  if (update.github !== GITHUB || update.publisher !== PUBLISHER || update.product !== PRODUCT) {
    problems.push("update-manifest: identity");
  }
  if (contactKeyPaths(update).length) problems.push("update-manifest: contact");

  const license = readText(root, "LICENSE");
  if (!license.includes(OWNER) || !license.includes(`"${GITHUB}"`)) problems.push("license: owner");
  if (/@gmail\.com|mailto:/i.test(license)) problems.push("license: email");

  return { ok: problems.length === 0, problems, kinds: PACKAGE_KINDS.slice() };
}

module.exports = {
  APP,
  PRODUCT,
  OWNER,
  GITHUB,
  REPOSITORY,
  PUBLISHER,
  MADE_BY,
  COPYRIGHT,
  DESCRIPTION,
  EXECUTABLE,
  TEST_PRODUCT,
  PACKAGE_KINDS,
  contactKeyPaths,
  windowsResourceStamp,
  archiveStamp,
  updateManifestIdentity,
  auditPackageIdentity,
};
