/**
 * FRIDAY · shipped config files in the owner's config folder.
 *
 * The build ships defaults (kernel.yaml, models.yaml). They are copied into
 * <root>/config once so the owner can edit their own copy. A copy that never
 * changes would also never receive what a newer version adds, so each start:
 *
 *   - missing                     → copied
 *   - same as the shipped file     → nothing to do
 *   - untouched since FRIDAY wrote it, shipped file newer
 *                                 → replaced (the old copy is kept as .bak)
 *   - edited by the owner (or unknown history), shipped file newer
 *                                 → the owner's file is left exactly as it is
 *                                   and the shipped one is saved beside it as
 *                                   <name>.new to compare or adopt
 *
 * What FRIDAY last wrote is remembered by hash in .seed-state.json. Nothing
 * here ever overwrites a file the owner changed, and it never throws.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE = ".seed-state.json";
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readState(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, STATE), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Returns [{ name, action }] with action copied | current | updated | kept. */
function syncSeedConfig({ dir, names, resolve }) {
  const results = [];
  if (!dir) return results;
  const state = readState(dir);
  let dirty = false;
  for (const name of names) {
    try {
      const shipped = resolve(name);
      if (!shipped || !fs.existsSync(shipped)) continue;
      const target = path.join(dir, name);
      const shippedHash = hash(shipped);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(shipped, target);
        state[name] = shippedHash;
        dirty = true;
        results.push({ name, action: "copied" });
        continue;
      }
      const ownHash = hash(target);
      if (ownHash === shippedHash) {
        if (state[name] !== shippedHash) {
          state[name] = shippedHash;
          dirty = true;
        }
        fs.rmSync(`${target}.new`, { force: true });
        results.push({ name, action: "current" });
        continue;
      }
      if (state[name] && ownHash === state[name]) {
        fs.copyFileSync(target, `${target}.bak`);
        fs.copyFileSync(shipped, target);
        state[name] = shippedHash;
        dirty = true;
        results.push({ name, action: "updated" });
        continue;
      }
      // The owner's copy differs from anything FRIDAY wrote: keep it, offer the new one.
      fs.copyFileSync(shipped, `${target}.new`);
      results.push({ name, action: "kept" });
    } catch {
      /* one file never blocks the others or the start-up */
    }
  }
  if (dirty) {
    try {
      fs.writeFileSync(path.join(dir, STATE), JSON.stringify(state, null, 2));
    } catch {
      /* next start tries again */
    }
  }
  return results;
}

module.exports = { syncSeedConfig, STATE };
