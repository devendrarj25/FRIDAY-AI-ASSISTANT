// FRIDAY · tools/automation/file-organizer
//
// Real implementation: it delegates to the existing built-in `file.organise`
// skill in electron/skills.cjs so there is exactly one organiser in the app.
const path = require("node:path");

const skills = require(path.join(__dirname, "..", "..", "..", "electron", "skills.cjs"));
// The canonical FRIDAY root contract; there is no working-directory fallback.
const contract = require(path.join(__dirname, "..", "..", "..", "electron", "friday-contract.cjs"));

async function run({ folder, dryRun = true, root = contract.rootFromEnv() } = {}) {
  if (!folder) return { ok: false, error: "A folder path is required." };
  if (!root)
    return {
      ok: false,
      error: "No FRIDAY folder is selected — choose the FRIDAY folder before organising files.",
    };
  const result = await skills.invoke(root, "file.organise", {
    folder,
    dryRun: Boolean(dryRun),
  });
  return {
    ok: Boolean(result.ok),
    dryRun: Boolean(dryRun),
    folder,
    ...(result.value || {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

module.exports = { run };
