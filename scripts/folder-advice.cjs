/**
 * Where the FRIDAY folder sits matters on Windows. A folder a sync client watches (OneDrive, Dropbox, Google Drive)
 * is scanned and locked while the Python environment and the models are written into it, which shows up as random
 * "file in use" and slow installs; Program Files and the Windows folder need administrator rights for every write,
 * which breaks FRIDAY's own repair. This only reports; it never moves anything.
 */
const SYNCED = [
  { name: "OneDrive", test: /[\\/]onedrive(?: - [^\\/]*| for business)?[\\/]/i },
  { name: "Dropbox", test: /[\\/]dropbox(?: \([^)\\/]*\))?[\\/]/i },
  { name: "Google Drive", test: /[\\/]google ?drive[\\/]|^[a-z]:[\\/]my drive[\\/]/i },
  { name: "iCloud Drive", test: /[\\/]icloud ?drive[\\/]/i },
];
const PROTECTED = [
  { name: "Program Files", test: /^[a-z]:[\\/]program files(?: \(x86\))?[\\/]/i },
  { name: "the Windows folder", test: /^[a-z]:[\\/]windows[\\/]/i },
];

/** @returns {{ ok: boolean, note: string, fix: string }} */
function assess(root) {
  const text = `${String(root || "").replace(/[\\/]+$/, "")}\\`;
  const blocked = PROTECTED.find((rule) => rule.test.test(text));
  if (blocked) {
    return {
      ok: false,
      note: `the FRIDAY folder is inside ${blocked.name}, which needs administrator rights for every write`,
      fix: "Use a normal folder such as C:\\FRIDAY (set FRIDAY_WORKSPACE_ROOT, or run setup from a clone outside Program Files).",
    };
  }
  const synced = SYNCED.find((rule) => rule.test.test(text));
  if (synced) {
    return {
      ok: false,
      note: `the FRIDAY folder is inside ${synced.name}, whose sync client scans and locks files while packages and models are written`,
      fix: `Keep the FRIDAY folder outside ${synced.name} (for example C:\\FRIDAY), or pause syncing while setup runs.`,
    };
  }
  return { ok: true, note: "a plain local folder", fix: "" };
}

module.exports = { assess };
