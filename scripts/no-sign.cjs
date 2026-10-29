/**
 * FRIDAY — custom signing hook for electron-builder.
 *
 * Why this exists:
 * electron-builder's built-in Windows signing step downloads and unpacks the
 * "winCodeSign" toolchain, which contains macOS symlinks (libcrypto.dylib,
 * libssl.dylib). On Windows without Developer Mode / admin rights 7-Zip cannot
 * create those symlinks and the build dies with:
 *
 *   ERROR: Cannot create symbolic link : A required privilege is not held by
 *   the client. : ...winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
 *
 * Providing a custom `win.sign` hook makes electron-builder skip that download
 * entirely. The exe is still built, icon-stamped and branded (rcedit runs
 * separately). Signing is done afterwards with `npm run sign:win`, which uses
 * the Windows SDK signtool directly and never touches that cache.
 *
 * If a real certificate is configured (CSC_LINK / CSC_KEY_PASSWORD), this hook
 * signs inline with signtool so packaged builds come out signed.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function findSignTool() {
  const roots = [
    path.join(
      process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
      "Windows Kits",
      "10",
      "bin",
    ),
    path.join(process.env["ProgramFiles"] || "C:/Program Files", "Windows Kits", "10", "bin"),
  ];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      const exe = path.join(root, version, "x64", "signtool.exe");
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  return found.sort().pop();
}

exports.default = async function sign(configuration) {
  const pfx = process.env.CSC_LINK || process.env.WIN_CSC_LINK;
  const target = configuration.path;

  if (!pfx) {
    console.log(
      `[friday] skipping inline signing for ${path.basename(target)} (run "npm run sign:win" afterwards)`,
    );
    return;
  }

  const signtool = findSignTool();
  if (!signtool) {
    console.warn(
      "[friday] CSC_LINK set but signtool.exe was not found — install the Windows 10/11 SDK. Skipping.",
    );
    return;
  }

  const args = [
    "sign",
    "/f",
    pfx,
    ...(process.env.CSC_KEY_PASSWORD ? ["/p", process.env.CSC_KEY_PASSWORD] : []),
    "/fd",
    "SHA256",
    "/tr",
    "http://timestamp.digicert.com",
    "/td",
    "SHA256",
    target,
  ];
  console.log(`[friday] signing ${path.basename(target)}`);
  execFileSync(signtool, args, { stdio: "inherit" });
};
