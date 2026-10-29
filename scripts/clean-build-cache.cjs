/**
 * FRIDAY — clean every build cache and output folder.
 *
 * Run when a build fails half-way, especially after the winCodeSign
 * "Cannot create symbolic link" error, which leaves a corrupt cache behind.
 *
 *   npm run clean:cache
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const targets = [
  path.join(root, "release"),
  path.join(root, "dist-desktop"),
  path.join(root, ".cache", "electron-builder"),
  path.join(root, "node_modules", ".cache"),
];

if (process.platform === "win32") {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  targets.push(path.join(local, "electron-builder", "Cache", "winCodeSign"));
}

for (const target of targets) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`removed ${target}`);
    }
  } catch (error) {
    console.warn(`could not remove ${target}: ${error.message}`);
  }
}

console.log("FRIDAY build caches cleaned. Next: npm run build:win");
