// FRIDAY · source push (explicit only).
//
// GitHub is FRIDAY's private MASTER SOURCE. Pushing source is development, not
// release: a push NEVER builds an EXE, never changes the version, never creates
// a GitHub Release and never touches the installed app — only
// .github/workflows/release.yml can do that, and only on workflow_dispatch.
//
// FRIDAY does not push on her own. `pushSource` runs exactly once per explicit
// request from the owner (Settings → Updates → Push source), using the same
// encrypted token as the rest of the GitHub system.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const sync = require("./github-sync.cjs");

const PROTECTED_BRANCHES = new Set(["main", "master", "release", "gh-pages"]);

function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.has(
    String(branch || "")
      .trim()
      .toLowerCase(),
  );
}

/** Run a git command in `cwd` and capture its output (never the token). */
function git(args, cwd, env = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      });
    } catch (error) {
      resolve({ ok: false, code: -1, out: String(error.message || error) });
      return;
    }
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", (error) => resolve({ ok: false, code: -1, out: String(error.message) }));
    child.on("close", (code) => resolve({ ok: code === 0, code, out: out.trim() }));
  });
}

const isRepo = (dir) => fs.existsSync(path.join(dir, ".git"));

/** What would be pushed right now — reviewed before anything leaves the PC. */
async function sourceStatus(root, sourceDir) {
  const dir = sourceDir || root;
  if (!dir || !isRepo(dir)) {
    return { ok: true, repo: false, message: "This FRIDAY copy has no git source checkout." };
  }
  const cfg = sync.readConfig(root);
  const status = await git(["status", "--porcelain"], dir);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  const ahead = await git(["rev-list", "--count", "@{u}..HEAD"], dir);
  const changes = (status.out || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ state: l.slice(0, 2).trim(), path: l.slice(3) }));
  return {
    ok: true,
    repo: true,
    branch: branch.ok ? branch.out : cfg.branch || "main",
    changes,
    dirty: changes.length,
    ahead: Number(ahead.out) || 0,
    autoPush: Boolean(cfg.autoPush), // false by default, and never used to push by itself
  };
}

/**
 * Commit and push the source. Explicit action only:
 *   • requires a connected repo and the stored token
 *   • refuses when there is nothing to send
 *   • pushes source only — no tag, no version change, no release
 */
async function pushSource(root, { message, sourceDir, confirm } = {}) {
  if (confirm !== true) {
    return { ok: false, error: "A source push must be confirmed by the owner." };
  }
  const dir = sourceDir || root;
  if (!dir || !isRepo(dir)) {
    return { ok: false, error: "This FRIDAY copy has no git source checkout to push." };
  }
  const cfg = sync.readConfig(root);
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };
  if (!cfg.token) return { ok: false, error: "A GitHub token is required to push source." };

  const branch = cfg.branch || "main";
  const status = await sourceStatus(root, dir);
  if (isProtectedBranch(branch)) {
    return {
      ok: false,
      protectedBranch: true,
      error: `Source push to '${branch}' is blocked. Select or create a non-main feature, fix or upgrade branch, then open a Pull Request into main.`,
    };
  }
  if (!status.branch || status.branch === "HEAD" || status.branch !== branch) {
    return {
      ok: false,
      branchMismatch: true,
      error: `The checked-out branch '${status.branch || "unknown"}' does not match the configured development branch '${branch}'. Select or create that branch explicitly; FRIDAY will not create or switch branches silently.`,
    };
  }
  if (!status.dirty && !status.ahead) {
    return { ok: true, pushed: false, message: "Nothing to push — the source is already in sync." };
  }

  if (status.dirty) {
    const add = await git(["add", "-A"], dir);
    if (!add.ok) return { ok: false, error: `git add failed: ${add.out}` };
    const commit = await git(
      ["commit", "-m", String(message || "friday: source update").slice(0, 200)],
      dir,
    );
    if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
      return { ok: false, error: `git commit failed: ${commit.out}` };
    }
  }

  // The token travels in an ephemeral remote URL for this one command; it is
  // never written to .git/config and never logged.
  const remote = `https://x-access-token:${cfg.token}@github.com/${cfg.repo}.git`;
  const push = await git(["push", remote, `HEAD:${branch}`], dir);
  const safe = (push.out || "").replaceAll(cfg.token, "***");
  if (!push.ok) return { ok: false, error: `Push failed: ${safe}` };

  return {
    ok: true,
    pushed: true,
    branch,
    committed: status.dirty,
    message: `Source pushed to ${cfg.repo}@${branch}. No build, version change or release was triggered.`,
  };
}

/**
 * Is GitHub carrying the exact commit this PC has? A release always builds from
 * GitHub, so a release started while the local checkout is ahead would silently
 * ship stale source. This is how FRIDAY proves the two sides agree.
 */
async function syncState(root, sourceDir) {
  const status = await sourceStatus(root, sourceDir);
  if (!status.repo) return { ok: true, repo: false, synced: true, ...status };
  const cfg = sync.readConfig(root);
  const dir = sourceDir || root;
  const local = await git(["rev-parse", "HEAD"], dir);
  const localSha = local.ok ? local.out.trim() : "";
  if (!cfg.repo) {
    return {
      ...status,
      ok: true,
      synced: false,
      localSha,
      remoteSha: "",
      message: "No repository is connected.",
    };
  }
  const branch = cfg.branch || "main";
  const head = await sync.api(cfg, `/repos/${cfg.repo}/commits/${encodeURIComponent(branch)}`);
  if (!head.ok) return { ...status, ok: false, error: head.error, localSha, remoteSha: "" };
  const remoteSha = head.body?.sha || "";
  const synced = Boolean(localSha) && localSha === remoteSha && !status.dirty && !status.ahead;
  return {
    ...status,
    ok: true,
    localSha,
    remoteSha,
    synced,
    message: synced
      ? `GitHub@${branch} matches this PC (${remoteSha.slice(0, 7)}).`
      : `Local source differs from GitHub@${branch}: ${status.dirty} uncommitted, ${status.ahead} unpushed.`,
  };
}

/**
 * Push, then wait until GitHub really reports the new commit, so a release
 * triggered afterwards builds the source that was just sent.
 */
async function pushAndWait(root, { message, sourceDir, confirm, timeoutMs = 60000 } = {}) {
  const pushed = await pushSource(root, { message, sourceDir, confirm });
  if (!pushed.ok) return pushed;
  const deadline = Date.now() + timeoutMs;
  let state = await syncState(root, sourceDir);
  while (!state.synced && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    state = await syncState(root, sourceDir);
  }
  return { ...pushed, synced: Boolean(state.synced), remoteSha: state.remoteSha || "", state };
}

module.exports = { isProtectedBranch, sourceStatus, pushSource, syncState, pushAndWait };
