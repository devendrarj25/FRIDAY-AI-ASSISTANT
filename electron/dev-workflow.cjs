// FRIDAY · development / repo control (Friday Hub)
//
// Responsibilities are deliberately narrow and do NOT overlap the update or
// release architecture that already exists:
//
//   • Friday Hub (this module) — inspect the source checkout, review a change
//     set, validate it, put it on a feature branch, push that branch and open a
//     pull request. It NEVER commits to main and NEVER installs anything.
//   • Release (github-release.cjs / release.yml) — turns merged main into an
//     official GitHub Release. Unchanged by this module.
//   • Update (github-sync.cjs / update-safety.cjs) — installs a published
//     build on this PC. Unchanged by this module.
//
// Everything here is plain git plus the GitHub REST API used by the rest of
// FRIDAY (github-sync.api), so there is exactly one GitHub credential path.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const sync = require("./github-sync.cjs");
const contract = require("./friday-contract.cjs");
const IDENTITY = require("../scripts/identity.cjs");

/** Hub GitHub identity — selected connection, not the Updates self-repo unless that is selected. */
function hubCfg(root) {
  if (!root) return {};
  return sync.hubTarget(root).cfg || {};
}

/** Branches FRIDAY refuses to commit to directly — main only moves via a PR. */
const PROTECTED_BRANCHES = ["main", "master", "release", "gh-pages"];

const BRANCH_PREFIXES = ["feature", "fix", "upgrade", "chore"];

const isRepo = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, ".git"));

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

/** `feature/live-captions` from any free text the owner typed. */
function branchName(input, kind = "feature") {
  const prefix = BRANCH_PREFIXES.includes(String(kind)) ? String(kind) : "feature";
  const raw = String(input || "")
    .trim()
    .replace(new RegExp(`^(${BRANCH_PREFIXES.join("|")})/`, "i"), "");
  const slug = raw
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48);
  return `${prefix}/${slug || `change-${Date.now().toString(36)}`}`;
}

const isProtected = (branch) =>
  PROTECTED_BRANCHES.includes(
    String(branch || "")
      .trim()
      .toLowerCase(),
  );

// ------------------------------------------------------------- change sets --
// A change set is the unit that travels Import & Build → Hub. It records what
// was analysed and proposed; it never carries write access of its own.

const storeFile = (root) => path.join(root, "config", "dev-changesets.json");

function readStore(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(root), "utf8"));
    return Array.isArray(raw?.changeSets) ? raw.changeSets : [];
  } catch {
    return [];
  }
}

function writeStore(root, changeSets) {
  const file = storeFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ changeSets }, null, 2));
  return changeSets;
}

function changeSets(root) {
  return readStore(root).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Queue work handed over by Import & Build. `origin` says where it came from so
 * the Hub can show it honestly; `files` is what the analysis proposes to change.
 */
function queueChangeSet(root, entry = {}) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const title = String(entry.title || "").trim();
  if (!title) return { ok: false, error: "A change set needs a title." };
  const files = Array.isArray(entry.files) ? entry.files.filter(Boolean).map(String) : [];
  const record = {
    id: `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: title.slice(0, 200),
    summary: String(entry.summary || "").slice(0, 4000),
    origin: String(entry.origin || "import"),
    kind: BRANCH_PREFIXES.includes(String(entry.kind)) ? String(entry.kind) : "feature",
    files,
    fileCount: files.length || Number(entry.fileCount) || 0,
    problems: Array.isArray(entry.problems) ? entry.problems.map(String).slice(0, 200) : [],
    tested: Boolean(entry.tested),
    testSummary: String(entry.testSummary || ""),
    stagedPath: entry.stagedPath ? String(entry.stagedPath) : null,
    status: "queued",
    branch: null,
    pullRequest: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const next = [record, ...readStore(root)].slice(0, 100);
  writeStore(root, next);
  return { ok: true, changeSet: record, changeSets: next };
}

function updateChangeSet(root, id, patch = {}) {
  const list = readStore(root);
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, error: "That change set no longer exists." };
  const merged = { ...list[index], ...patch, id, updatedAt: Date.now() };
  list[index] = merged;
  writeStore(root, list);
  return { ok: true, changeSet: merged, changeSets: list };
}

function removeChangeSet(root, id) {
  const list = readStore(root).filter((item) => item.id !== id);
  writeStore(root, list);
  return { ok: true, changeSets: list };
}

// ---------------------------------------------------------------- workspace --

/** What the source checkout looks like right now — nothing is changed here. */
async function workspace(root, dir) {
  const cwd = dir || root;
  if (!isRepo(cwd)) {
    return {
      ok: true,
      repo: false,
      dir: cwd || null,
      message: "This FRIDAY copy has no git source checkout, so Hub can only review change sets.",
      changeSets: changeSets(root || ""),
    };
  }
  const cfg = hubCfg(root);
  const target = root ? sync.hubTarget(root) : null;
  const [branch, status, stat, log, branches] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["status", "--porcelain"], cwd),
    git(["diff", "--stat", "HEAD"], cwd),
    git(["log", "-8", "--pretty=%h %s"], cwd),
    git(["branch", "--format=%(refname:short)"], cwd),
  ]);
  const changes = (status.out || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ state: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
  const current = branch.ok ? branch.out : "";
  return {
    ok: true,
    repo: true,
    dir: cwd,
    branch: current,
    onProtectedBranch: isProtected(current),
    defaultBranch: cfg.branch || "main",
    connectedRepo: cfg.repo || null,
    hasToken: Boolean(cfg.token),
    hubId: target?.id || "self",
    hubRole: target?.role || "self",
    hubLabel: target?.label || "",
    changes,
    dirty: changes.length,
    diffStat: stat.out || "",
    commits: (log.out || "").split("\n").filter(Boolean),
    branches: (branches.out || "").split("\n").filter(Boolean),
    changeSets: changeSets(root || ""),
  };
}

/** The unified diff for one file (or the whole tree when no file is given). */
async function diff(root, { dir, file } = {}) {
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const args = ["diff", "HEAD", "--"];
  const result = await git(file ? [...args, String(file)] : ["diff", "HEAD"], cwd);
  if (!result.ok && !result.out) return { ok: false, error: "git diff failed." };
  const text = result.out || "";
  return { ok: true, file: file || null, diff: text.slice(0, 400_000), empty: !text };
}

// ---------------------------------------------------------------- validation --
// Validation runs the project's own checks. It never invents a result: when a
// step is missing from package.json it is reported as skipped, not as passed.

function runStep(cmd, args, cwd, onOutput) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, shell: process.platform === "win32" });
    } catch (error) {
      resolve({ ok: false, output: String(error.message || error) });
      return;
    }
    let output = "";
    const take = (d) => {
      const text = d.toString();
      output += text;
      if (output.length > 200_000) output = output.slice(-200_000);
      onOutput?.(text);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => resolve({ ok: false, output: String(error.message) }));
    child.on("close", (code) => resolve({ ok: code === 0, code, output: output.trim() }));
  });
}

const VALIDATION_STEPS = [
  { id: "audit", label: "Structure & duplicate audit", script: "audit" },
  { id: "typecheck", label: "Typecheck", script: "typecheck" },
  { id: "test", label: "Tests", script: "test" },
];

/** Run audit → typecheck → tests in the source checkout and report each one. */
async function validate(root, { dir, steps, onProgress } = {}) {
  const cwd = dir || root;
  if (!cwd || !fs.existsSync(path.join(cwd, "package.json"))) {
    const skipped = VALIDATION_STEPS.map((step) => ({
      ...step,
      state: "skipped",
      detail: "No package.json.",
    }));
    return {
      ok: true,
      skipped: true,
      results: skipped,
      summary: "No package.json in this checkout — validation skipped (nothing to run).",
    };
  }
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts || {};
  } catch {
    scripts = {};
  }
  const wanted = Array.isArray(steps) && steps.length ? steps : VALIDATION_STEPS.map((s) => s.id);
  const results = [];
  for (const step of VALIDATION_STEPS) {
    if (!wanted.includes(step.id)) continue;
    if (!scripts[step.script]) {
      results.push({ ...step, state: "skipped", detail: `No "${step.script}" script.` });
      onProgress?.(results[results.length - 1]);
      continue;
    }
    onProgress?.({ ...step, state: "running" });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const run = await runStep(npm, ["run", step.script, "--silent"], cwd);
    results.push({
      ...step,
      state: run.ok ? "passed" : "failed",
      detail: (run.output || "").split("\n").slice(-12).join("\n"),
    });
    onProgress?.(results[results.length - 1]);
  }
  const failed = results.filter((r) => r.state === "failed");
  return {
    ok: failed.length === 0,
    results,
    summary: failed.length
      ? `${failed.length} check(s) failed: ${failed.map((r) => r.id).join(", ")}`
      : `${results.filter((r) => r.state === "passed").length} check(s) passed.`,
  };
}

// ------------------------------------------------------------ branch and PR --

/** Create (or switch to) a feature branch. main is never a target. */
async function createBranch(root, { dir, name, kind = "feature", from } = {}) {
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const branch = branchName(name, kind);
  if (isProtected(branch))
    return { ok: false, error: `${branch} is protected — pick another name.` };
  const base = from || hubCfg(root).branch || "main";
  const exists = await git(["rev-parse", "--verify", branch], cwd);

  // A feature branch MUST start from the remote tip of the base branch. Cutting
  // it from a stale local `main` (or, worse, from whatever HEAD happened to be)
  // gives the pull request an old merge base, so GitHub reports it as diverged
  // and refuses to merge it. Refresh the remote ref first, then reuse the same
  // resolveBase() authority the history/revert paths already use.
  const remote = "origin";
  const hasRemote = await git(["remote", "get-url", remote], cwd);
  if (hasRemote.ok) await git(["fetch", "--prune", remote, base], cwd);
  const resolved = await resolveBase(cwd, base);
  const start = resolved.ref;

  const switched = exists.ok
    ? await git(["checkout", branch], cwd)
    : await git(start ? ["checkout", "-b", branch, start] : ["checkout", "-b", branch], cwd);
  if (!switched.ok) return { ok: false, error: `git checkout failed: ${switched.out}` };
  const sha = await git(["rev-parse", "HEAD"], cwd);
  return {
    ok: true,
    branch,
    base,
    startPoint: start || "HEAD",
    sha: sha.ok ? sha.out : "",
    created: !exists.ok,
  };
}

/**
 * Commit the working tree onto the current feature branch and push it.
 * Refuses outright on a protected branch: main moves only through a merged PR.
 */
async function publishBranch(root, { dir, message, confirm } = {}) {
  const cwd = dir || root;
  if (confirm !== true) return { ok: false, error: "Pushing a branch must be confirmed." };
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const cfg = hubCfg(root);
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };
  if (!cfg.token) return { ok: false, error: "A GitHub token is required to push a branch." };

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = head.ok ? head.out : "";
  if (isProtected(branch)) {
    return {
      ok: false,
      protectedBranch: true,
      error: `Refusing to push ${branch} directly — create a feature branch first; main only changes through a pull request.`,
    };
  }

  const status = await git(["status", "--porcelain"], cwd);
  if ((status.out || "").trim()) {
    const add = await git(["add", "-A"], cwd);
    if (!add.ok) return { ok: false, error: `git add failed: ${add.out}` };
    const commit = await git(
      ["commit", "-m", String(message || `friday: ${branch}`).slice(0, 200)],
      cwd,
    );
    if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
      return { ok: false, error: `git commit failed: ${commit.out}` };
    }
  }

  const remote = `https://x-access-token:${cfg.token}@github.com/${cfg.repo}.git`;
  const push = await git(["push", "-u", remote, `HEAD:${branch}`], cwd);
  const safe = (push.out || "").replaceAll(cfg.token, "***");
  if (!push.ok) return { ok: false, error: `Push failed: ${safe}` };
  const sha = await git(["rev-parse", "HEAD"], cwd);
  return { ok: true, branch, sha: sha.ok ? sha.out : "", repo: cfg.repo };
}

/** Open a pull request for a pushed branch, or return the one already open. */
async function openPullRequest(root, { branch, title, body, base, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: "Opening a pull request must be confirmed." };
  const cfg = hubCfg(root);
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };
  if (!cfg.token) return { ok: false, error: "A GitHub token is required to open a pull request." };
  const head = String(branch || "").trim();
  if (!head) return { ok: false, error: "No branch to open a pull request for." };
  if (isProtected(head))
    return { ok: false, error: `${head} is the base branch, not a source branch.` };
  const target = base || cfg.branch || "main";

  const owner = cfg.repo.split("/")[0];
  const existing = await sync.api(
    cfg,
    `/repos/${cfg.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
  );
  if (existing.ok && Array.isArray(existing.body) && existing.body.length) {
    const pr = existing.body[0];
    return { ok: true, existing: true, number: pr.number, url: pr.html_url, state: pr.state };
  }

  const created = await sync.api(cfg, `/repos/${cfg.repo}/pulls`, {
    method: "POST",
    body: {
      title: String(title || head).slice(0, 200),
      head,
      base: target,
      body: String(body || "Prepared by FRIDAY Hub.").slice(0, 60_000),
      maintainer_can_modify: true,
    },
  });
  if (!created.ok) {
    return { ok: false, error: created.error || "GitHub refused to open the pull request." };
  }
  return {
    ok: true,
    existing: false,
    number: created.body?.number,
    url: created.body?.html_url,
    state: created.body?.state,
  };
}

/** Open pull requests with their check state, so the Hub shows real status. */
async function pullRequests(root) {
  const cfg = hubCfg(root);
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };
  const list = await sync.api(cfg, `/repos/${cfg.repo}/pulls?state=open&per_page=20`);
  if (!list.ok) return { ok: false, error: list.error || "Could not read pull requests." };
  const pulls = [];
  for (const pr of Array.isArray(list.body) ? list.body : []) {
    const sha = pr.head?.sha;
    let checks = { total: 0, passed: 0, failed: 0, pending: 0 };
    if (sha) {
      const runs = await sync.api(cfg, `/repos/${cfg.repo}/commits/${sha}/check-runs`);
      for (const run of runs.ok ? runs.body?.check_runs || [] : []) {
        checks.total += 1;
        if (run.status !== "completed") checks.pending += 1;
        else if (run.conclusion === "success" || run.conclusion === "skipped") checks.passed += 1;
        else checks.failed += 1;
      }
    }
    pulls.push({
      number: pr.number,
      title: pr.title,
      branch: pr.head?.ref || "",
      base: pr.base?.ref || "",
      url: pr.html_url,
      draft: Boolean(pr.draft),
      mergeable: pr.mergeable_state || null,
      sha: sha || "",
      checks,
    });
  }
  return { ok: true, pulls };
}

// ------------------------------------------------------- manual revert center --
// Two independent manual safety actions. Neither depends on a recovery branch,
// neither merges, resets or force-pushes: both only ever create a NEW branch
// off current main, make one ordinary commit and leave a pull request for the
// owner to merge. Git history is never rewritten or deleted.

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** The branch main lives on for this checkout. */
const baseBranch = (root) => hubCfg(root).branch || "main";

/** Prefer the remote tip so a stale local main can never silently be used. */
async function resolveBase(cwd, base) {
  const remote = await git(["rev-parse", "--verify", `origin/${base}`], cwd);
  if (remote.ok) return { ref: `origin/${base}`, sha: remote.out };
  const local = await git(["rev-parse", "--verify", base], cwd);
  return local.ok ? { ref: base, sha: local.out } : { ref: "", sha: "" };
}

/** Commits reachable from main, newest first — the pool both actions pick from. */
async function history(root, { dir, limit = 40, branch } = {}) {
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const base = branch || baseBranch(root);
  const resolved = await resolveBase(cwd, base);
  const ref = resolved.ref || "HEAD";
  const log = await git(
    [
      "log",
      ref,
      `-${Math.min(Math.max(Number(limit) || 40, 1), 200)}`,
      "--pretty=%H%x1f%an%x1f%aI%x1f%s%x1f%P",
    ],
    cwd,
  );
  if (!log.ok) return { ok: false, error: `git log failed: ${log.out}` };
  const commits = (log.out || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, subject, parents] = line.split("\u001f");
      const parentList = (parents || "").split(" ").filter(Boolean);
      return {
        sha,
        short: (sha || "").slice(0, 8),
        author: author || "",
        date: date || "",
        subject: subject || "",
        merge: parentList.length > 1,
      };
    });
  return { ok: true, base, baseRef: resolved.ref, baseSha: resolved.sha, commits };
}

/** Merged pull requests, so a PR can be picked instead of a raw SHA. */
async function mergedPullRequests(root) {
  const cfg = hubCfg(root);
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };
  const list = await sync.api(
    cfg,
    `/repos/${cfg.repo}/pulls?state=closed&per_page=30&sort=updated&direction=desc`,
  );
  if (!list.ok) return { ok: false, error: list.error || "Could not read pull requests." };
  const pulls = (Array.isArray(list.body) ? list.body : [])
    .filter((pr) => pr.merged_at && pr.merge_commit_sha)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.head?.ref || "",
      base: pr.base?.ref || "",
      url: pr.html_url,
      author: pr.user?.login || "",
      mergedAt: pr.merged_at,
      sha: pr.merge_commit_sha,
      short: String(pr.merge_commit_sha).slice(0, 8),
    }));
  return { ok: true, pulls };
}

/** Author, date, touched files and the diff for one commit — read-only. */
async function commitDetail(root, { dir, sha } = {}) {
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const id = String(sha || "").trim();
  if (!SHA_RE.test(id)) return { ok: false, error: "Pick a valid commit SHA." };
  const meta = await git(
    ["show", "-s", "--pretty=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P", id],
    cwd,
  );
  if (!meta.ok) return { ok: false, error: `Unknown commit: ${id}` };
  const [full, author, email, date, subject, body, parents] = (meta.out || "").split("\u001f");
  const parentList = (parents || "").trim().split(" ").filter(Boolean);
  const names = await git(["show", "--name-status", "--pretty=format:", id], cwd);
  const files = (names.out || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [state, ...rest] = line.split(/\s+/);
      return { state, path: rest.join(" ") };
    });
  const patch = await git(["show", "--patch", "--pretty=format:", id], cwd);
  return {
    ok: true,
    commit: {
      sha: full || id,
      short: (full || id).slice(0, 8),
      author: author || "",
      email: email || "",
      date: date || "",
      subject: subject || "",
      body: (body || "").trim(),
      merge: parentList.length > 1,
      parents: parentList,
    },
    files,
    diff: (patch.out || "").slice(0, 400_000),
  };
}

/** What restoring main to a historical commit would actually change. */
async function restorePreview(root, { dir, sha } = {}) {
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const id = String(sha || "").trim();
  if (!SHA_RE.test(id)) return { ok: false, error: "Pick a valid commit SHA." };
  const base = baseBranch(root);
  const resolved = await resolveBase(cwd, base);
  if (!resolved.sha) return { ok: false, error: `Cannot resolve ${base}.` };
  const reachable = await git(["merge-base", "--is-ancestor", id, resolved.ref], cwd);
  if (!reachable.ok) {
    return { ok: false, error: `${id.slice(0, 8)} is not reachable from ${base}.` };
  }
  const [between, names] = await Promise.all([
    git(["log", `${id}..${resolved.ref}`, "--pretty=%H%x1f%an%x1f%aI%x1f%s"], cwd),
    git(["diff", "--name-status", `${resolved.ref}..${id}`], cwd),
  ]);
  const commits = (between.out || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [full, author, date, subject] = line.split("\u001f");
      return { sha: full, short: (full || "").slice(0, 8), author, date, subject };
    });
  const files = (names.out || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [state, ...rest] = line.split(/\s+/);
      return { state, path: rest.join(" ") };
    });
  return {
    ok: true,
    base,
    currentSha: resolved.sha,
    currentShort: resolved.sha.slice(0, 8),
    targetSha: id,
    targetShort: id.slice(0, 8),
    commitsBetween: commits,
    files,
  };
}

/** Refuse to touch a checkout that still has uncommitted work. */
async function requireCleanTree(cwd) {
  const status = await git(["status", "--porcelain"], cwd);
  if ((status.out || "").trim()) {
    return "The source checkout has uncommitted changes — commit or discard them first.";
  }
  return "";
}

/**
 * Revert one commit (or a merged PR's merge commit) on a NEW branch off main.
 * Uses `git revert`, which adds an inverse commit: nothing is rewritten.
 */
async function revertCommit(root, { dir, sha, confirm, label } = {}) {
  const cwd = dir || root;
  if (confirm !== true) return { ok: false, error: "Reverting must be confirmed." };
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const id = String(sha || "").trim();
  if (!SHA_RE.test(id)) return { ok: false, error: "Pick a valid commit SHA." };
  const dirty = await requireCleanTree(cwd);
  if (dirty) return { ok: false, error: dirty };

  const detail = await commitDetail(root, { dir: cwd, sha: id });
  if (!detail.ok) return detail;
  const base = baseBranch(root);
  const resolved = await resolveBase(cwd, base);
  if (!resolved.sha) return { ok: false, error: `Cannot resolve ${base}.` };

  const branch = `revert/${detail.commit.short}-${Date.now().toString(36)}`;
  if (isProtected(branch)) return { ok: false, error: "Refusing to work on a protected branch." };
  const created = await git(["checkout", "-b", branch, resolved.ref], cwd);
  if (!created.ok) return { ok: false, error: `git checkout failed: ${created.out}` };

  const args = ["revert", "--no-edit"];
  if (detail.commit.merge) args.push("-m", "1");
  args.push(id);
  const reverted = await git(args, cwd);
  if (!reverted.ok) {
    await git(["revert", "--abort"], cwd);
    await git(["checkout", base], cwd);
    await git(["branch", "-D", branch], cwd);
    return { ok: false, error: `git revert failed: ${reverted.out}` };
  }
  const head = await git(["rev-parse", "HEAD"], cwd);
  return {
    ok: true,
    action: "revert",
    branch,
    base,
    sha: head.ok ? head.out : "",
    reverted: detail.commit,
    title: `Revert: ${label || detail.commit.subject}`.slice(0, 200),
  };
}

/**
 * Restore main's *content* to a historical commit on a NEW branch off main.
 * The historical tree is checked out and committed forward — no reset, no
 * force-push, no history rewrite; every commit in between stays in the log.
 */
async function restoreToCommit(root, { dir, sha, confirm } = {}) {
  const cwd = dir || root;
  if (confirm !== true) return { ok: false, error: "Restoring must be confirmed." };
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const preview = await restorePreview(root, { dir: cwd, sha });
  if (!preview.ok) return preview;
  const dirty = await requireCleanTree(cwd);
  if (dirty) return { ok: false, error: dirty };

  const branch = `restore/${preview.targetShort}-${Date.now().toString(36)}`;
  if (isProtected(branch)) return { ok: false, error: "Refusing to work on a protected branch." };
  const resolved = await resolveBase(cwd, preview.base);
  const created = await git(["checkout", "-b", branch, resolved.ref], cwd);
  if (!created.ok) return { ok: false, error: `git checkout failed: ${created.out}` };

  // Move the index + worktree to the historical tree while HEAD stays put, then
  // commit that state forward as one ordinary commit.
  const tree = await git(["read-tree", "--reset", "-u", preview.targetSha], cwd);
  if (!tree.ok) {
    await git(["checkout", preview.base], cwd);
    await git(["branch", "-D", branch], cwd);
    return { ok: false, error: `Could not load that commit's content: ${tree.out}` };
  }
  const commit = await git(
    [
      "commit",
      "--allow-empty",
      "-m",
      `Restore repository content to ${preview.targetShort}`,
      "-m",
      `Restores the working tree to commit ${preview.targetSha}. History is preserved; ${preview.commitsBetween.length} commit(s) remain in the log.`,
    ],
    cwd,
  );
  if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
    await git(["checkout", preview.base], cwd);
    await git(["branch", "-D", branch], cwd);
    return { ok: false, error: `git commit failed: ${commit.out}` };
  }
  const head = await git(["rev-parse", "HEAD"], cwd);
  return {
    ok: true,
    action: "restore",
    branch,
    base: preview.base,
    sha: head.ok ? head.out : "",
    preview,
    title: `Restore content to ${preview.targetShort}`,
  };
}

/** The pull-request body for either manual safety action. */
function safetyBody(result) {
  if (!result) return "Prepared by FRIDAY Revert Center.";
  const lines = [];
  if (result.action === "revert") {
    lines.push(
      `Reverts \`${result.reverted?.short}\` — ${result.reverted?.subject}`,
      "",
      `Author: ${result.reverted?.author}`,
      `Date: ${result.reverted?.date}`,
      "",
      "Applied with `git revert` on a new branch off " + result.base + ". No reset, no force-push.",
    );
  } else {
    const p = result.preview || {};
    lines.push(
      `Restores repository content to \`${p.targetShort}\`.`,
      "",
      `${p.base} was at \`${p.currentShort}\`; ${p.commitsBetween?.length ?? 0} commit(s) sit between them and all of them stay in the history.`,
      `${p.files?.length ?? 0} file(s) change.`,
    );
    if (p.files?.length) {
      lines.push("", ...p.files.slice(0, 40).map((f) => `- ${f.state} ${f.path}`));
      if (p.files.length > 40) lines.push(`- …and ${p.files.length - 40} more`);
    }
  }
  lines.push("", "Prepared by FRIDAY Revert Center. Merge manually after review.");
  return lines.join("\n");
}

const FILE_MAX = 400_000;

const DEFAULT_HUB_GITIGNORE = [
  "node_modules/",
  ".env",
  ".env.*",
  "dist/",
  "dist-desktop/",
  "release/",
  ".output/",
  "*.log",
  ".DS_Store",
  "",
].join("\n");

function insideCheckout(cwd, file) {
  return contract.resolveInside(cwd, file);
}

/** Switch to an existing local branch. Protected branches are allowed for reading. */
async function checkoutBranch(root, { dir, name } = {}) {
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const branch = String(name || "").trim();
  if (!branch) return { ok: false, error: "Pick a branch to switch to." };
  if (branch.includes("..") || /[\s\\]/.test(branch)) {
    return { ok: false, error: "That branch name is not safe to check out." };
  }
  const switched = await git(["checkout", branch], cwd);
  if (!switched.ok) return { ok: false, error: `git checkout failed: ${switched.out}` };
  const sha = await git(["rev-parse", "HEAD"], cwd);
  return { ok: true, branch, sha: sha.ok ? sha.out : "", onProtectedBranch: isProtected(branch) };
}

async function listWorkingFiles(root, { dir } = {}) {
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const listed = await git(["ls-files", "-co", "--exclude-standard"], cwd);
  if (!listed.ok) return { ok: false, error: listed.out || "git ls-files failed." };
  const files = (listed.out || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2000);
  return { ok: true, files };
}

async function readWorkingFile(root, { dir, file } = {}) {
  const cwd = dir || root;
  if (!cwd) return { ok: false, error: "No checkout directory." };
  const resolved = insideCheckout(cwd, file);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    return { ok: false, error: "That file is not in this checkout." };
  }
  const stat = fs.statSync(resolved.path);
  if (stat.size > FILE_MAX) {
    return { ok: false, error: `File is larger than ${FILE_MAX} bytes — open it outside Hub.` };
  }
  return {
    ok: true,
    file: resolved.relative,
    content: fs.readFileSync(resolved.path, "utf8"),
    bytes: stat.size,
  };
}

async function writeWorkingFile(root, { dir, file, content, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: "Writing a file must be confirmed." };
  const cwd = dir || root;
  if (!cwd) return { ok: false, error: "No checkout directory." };
  const resolved = insideCheckout(cwd, file);
  if (!resolved.ok) return resolved;
  if (resolved.relative === "." || resolved.relative.endsWith("/")) {
    return { ok: false, error: "Pick a file path, not a directory." };
  }
  const text = content == null ? "" : String(content);
  if (Buffer.byteLength(text, "utf8") > FILE_MAX) {
    return { ok: false, error: `Content is larger than ${FILE_MAX} bytes.` };
  }
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  fs.writeFileSync(resolved.path, text, "utf8");
  return { ok: true, file: resolved.relative, bytes: Buffer.byteLength(text, "utf8") };
}

async function commitWorkingTree(root, { dir, message, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: "Committing must be confirmed." };
  const cwd = dir || root;
  if (!isRepo(cwd)) return { ok: false, error: "No git source checkout." };
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = head.ok ? head.out : "";
  if (isProtected(branch)) {
    return {
      ok: false,
      protectedBranch: true,
      error: `Refusing to commit on ${branch} — create a feature branch first.`,
    };
  }
  const add = await git(["add", "-A"], cwd);
  if (!add.ok) return { ok: false, error: `git add failed: ${add.out}` };
  await ensureGitIdentity(cwd);
  const commit = await git(
    ["commit", "-m", String(message || `friday: ${branch}`).slice(0, 200)],
    cwd,
  );
  if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
    return { ok: false, error: `git commit failed: ${commit.out}` };
  }
  const sha = await git(["rev-parse", "HEAD"], cwd);
  return {
    ok: true,
    branch,
    sha: sha.ok ? sha.out : "",
    empty: /nothing to commit/i.test(commit.out || ""),
  };
}

function stripToken(text, token) {
  if (!token) return String(text || "");
  return String(text || "")
    .split(token)
    .join("***");
}

async function ensureGitIdentity(cwd) {
  const named = await git(["config", "user.name"], cwd);
  if (named.ok && named.out) return;
  await git(["config", "user.name", IDENTITY.OWNER], cwd);
  await git(["config", "user.email", `${IDENTITY.GITHUB}@users.noreply.github.com`], cwd);
}

/**
 * Clone (or reuse) the selected Hub repo's working tree.
 * FRIDAY's own checkout is never cloned here — Hub uses the existing source root.
 */
async function ensureCheckout(root) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const target = sync.hubTarget(root);
  if (target.role !== "linked" || !target.dir) {
    return { ok: true, skipped: true, role: "self", dir: null };
  }
  const dest = target.dir;
  if (!contract.contains(root, dest)) {
    return { ok: false, error: "Hub checkout path is outside the FRIDAY folder." };
  }
  if (isRepo(dest)) return { ok: true, dir: dest, existed: true, repo: target.repo };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const leftover = fs.readdirSync(dest).filter((name) => name !== "." && name !== "..");
    if (leftover.length) {
      return { ok: false, error: "Hub checkout folder exists but is not a git repository." };
    }
  }
  const url = target.token
    ? `https://x-access-token:${target.token}@github.com/${target.repo}.git`
    : `https://github.com/${target.repo}.git`;
  const branch = target.defaultBranch || "main";
  const tryClone = async (args) => {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    return git(["clone", ...args, dest], root);
  };
  let cloned = await tryClone(["--branch", branch, "--single-branch", url]);
  if (!cloned.ok) cloned = await tryClone([url]);
  if (!cloned.ok) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const safe = stripToken(cloned.out, target.token);
    if (/empty|couldn't find remote ref|remote HEAD refers/i.test(cloned.out || "")) {
      fs.mkdirSync(dest, { recursive: true });
      const branch = target.defaultBranch || "main";
      let inited = await git(["init", "-b", branch], dest);
      if (!inited.ok) {
        inited = await git(["init"], dest);
        if (inited.ok) await git(["checkout", "-b", branch], dest);
      }
      if (!isRepo(dest)) {
        return {
          ok: false,
          error: `Empty GitHub repo, but git init failed: ${inited.out || safe}`,
        };
      }
      await ensureGitIdentity(dest);
      await git(["remote", "add", "origin", `https://github.com/${target.repo}.git`], dest);
      return {
        ok: true,
        empty: true,
        initialized: true,
        dir: dest,
        repo: target.repo,
        warning: safe,
      };
    }
    return { ok: false, error: `Clone failed: ${safe}` };
  }
  await git(["remote", "set-url", "origin", `https://github.com/${target.repo}.git`], dest);
  return { ok: true, dir: dest, cloned: true, repo: target.repo };
}

function listingBesidesGit(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name !== ".git");
}

/**
 * Unpack an owner-provided zip or folder into a linked Hub checkout, commit, and
 * push to the selected GitHub remote. Never runs against FRIDAY's own source tree.
 */
async function bootstrapFromSource(root, { dir, zip, folder, confirm, message } = {}) {
  if (confirm !== true) return { ok: false, error: "Packaging and pushing must be confirmed." };
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const target = sync.hubTarget(root);
  const dest = dir || target.dir;
  if (target.role !== "linked" || !dest) {
    return {
      ok: false,
      error: "Package and push is for a connected extra repo, not FRIDAY's own source.",
    };
  }
  if (!contract.contains(root, dest)) {
    return { ok: false, error: "That folder is outside the FRIDAY folder." };
  }
  if (path.resolve(dest) === path.resolve(root)) {
    return { ok: false, error: "Refusing to re-init FRIDAY's own workspace." };
  }
  const sourceZip = zip ? String(zip) : "";
  const sourceFolder = folder ? String(folder) : "";
  if (!sourceZip && !sourceFolder) {
    return { ok: false, error: "Pick a zip or a folder to package." };
  }
  if (sourceZip && sourceFolder) {
    return { ok: false, error: "Pick either a zip or a folder, not both." };
  }
  fs.mkdirSync(dest, { recursive: true });
  const extras = listingBesidesGit(dest);
  if (extras.length) {
    return {
      ok: false,
      error: "The Hub checkout already has files — pick an empty connected repo.",
    };
  }

  if (sourceZip) {
    if (!fs.existsSync(sourceZip)) return { ok: false, error: "That zip is not on disk." };
    const importer = require("./importer.cjs");
    const unpacked = await importer.extractZip(sourceZip, dest);
    if (!unpacked) return { ok: false, error: "Could not unpack that zip." };
  } else {
    if (!fs.existsSync(sourceFolder) || !fs.statSync(sourceFolder).isDirectory()) {
      return { ok: false, error: "That folder is not on disk." };
    }
    fs.cpSync(sourceFolder, dest, {
      recursive: true,
      filter: (src) => path.basename(src) !== ".git",
    });
  }

  const ignoreFile = path.join(dest, ".gitignore");
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, DEFAULT_HUB_GITIGNORE, "utf8");

  const branch = target.defaultBranch || "main";
  if (!isRepo(dest)) {
    const inited = await git(["init", "-b", branch], dest);
    if (!inited.ok) {
      const fallback = await git(["init"], dest);
      if (!fallback.ok) return { ok: false, error: `git init failed: ${fallback.out}` };
      await git(["checkout", "-b", branch], dest);
    }
  }

  await ensureGitIdentity(dest);

  const add = await git(["add", "-A"], dest);
  if (!add.ok) return { ok: false, error: `git add failed: ${add.out}` };
  const commit = await git(
    ["commit", "-m", String(message || "Initial commit from FRIDAY Hub").slice(0, 200)],
    dest,
  );
  if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
    return { ok: false, error: `git commit failed: ${commit.out}` };
  }

  const cfg = target.cfg || {};
  if (!cfg.repo) return { ok: false, error: "No repository is connected." };
  if (!cfg.token) {
    return {
      ok: true,
      committed: true,
      pushed: false,
      dir: dest,
      repo: cfg.repo,
      warning: "Committed locally. A GitHub token is required to push.",
    };
  }
  const remote = `https://x-access-token:${cfg.token}@github.com/${cfg.repo}.git`;
  await git(["remote", "remove", "origin"], dest);
  const added = await git(["remote", "add", "origin", `https://github.com/${cfg.repo}.git`], dest);
  if (!added.ok && !/already exists/i.test(added.out || "")) {
    return { ok: false, error: `git remote failed: ${stripToken(added.out, cfg.token)}` };
  }
  const push = await git(["push", "-u", remote, `HEAD:${branch}`], dest);
  const safe = stripToken(push.out, cfg.token);
  if (!push.ok) return { ok: false, error: `Push failed: ${safe}` };
  await git(["remote", "set-url", "origin", `https://github.com/${cfg.repo}.git`], dest);
  const sha = await git(["rev-parse", "HEAD"], dest);
  return {
    ok: true,
    committed: true,
    pushed: true,
    dir: dest,
    repo: cfg.repo,
    sha: sha.ok ? sha.out : "",
  };
}

module.exports = {
  PROTECTED_BRANCHES,
  BRANCH_PREFIXES,
  branchName,
  isProtected,
  changeSets,
  queueChangeSet,
  updateChangeSet,
  removeChangeSet,
  storeFile,
  workspace,
  diff,
  validate,
  createBranch,
  publishBranch,
  openPullRequest,
  pullRequests,
  history,
  mergedPullRequests,
  commitDetail,
  restorePreview,
  revertCommit,
  restoreToCommit,
  safetyBody,
  git,
  checkoutBranch,
  listWorkingFiles,
  readWorkingFile,
  writeWorkingFile,
  commitWorkingTree,
  ensureCheckout,
  bootstrapFromSource,
  DEFAULT_HUB_GITIGNORE,
};
