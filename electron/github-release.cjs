// FRIDAY · GitHub release control (desktop side).
//
// FRIDAY does not build releases locally. "Build & Release" asks GitHub to run
// the very same workflow a human runs from the Actions tab
// (.github/workflows/release.yml), so there is exactly one release system, one
// versioning rule and one changelog generator.
//
// Everything here is read-only except dispatch/create calls, which post with
// the owner's stored token (encrypted credential store via github-sync.cjs).
// Tokens are never logged.
const path = require("node:path");

const sync = require("./github-sync.cjs");
const engine = require(path.resolve(__dirname, "..", "scripts", "release-engine.cjs"));

const API = "https://api.github.com";
const WORKFLOW = "release.yml";
const TEST_WORKFLOW = "test-build.yml";

async function call(cfg, endpoint, { method = "GET", body } = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "FRIDAY",
    "x-github-api-version": "2022-11-28",
  };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error:
        res.status === 404
          ? "Not found — check the repository name, and that the token can see it."
          : res.status === 401 || res.status === 403
            ? parsed?.message ||
              "GitHub rejected the token. A release needs fine-grained permissions Contents: Read and write and Actions: Read and write."
            : parsed?.message || `GitHub error ${res.status}`,
    };
  }
  return { ok: true, status: res.status, body: parsed };
}

const requireRepo = (root, override = {}) => {
  const cfg = { ...sync.readConfig(root), ...override };
  return cfg.repo ? { ok: true, cfg } : { ok: false, error: "No repository is connected." };
};

/** The published releases, newest first, with their Windows assets. */
async function listReleases(root, override = {}) {
  const found = requireRepo(root, override);
  if (!found.ok) return found;
  const res = await call(found.cfg, `/repos/${found.cfg.repo}/releases?per_page=100`);
  if (!res.ok) return res;
  const releases = (res.body || []).map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    version: String(r.tag_name || "").replace(/^v/i, ""),
    notes: r.body || "",
    draft: Boolean(r.draft),
    prerelease: Boolean(r.prerelease),
    at: Date.parse(r.published_at || r.created_at || "") || 0,
    url: r.html_url,
    assets: (r.assets || []).map((a) => sync.mapReleaseAsset(a)),
  }));
  const stables = releases.filter(
    (r) => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(r.tag),
  );
  const latest = stables.reduce((best, r) => {
    if (!best) return r;
    return engine.compareBuilds(r.tag, best.tag) > 0 ? r : best;
  }, null);
  return { ok: true, releases, latest: latest || null };
}

/**
 * Windows installer assets for the current update channel.
 * Channel split is github-sync.isTestRelease — the same rule checkUpdate uses.
 * Read-only: lists and describes assets; never dispatches a workflow or writes.
 */
async function listInstallerBundles(root, override = {}) {
  const found = requireRepo(root, override);
  if (!found.ok) return found;
  const listed = await listReleases(root, override);
  if (!listed.ok) return listed;
  const channel = sync.normalizeUpdateChannel(override.updateChannel ?? found.cfg.updateChannel);
  const wantTest = channel === "test";
  const bundles = [];
  for (const release of listed.releases || []) {
    if (release.draft) continue;
    const testBuild = sync.isTestRelease({
      tag_name: release.tag,
      name: release.name,
      prerelease: release.prerelease,
      assets: release.assets,
    });
    if (testBuild !== wantTest) continue;
    const installer = sync.installerAsset(release.assets || []);
    if (!installer) continue;
    bundles.push({
      tag: release.tag,
      name: release.name,
      version: release.version,
      notes: release.notes,
      at: release.at,
      url: release.url,
      testBuild,
      updateChannel: channel,
      installer,
    });
  }
  return { ok: true, channel, bundles };
}

/**
 * What has landed since the last release — the same commit list the workflow
 * feeds to the release engine, so the preview matches what CI will publish.
 */
async function analyzeChanges(root, override = {}) {
  const found = requireRepo(root, override);
  if (!found.ok) return found;
  const { cfg } = found;
  const releases = await listReleases(root, override);
  if (!releases.ok) return releases;
  const previous = releases.latest?.tag || null;
  const branch = "main";

  let declared = previous ? String(previous).replace(/^v/i, "") : "";
  const canonical = await call(
    cfg,
    `/repos/${cfg.repo}/contents/config/friday-version.json?ref=main`,
  );
  if (canonical.ok) {
    try {
      const body = Buffer.from(String(canonical.body?.content || ""), "base64").toString("utf8");
      const identity = engine.identityFromCanonical(JSON.parse(body));
      if (identity?.releaseVersion) declared = identity.releaseVersion;
    } catch {
      declared = declared || "";
    }
  }
  if (!declared) {
    const pkg = await call(cfg, `/repos/${cfg.repo}/contents/package.json?ref=main`);
    if (!pkg.ok) return pkg;
    try {
      const body = Buffer.from(String(pkg.body?.content || ""), "base64").toString("utf8");
      declared = engine.stableBaseline([JSON.parse(body).version]);
    } catch {
      return { ok: false, error: "main does not contain a valid stable version identity." };
    }
  }
  if (!declared || declared === "0.0.0") {
    return { ok: false, error: "main does not contain a valid stable version identity." };
  }

  let subjects = [];
  if (previous) {
    const diff = await call(
      cfg,
      `/repos/${cfg.repo}/compare/${encodeURIComponent(previous)}...${encodeURIComponent(branch)}`,
    );
    if (!diff.ok) return diff;
    subjects = (diff.body.commits || []).map((c) => (c.commit?.message || "").split("\n")[0]);
  }

  const baseline = previous ? String(previous).replace(/^v/i, "") : declared;
  const tagList = await call(cfg, `/repos/${cfg.repo}/tags?per_page=100`);
  const tagNames = tagList.ok ? (tagList.body || []).map((tag) => tag.name) : [];
  const consumed = engine.stableConsumed(
    (releases.releases || [])
      .filter((row) => !row.draft && !row.prerelease)
      .map((row) => row.version),
    tagNames,
  );
  const mode = ["auto", "rebuild", "update"].includes(override.mode) ? override.mode : "auto";
  const preview = engine.releasePreview({
    mode,
    current: declared,
    baseline,
    type: override.releaseType || "auto",
    subjects,
    released: consumed,
  });
  return {
    previous,
    branch,
    latest: releases.latest,
    ...preview,
    commits: subjects.length,
  };
}

/**
 * State of the release Pull Request for a given version.
 *
 * The official pipeline is deliberately two-staged: `prepare` opens
 * release/vX.Y.Z as a normal Pull Request, the owner reviews and merges it, and
 * only then may `publish` build, tag and release the merged main commit. This
 * read tells FRIDAY which stage is legitimate right now — it never merges.
 */
async function releaseStatus(root, override = {}) {
  const found = requireRepo(root, override);
  if (!found.ok) return found;
  const { cfg } = found;

  const prs = await call(
    cfg,
    `/repos/${cfg.repo}/pulls?state=all&base=main&per_page=30&sort=updated&direction=desc`,
  );
  if (!prs.ok) return prs;

  const releasePr = (prs.body || [])
    .filter((pr) => /^release\/v\d+\.\d+\.\d+(?:\.\d+)?$/i.test(String(pr.head?.ref || "")))
    .filter((pr) => Boolean(pr.merged_at) || String(pr.state).toLowerCase() === "open")
    .sort((a, b) => {
      const av = String(a.head?.ref || "").replace(/^release\/v/i, "");
      const bv = String(b.head?.ref || "").replace(/^release\/v/i, "");
      return engine.compareBuilds(bv, av);
    })[0];
  if (!releasePr) {
    return { ok: true, stage: "prepare", pr: null };
  }

  const version = String(releasePr.head.ref).replace(/^release\/v/i, "");
  const merged = Boolean(releasePr.merged_at);
  const released = merged ? await call(cfg, `/repos/${cfg.repo}/releases/tags/v${version}`) : null;

  return {
    ok: true,
    // A merged, not-yet-released PR is exactly the publish window.
    stage: merged && !released?.ok ? "publish" : "prepare",
    pr: {
      number: releasePr.number,
      url: releasePr.html_url,
      branch: releasePr.head.ref,
      version,
      tag: `v${version}`,
      state: merged ? "merged" : releasePr.state, // open | closed | merged
      merged,
      mergeCommit: releasePr.merge_commit_sha || "",
      released: Boolean(released?.ok),
      at: Date.parse(releasePr.updated_at || "") || 0,
    },
  };
}

/**
 * Ask GitHub to run the release workflow. This is the only release path.
 *
 * `stage: "prepare"` opens the release PR; `stage: "publish"` releases the
 * merged main commit. Publishing is refused unless a release PR for the
 * prepared version has actually been merged into main — an unmerged branch can
 * never become an official release.
 *
 * The workflow builds what GitHub holds, so a prepare is refused while this PC
 * carries newer source, unless the owner has seen that state and confirmed it
 * (`acknowledgeLocalChanges`). FRIDAY never pushes silently to work around it.
 */
async function dispatchRelease(root, input = {}) {
  const found = requireRepo(root, input);
  if (!found.ok) return found;
  const { cfg } = found;
  if (!cfg.token) {
    return {
      ok: false,
      error:
        "A GitHub token with Contents: Read and write and Actions: Read and write is required to start a release.",
    };
  }

  const stage = input.stage === "publish" ? "publish" : "prepare";
  // rebuild = republish this number · update = the next number · auto = keep
  // this number unless release_type names a level. The same three modes the
  // Actions tab exposes, so the app and CI never disagree.
  const mode = ["auto", "rebuild", "update"].includes(input.mode) ? input.mode : "auto";

  if (stage === "publish") {
    // Publish may only ever follow a merged release PR. A deliberate rebuild
    // republishes a version that is already on main, so it needs no new PR.
    const status = await releaseStatus(root, input);
    if (!status.ok) return status;
    if (mode !== "rebuild" && (!status.pr || !status.pr.merged)) {
      return {
        ok: false,
        notMerged: true,
        status,
        error: status.pr
          ? `The release PR for ${status.pr.tag} is still ${status.pr.state} — merge it into main first; an unmerged branch is never published, and publishing now would fall back to the previous version.`
          : "There is no release Pull Request to publish. Run Prepare Release first, then merge the PR it opens.",
      };
    }
    if (mode !== "rebuild" && status.pr?.released) {
      return {
        ok: false,
        alreadyReleased: true,
        status,
        error: `${status.pr.tag} has already been released — prepare a new version, or publish with mode = rebuild to replace its assets.`,
      };
    }
  } else {
    // Stale-source guard — the exact state is reported back so the UI can show it.
    const push = require("./github-push.cjs");
    const state = await push.syncState(root, input.sourceDir);
    if (state.repo && state.ok && !state.synced && input.acknowledgeLocalChanges !== true) {
      return {
        ok: false,
        localChanges: true,
        state,
        error:
          `This PC has ${state.dirty || 0} uncommitted and ${state.ahead || 0} unpushed change(s). ` +
          "GitHub would build older source — review, commit and push first, or confirm to release GitHub's current source anyway.",
      };
    }
  }

  const release_type = ["auto", "patch", "minor", "major", "extreme", "revision"].includes(
    input.releaseType,
  )
    ? input.releaseType
    : "auto";

  const res = await call(cfg, `/repos/${cfg.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: {
      ref: "main",
      inputs: {
        stage,
        mode,
        release_type,
        title: String(input.title || ""),
        notes: String(input.notes || ""),
      },
    },
  });
  if (!res.ok) {
    return res.status === 404
      ? {
          ok: false,
          error:
            "The Release / Build workflow was not found on GitHub. Push .github/workflows/release.yml first.",
        }
      : res;
  }
  return {
    ok: true,
    dispatched: true,
    stage,
    mode,
    releaseType: release_type,
    workflow: WORKFLOW,
    runsUrl: `https://github.com/${cfg.repo}/actions/workflows/${WORKFLOW}`,
  };
}

/**
 * Start the branch/PR TEST EXE build. It never creates an official version, a
 * stable tag or a release — it produces a downloadable portable test EXE, and
 * optionally a clearly labelled TEST pre-release for FRIDAY's Test channel.
 */
async function dispatchTestBuild(root, input = {}) {
  const found = requireRepo(root, input);
  if (!found.ok) return found;
  const { cfg } = found;
  if (!cfg.token) {
    return { ok: false, error: "A GitHub token with Actions: Read and write is required." };
  }

  const res = await call(cfg, `/repos/${cfg.repo}/actions/workflows/${TEST_WORKFLOW}/dispatches`, {
    method: "POST",
    body: {
      ref: "main",
      inputs: {
        ref: String(input.ref || "").trim(),
        package: "portable only (true test EXE)",
        publish: input.publish ? "true" : "false",
      },
    },
  });
  if (!res.ok) {
    return res.status === 404
      ? {
          ok: false,
          error:
            "The Test EXE Build workflow was not found on GitHub. Push .github/workflows/test-build.yml first.",
        }
      : res;
  }
  return {
    ok: true,
    dispatched: true,
    workflow: TEST_WORKFLOW,
    ref: String(input.ref || "main"),
    runsUrl: `https://github.com/${cfg.repo}/actions/workflows/${TEST_WORKFLOW}`,
  };
}

/** Live status of the release workflow, so FRIDAY can show what CI is doing. */
async function releaseRuns(root, override = {}) {
  const found = requireRepo(root, override);
  if (!found.ok) return found;
  const res = await call(
    found.cfg,
    `/repos/${found.cfg.repo}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
  );
  if (!res.ok) return res;
  return {
    ok: true,
    runs: (res.body?.workflow_runs || []).map((r) => ({
      id: r.id,
      status: r.status, // queued | in_progress | completed
      conclusion: r.conclusion, // success | failure | cancelled | null
      at: Date.parse(r.created_at || "") || 0,
      url: r.html_url,
      title: r.display_title || r.name,
    })),
  };
}

/** Workflows defined on the connected repo — Hub Actions, not FRIDAY's update check. */
async function listWorkflows(root, override = {}) {
  const found = requireRepo(root, override);
  if (!found.ok) return found;
  const res = await call(found.cfg, `/repos/${found.cfg.repo}/actions/workflows?per_page=50`);
  if (!res.ok) return res;
  const workflows = (res.body?.workflows || [])
    .filter((w) => String(w.state || "").toLowerCase() === "active")
    .map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      state: w.state,
      badge: w.badge_url,
    }));
  return { ok: true, repo: found.cfg.repo, workflows };
}

/**
 * Dispatch any workflow the connected repo defines. Same workflow_dispatch
 * call dispatchRelease already uses. Never silent.
 */
async function dispatchWorkflow(root, { workflow, ref, inputs, confirm } = {}, override = {}) {
  if (confirm !== true) return { ok: false, error: "Dispatching a workflow must be confirmed." };
  const found = requireRepo(root, override);
  if (!found.ok) return found;
  const { cfg } = found;
  if (!cfg.token) return { ok: false, error: "A GitHub token is required to dispatch a workflow." };
  const id = workflow == null ? "" : String(workflow).trim();
  if (!id) return { ok: false, error: "Pick a workflow to run." };
  const hub = sync.hubTarget(root);
  const officialFile = (value) => {
    const file = String(value || "").replace(/\\/g, "/");
    if (/(^|\/)release\.yml$/i.test(file)) return "release";
    if (/(^|\/)test-build\.yml$/i.test(file)) return "test";
    return "";
  };
  const refuseOfficial = (value) => {
    if (hub.role !== "self") return null;
    const kind = officialFile(value);
    if (kind === "release") {
      return {
        ok: false,
        error:
          "Official Release stays on Friday Hub → Build & Release. Hub will not dispatch release.yml here.",
      };
    }
    if (kind === "test") {
      return {
        ok: false,
        error:
          "Test EXE Build stays on Friday Hub → Test build this branch. Hub will not dispatch test-build.yml here.",
      };
    }
    return null;
  };
  const blockedId = refuseOfficial(id);
  if (blockedId) return blockedId;
  const listed = await listWorkflows(root, override);
  const match = listed.ok
    ? (listed.workflows || []).find(
        (item) =>
          String(item.id) === id ||
          String(item.path) === id ||
          String(item.path).endsWith(`/${id}`) ||
          String(item.name) === id,
      )
    : null;
  if (match) {
    const blockedPath = refuseOfficial(match.path);
    if (blockedPath) return blockedPath;
  }
  const dispatchId = match ? String(match.id) : id;
  const target = String(ref || cfg.branch || "main");
  const res = await call(
    cfg,
    `/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(dispatchId)}/dispatches`,
    {
      method: "POST",
      body: {
        ref: target,
        ...(inputs && typeof inputs === "object" ? { inputs } : {}),
      },
    },
  );
  if (!res.ok) return res;
  return {
    ok: true,
    dispatched: true,
    workflow: dispatchId,
    ref: target,
    runsUrl: `https://github.com/${cfg.repo}/actions`,
  };
}

/**
 * Create a GitHub repository (user or org). Never silent. Does not push code.
 */
async function createRepository(
  root,
  { name, description, private: isPrivate, org, confirm } = {},
  override = {},
) {
  if (confirm !== true)
    return { ok: false, error: "Creating a GitHub repository must be confirmed." };
  const cfg = { ...sync.readConfig(root), ...override };
  if (!cfg.token) return { ok: false, error: "A GitHub token is required to create a repository." };
  const repoName = String(name || "")
    .trim()
    .replace(/\.git$/i, "");
  if (!/^[\w.-]{1,100}$/.test(repoName) || /^[.-]/.test(repoName)) {
    return {
      ok: false,
      error: "Repository name must be letters, numbers, dots, underscores or hyphens.",
    };
  }
  const orgName = String(org || "").trim();
  const endpoint = orgName ? `/orgs/${encodeURIComponent(orgName)}/repos` : "/user/repos";
  const res = await call(cfg, endpoint, {
    method: "POST",
    body: {
      name: repoName,
      description: String(description || "").slice(0, 350),
      private: isPrivate !== false,
      auto_init: false,
    },
  });
  if (!res.ok) return res;
  const full = res.body?.full_name || (orgName ? `${orgName}/${repoName}` : repoName);
  return {
    ok: true,
    repo: full,
    private: Boolean(res.body?.private),
    url: res.body?.html_url || `https://github.com/${full}`,
    cloneUrl: res.body?.clone_url || `https://github.com/${full}.git`,
    defaultBranch: res.body?.default_branch || "main",
  };
}

module.exports = {
  listReleases,
  listInstallerBundles,
  analyzeChanges,
  releaseStatus,
  dispatchRelease,
  dispatchTestBuild,
  releaseRuns,
  listWorkflows,
  dispatchWorkflow,
  createRepository,
  WORKFLOW,
  TEST_WORKFLOW,
};
