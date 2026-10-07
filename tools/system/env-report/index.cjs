// FRIDAY · tools/system/env-report
//
// node:os userInfo/homedir/tmpdir — not process.env dump.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const os = require("node:os");

async function run() {
  let user = null;
  try {
    user = os.userInfo();
  } catch (error) {
    user = { error: String(error.message || error) };
  }
  return {
    ok: true,
    user:
      user && user.username
        ? { username: user.username, homedir: user.homedir, shell: user.shell || null }
        : user,
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    locale: Intl.DateTimeFormat().resolvedOptions(),
    pathEntries: String(process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean).length,
  };
}

module.exports = { run };
