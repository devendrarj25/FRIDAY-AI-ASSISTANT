/**
 * FRIDAY · build channel (production vs test build)
 *
 * ONE place that answers "is this EXE the production FRIDAY, or a TEST build
 * (portable EXE or the separate 'FRIDAY Test' installation) of a branch?".
 *
 * A test build is a FULL build of the selected branch. It is not part of the
 * official release line, and it is replaced simply by running the next test
 * EXE. What it must never do is disturb the production installation:
 *
 *   * mutable state (config, database, credentials, logs, conversations,
 *     memory, workspace) is isolated through the "test" path profile, so it
 *     lands in <FRIDAY_ROOT>/profiles/test/… and production data is untouched;
 *   * large immutable resources (models, voices, Python runtime, caches,
 *     assets) are SHARED from the same FRIDAY_ROOT — a test build never
 *     re-downloads or duplicates gigabytes;
 *   * AUTOMATIC updating is disabled: a test EXE never polls for, offers or
 *     applies an update on its own. The owner may still explicitly check and
 *     install a newer TEST build or cross back to Stable — checked,
 *     checksum-verified, backed up and confirmed like any other update;
 *   * creating or publishing a release is disabled: a test EXE can neither cut
 *     a version nor dispatch the release workflow.
 *
 * Detection order (first match wins):
 *   1. FRIDAY_BUILD_CHANNEL / FRIDAY_TEST_BUILD environment variable
 *   2. build-channel.json shipped beside the app (written by test-build.yml)
 *   3. production
 */

const fs = require("node:fs");
const path = require("node:path");

const TEST_PROFILE = "test";

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Marker locations: packaged resources first, then the development checkout. */
function markerFiles({ resourcesPath, appPath } = {}) {
  const files = [];
  if (resourcesPath) {
    files.push(path.join(resourcesPath, "build-channel.json"));
    files.push(path.join(resourcesPath, "resources", "build-channel.json"));
  }
  if (appPath) files.push(path.join(appPath, "resources", "build-channel.json"));
  files.push(path.join(__dirname, "..", "resources", "build-channel.json"));
  return files;
}

function fromEnv(env = process.env) {
  const raw = String(env.FRIDAY_BUILD_CHANNEL || "")
    .trim()
    .toLowerCase();
  if (raw === "test" || raw === "production") return { channel: raw, source: "env" };
  if (String(env.FRIDAY_TEST_BUILD || "") === "1") return { channel: "test", source: "env" };
  return null;
}

function fromMarker(options) {
  for (const file of markerFiles(options)) {
    const data = readJson(file);
    if (!data) continue;
    const channel = String(data.channel || "")
      .trim()
      .toLowerCase();
    if (channel !== "test" && channel !== "production") continue;
    return {
      channel,
      source: file,
      ref: data.ref ? String(data.ref) : null,
      commit: data.commit ? String(data.commit) : null,
      runId: data.runId ? String(data.runId) : null,
      builtAt: data.builtAt ? String(data.builtAt) : null,
    };
  }
  return null;
}

/**
 * Resolve the channel. Pure: pass what is known about the running app so the
 * same function can be unit-tested without Electron.
 */
function detect({ env = process.env, resourcesPath = null, appPath = null } = {}) {
  const hit = fromEnv(env) ||
    fromMarker({ resourcesPath, appPath }) || {
      channel: "production",
      source: "default",
    };
  const test = hit.channel === "test";
  return {
    channel: hit.channel,
    isTest: test,
    source: hit.source,
    ref: hit.ref || null,
    commit: hit.commit || null,
    runId: hit.runId || null,
    builtAt: hit.builtAt || null,
    // Mutable state lives under this profile; friday-paths keeps the large
    // immutable resources shared with production.
    profile: test ? TEST_PROFILE : "production",
    // A TEST build may EXPLICITLY install a newer TEST build or cross back to
    // Stable — checked, checksum-verified, backed up and confirmed like any
    // other update. Only the AUTOMATIC flow (background polling, silent
    // download/apply) and creating/publishing a release are closed to it.
    allowsUpdates: true,
    allowsAutoUpdates: !test,
    allowsRelease: !test,
    label: test ? "Test build (manual updates only)" : "Production",
  };
}

let current = null;

/**
 * Resolve once and apply the path profile. Must run BEFORE anything reads a
 * FRIDAY path, so the very first write already lands in the right place.
 */
function init({ app = null, paths = require("./friday-paths.cjs"), env = process.env } = {}) {
  current = detect({
    env,
    resourcesPath: process.resourcesPath || null,
    appPath: (() => {
      try {
        return app?.getAppPath?.() || null;
      } catch {
        return null;
      }
    })(),
  });
  paths.setProfile(current.profile);
  return current;
}

const info = () => current || detect({});
const isTest = () => info().isTest;

/**
 * Uniform refusal for the actions a test build must not perform: automatic
 * updating and creating/publishing a release. Explicit, confirmed update
 * checks and installs are NOT routed through here.
 */
function blocked(action) {
  const state = info();
  return {
    ok: false,
    testBuild: true,
    channel: state.channel,
    error:
      `This is a FRIDAY TEST build (${state.ref || "branch build"}). ` +
      `${action} is disabled here — explicit update checks and installs still work; ` +
      `use the production FRIDAY for the stable release flow.`,
  };
}

module.exports = { TEST_PROFILE, detect, init, info, isTest, blocked, markerFiles };
