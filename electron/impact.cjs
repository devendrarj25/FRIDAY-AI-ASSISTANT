// FRIDAY · impact engine.
//
// Given the architecture index and the files that changed, work out what is
// actually affected and how far FRIDAY has to go to adopt the change:
//
//   hot-reload  → workspace content only (modules, plugins, agents, skills,
//                 workflows, brain data, themes, docs)
//   restart     → runtime code the running process already loaded
//                 (electron/*, kernel/*, config/*)
//   rebuild     → anything reachable from a packaged entry point, renderer
//                 sources, dependencies or the builder configuration
//   blocked     → the change references something that does not resolve, so
//                 applying it would break the running install
const { extractEdges } = require("./architecture-index.cjs");

const LADDER = ["hot-reload", "restart", "rebuild", "blocked"];
const worst = (a, b) => (LADDER.indexOf(b) > LADDER.indexOf(a) ? b : a);

// Areas whose files are read at runtime from the workspace folder.
const HOT_AREAS = new Set([
  "modules",
  "plugins",
  "agents",
  "skills",
  "workflows",
  "resources",
  "brain",
  "docs",
]);
// Areas loaded once when the process starts.
const RESTART_AREAS = new Set(["config", "kernel"]);
// Areas compiled into the packaged application.
const REBUILD_AREAS = new Set(["renderer", "core"]);

const REBUILD_FILES = new Set([
  "package.json",
  "package-lock.json",
  "electron-builder.yml",
  "vite.config.ts",
  "vite.electron.config.ts",
  "tsconfig.json",
]);

/** Every file that transitively imports one of `seeds`. */
function dependents(index, seeds, limit = 400) {
  const reverse = index.reverse || {};
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length && seen.size < limit) {
    const current = queue.shift();
    for (const parent of reverse[current] || []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  return [...seen];
}

function verdictFor(rel, area) {
  if (REBUILD_FILES.has(rel)) return "rebuild";
  if (REBUILD_AREAS.has(area)) return "rebuild";
  if (RESTART_AREAS.has(area)) return "restart";
  if (area === "shell") return rel.startsWith("electron/") ? "restart" : "rebuild";
  if (HOT_AREAS.has(area)) return "hot-reload";
  return "restart";
}

/**
 * Assess a batch of changes.
 * @param {{ index: object, changes: {path:string,state:string,area:string}[], root: string }} input
 */
function assess({ index, changes, root }) {
  const files = [];
  const reasons = [];
  const blockers = [];
  let verdict = "hot-reload";

  const names = new Set(Object.keys(index?.files || {}));
  const seeds = [];

  for (const change of changes) {
    const rel = String(change.path || "").replace(/\\/g, "/");
    if (!rel) continue;
    const area = change.area || index?.files?.[rel]?.area || "other";
    const own = verdictFor(rel, area);
    verdict = worst(verdict, own);
    files.push({ path: rel, state: change.state || "changed", area, verdict: own });
    seeds.push(rel);

    if (change.state !== "deleted" && root) {
      const { missing } = extractEdges(rel, names, root);
      for (const spec of missing) {
        blockers.push({ file: rel, reason: `unresolved import "${spec}"` });
      }
    }
  }

  const affected = dependents(index || {}, seeds);
  for (const dep of affected) {
    const area = index?.files?.[dep]?.area || "other";
    verdict = worst(verdict, verdictFor(dep, area));
  }

  const entryHit = (index?.entryPoints || []).filter(
    (entry) => seeds.includes(entry) || affected.includes(entry),
  );
  for (const entry of entryHit) {
    // An entry point escalates only as far as its own kind demands: touching
    // the kernel entry needs a restart, touching a packaged entry needs a
    // rebuild. Reporting it as "rebuild" either way would be dishonest.
    verdict = worst(verdict, verdictFor(entry, index?.files?.[entry]?.area || "other"));
  }
  if (entryHit.length) reasons.push(`entry point affected: ${entryHit.join(", ")}`);
  if (affected.length) reasons.push(`${affected.length} dependent file(s) import the change`);
  if (blockers.length) verdict = "blocked";

  const areas = [...new Set(files.map((f) => f.area))];
  return {
    at: Date.now(),
    verdict,
    areas,
    files,
    dependents: affected.slice(0, 120),
    dependentCount: affected.length,
    entryPoints: entryHit,
    blockers,
    reasons,
    summary:
      verdict === "blocked"
        ? `Blocked — ${blockers.length} unresolved reference(s)`
        : `${files.length} change(s) in ${areas.join(", ") || "workspace"} → ${verdict}`,
  };
}

module.exports = {
  assess,
  dependents,
  verdictFor,
  LADDER,
  HOT_AREAS,
  RESTART_AREAS,
  REBUILD_AREAS,
};
