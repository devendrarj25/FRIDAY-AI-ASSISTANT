/**
 * Friday Hub command center: multi-repo connections, create-repo confirm,
 * working-tree file gates, and a real second git repo (local bare remote).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const sync = require_(path.resolve(process.cwd(), "electron/github-sync.cjs"));
const release = require_(path.resolve(process.cwd(), "electron/github-release.cjs"));
const dev = require_(path.resolve(process.cwd(), "electron/dev-workflow.cjs"));

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hub-cc-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubRepo(fullName: string, extra: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const href = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (method === "POST" && href.endsWith("/user/repos")) {
        const body = JSON.parse(String(init?.body || "{}"));
        return json(
          {
            full_name: `tester/${body.name}`,
            private: Boolean(body.private),
            html_url: `https://github.com/tester/${body.name}`,
            clone_url: `https://github.com/tester/${body.name}.git`,
            default_branch: "main",
          },
          201,
        );
      }
      if (method === "POST" && href.includes("/dispatches")) {
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && href.endsWith("/pulls")) {
        const body = JSON.parse(String(init?.body || "{}"));
        return json(
          {
            number: 7,
            html_url: `https://github.com/${fullName}/pull/7`,
            state: "open",
            title: body.title,
          },
          201,
        );
      }
      if (href.includes(`/repos/${fullName}`) && href.includes("/pulls") && method === "GET") {
        return json([]);
      }
      if (
        href.includes(`/repos/${fullName}`) &&
        !href.includes("/actions") &&
        !href.includes("/pulls")
      ) {
        return json({
          full_name: fullName,
          private: Boolean(extra["private"]),
          default_branch: "main",
          pushed_at: "2026-09-07T00:00:00Z",
          permissions: extra["permissions"] || { pull: true },
        });
      }
      if (href.includes("/actions/workflows") && method === "GET") {
        return json({
          workflows: [{ id: 11, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
        });
      }
      return json({ message: "Not Found" }, 404);
    }),
  );
}

async function gitIdent(dir: string) {
  await dev.git(["config", "user.name", "Devendra Singh Meena"], dir);
  await dev.git(["config", "user.email", "devendrarj25@users.noreply.github.com"], dir);
}

async function initGit(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  await dev.git(["init", "-b", "main"], dir);
  await gitIdent(dir);
  await dev.git(["add", "-A"], dir);
  const committed = await dev.git(["commit", "-m", "init"], dir);
  expect(committed.ok).toBe(true);
}

describe("Hub multi-repo connections", () => {
  it("always lists FRIDAY's own repo as self and cannot remove it", () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    const listed = sync.listConnections(root);
    expect(listed.ok).toBe(true);
    expect(listed.selectedId).toBe("self");
    expect(listed.connections[0].id).toBe("self");
    expect(listed.connections[0].role).toBe("self");
    expect(listed.connections[0].label).toMatch(/FRIDAY/i);
    expect(listed.connections[0].hasToken).toBe(true);
    const removed = sync.removeConnection(root, "self");
    expect(removed.ok).toBe(false);
    expect(sync.readConfig(root).token).toBe("ghp_self");
  });

  it("keeps Updates repo/token when an extra Hub repo is added", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    stubRepo("acme/notes");
    const added = await sync.addConnection(root, { repo: "acme/notes", token: "ghp_extra" });
    expect(added.ok).toBe(true);
    expect(added.id).not.toBe("self");
    expect(sync.readConfig(root).repo).toBe("devendrarj25/FRIDAY-AI-ASSISTANT");
    expect(sync.readConfig(root).token).toBe("ghp_self");
    const shown = sync.publicConfig(sync.readConfig(root));
    expect(shown.connections).toBeUndefined();
    expect(shown.selectedConnectionId).toBeUndefined();
    expect(shown.selfPrivate).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain("ghp_");
    const listed = sync.listConnections(root);
    const extra = listed.connections.find((c: { role: string }) => c.role === "linked");
    expect(extra.hasToken).toBe(true);
    expect(extra).not.toHaveProperty("token");
    const target = sync.hubTarget(root);
    expect(target.role).toBe("linked");
    expect(target.repo).toBe("acme/notes");
    expect(target.token).toBe("ghp_extra");
    expect(target.dir.replace(/\\/g, "/")).toContain("temporary/sessions/hub-repos");
  });

  it("selects self when the extra URL is FRIDAY's own repo, without replacing the Updates token", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    const added = await sync.addConnection(root, {
      repo: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT",
      token: "ghp_should_not_overwrite",
    });
    expect(added.ok).toBe(true);
    expect(added.id).toBe("self");
    expect(added.reused).toBe(true);
    expect(sync.readConfig(root).token).toBe("ghp_self");
  });

  it("uses the existing private-repo 404 message when an extra repo has no token", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "Not Found" }, 404)),
    );
    const added = await sync.addConnection(root, { repo: "owner/private" });
    expect(added.ok).toBe(false);
    expect(String(added.error)).toMatch(/add a token if it is private/i);
    expect(sync.readConfig(root).token).toBe("ghp_self");
  });

  it("preserves Hub connections when Updates only patches repo", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT" });
    stubRepo("acme/notes");
    await sync.addConnection(root, { repo: "acme/notes" });
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", branch: "main" });
    const listed = sync.listConnections(root);
    expect(listed.connections.some((c: { repo: string }) => c.repo === "acme/notes")).toBe(true);
  });

  it("treats FRIDAY's own repo as self even when the URL case or SSH form differs", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    const pasted = await sync.addConnection(root, {
      repo: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/tree/main",
      token: "ghp_should_not_overwrite",
    });
    expect(pasted.ok).toBe(true);
    expect(pasted.id).toBe("self");
    expect(sync.readConfig(root).token).toBe("ghp_self");
    const ssh = await sync.addConnection(root, {
      repo: "git@github.com:devendrarj25/FRIDAY-AI-ASSISTANT.git",
    });
    expect(ssh.id).toBe("self");
    expect(
      sync.sameRepo("git@github.com:acme/notes.git", "https://www.github.com/acme/notes/tree/main"),
    ).toBe(true);
  });

  it("records live private/public after Test connection", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    stubRepo("acme/notes", { private: true });
    const added = await sync.addConnection(root, { repo: "acme/notes" });
    expect(added.ok).toBe(true);
    const cfgPath = path.join(root, "config", "github.json");
    const stored = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    stored.connections[0].private = false;
    fs.writeFileSync(cfgPath, JSON.stringify(stored, null, 2));
    const tested = await sync.testHubConnection(root, stored.connections[0].id);
    expect(tested.ok).toBe(true);
    const extra = sync
      .listConnections(root)
      .connections.find((c: { role: string }) => c.role === "linked");
    expect(extra.private).toBe(true);
    expect(extra.visibility).toBe("private");
    const selfBefore = sync.listConnections(root).connections[0];
    expect(selfBefore.visibility).toBe("unknown");
    stubRepo("devendrarj25/FRIDAY-AI-ASSISTANT", { private: true });
    const selfTest = await sync.testHubConnection(root, "self");
    expect(selfTest.ok).toBe(true);
    expect(sync.listConnections(root).connections[0].visibility).toBe("private");
    expect(sync.publicConfig(sync.readConfig(root)).selfPrivate).toBeUndefined();
  });
});

describe("create-repo and workflow dispatch", () => {
  it("refuses create and dispatch without confirm", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    const created = await release.createRepository(root, { name: "scratch" });
    expect(created.ok).toBe(false);
    expect(String(created.error)).toMatch(/confirmed/i);
    const dispatched = await release.dispatchWorkflow(root, { workflow: "ci.yml" });
    expect(dispatched.ok).toBe(false);
    expect(String(dispatched.error)).toMatch(/confirmed/i);
  });

  it("creates a repo through github-release call() and lists workflows", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    stubRepo("tester/scratch");
    const created = await release.createRepository(root, {
      name: "scratch",
      confirm: true,
      private: true,
    });
    expect(created.ok).toBe(true);
    expect(created.repo).toBe("tester/scratch");
    expect(created.private).toBe(true);
    const listed = await release.listWorkflows(root, {
      repo: "tester/scratch",
      token: "ghp_self",
    });
    expect(listed.ok).toBe(true);
    expect(listed.workflows[0].path).toBe(".github/workflows/ci.yml");
    const ran = await release.dispatchWorkflow(
      root,
      { workflow: "ci.yml", confirm: true, ref: "main" },
      { repo: "tester/scratch", token: "ghp_self" },
    );
    expect(ran.ok).toBe(true);
    expect(ran.dispatched).toBe(true);
  });

  it("refuses to dispatch FRIDAY's official release.yml from Hub when self is selected", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    stubRepo("devendrarj25/FRIDAY-AI-ASSISTANT");
    const ran = await release.dispatchWorkflow(root, {
      workflow: "release.yml",
      confirm: true,
      ref: "main",
    });
    expect(ran.ok).toBe(false);
    expect(String(ran.error)).toMatch(/Build & Release/i);
    const testBuild = await release.dispatchWorkflow(root, {
      workflow: "test-build.yml",
      confirm: true,
    });
    expect(testBuild.ok).toBe(false);
    expect(String(testBuild.error)).toMatch(/Test build this branch/i);
  });
});

describe("working-tree file gates", () => {
  it("refuses writes and commits without confirm, and blocks path escape", async () => {
    const dir = path.join(root, "checkout");
    await initGit(dir, { "README.md": "hello\n" });
    const unconfirmed = await dev.writeWorkingFile(root, {
      dir,
      file: "README.md",
      content: "nope",
    });
    expect(unconfirmed.ok).toBe(false);
    const escaped = await dev.writeWorkingFile(root, {
      dir,
      file: "../outside.txt",
      content: "nope",
      confirm: true,
    });
    expect(escaped.ok).toBe(false);
    const committed = await dev.commitWorkingTree(root, { dir, message: "x" });
    expect(committed.ok).toBe(false);
    expect(String(committed.error)).toMatch(/confirmed/i);
  });

  it("writes inside the checkout then commits on a feature branch", async () => {
    const dir = path.join(root, "checkout");
    await initGit(dir, { "README.md": "hello\n" });
    const branched = await dev.createBranch(root, { dir, name: "notes", kind: "feature" });
    expect(branched.ok).toBe(true);
    const written = await dev.writeWorkingFile(root, {
      dir,
      file: "notes.txt",
      content: "from hub\n",
      confirm: true,
    });
    expect(written.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("from hub\n");
    const committed = await dev.commitWorkingTree(root, {
      dir,
      message: "add notes",
      confirm: true,
    });
    expect(committed.ok).toBe(true);
    expect(committed.empty).toBe(false);
  });

  it("packages a folder into a linked checkout and refuses FRIDAY's own tree", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT" });
    const rel = "temporary/sessions/hub-repos/repo_pack-acme-pack";
    const dest = path.join(root, rel);
    fs.mkdirSync(dest, { recursive: true });
    sync.writeConfig(root, {
      connections: [
        {
          id: "repo_pack",
          repo: "acme/pack",
          label: "pack",
          defaultBranch: "main",
          localPath: rel,
        },
      ],
      selectedConnectionId: "repo_pack",
    });
    const folder = path.join(root, "incoming");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "app.txt"), "pack me\n");
    const refused = await dev.bootstrapFromSource(root, { folder, zip: null });
    expect(refused.ok).toBe(false);
    const self = await dev.bootstrapFromSource(root, { dir: root, folder, confirm: true });
    expect(self.ok).toBe(false);
    const packed = await dev.bootstrapFromSource(root, { folder, confirm: true });
    expect(packed.ok).toBe(true);
    expect(packed.committed).toBe(true);
    expect(packed.pushed).toBe(false);
    expect(fs.existsSync(path.join(dest, "app.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dest, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
  });
});

describe("real second repo: branch, edit, validate, push, open PR", () => {
  it("operates against a linked checkout, not FRIDAY's Updates repo", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_self" });
    const credentials = require_(path.resolve(process.cwd(), "electron/credentials.cjs"));
    const remote = path.join(root, "remotes", "scratch.git");
    fs.mkdirSync(remote, { recursive: true });
    const bare = await dev.git(["init", "--bare", "-b", "main"], remote);
    expect(bare.ok).toBe(true);

    const rel = "temporary/sessions/hub-repos/repo_scratch-acme-scratch";
    const checkout = path.join(root, rel);
    await initGit(checkout, {
      "README.md": "scratch\n",
      "package.json": JSON.stringify({
        name: "scratch",
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
    });
    await dev.git(["remote", "add", "origin", remote], checkout);
    const seeded = await dev.git(["push", "-u", "origin", "HEAD:main"], checkout);
    expect(seeded.ok).toBe(true);

    sync.writeConfig(root, {
      connections: [
        {
          id: "repo_scratch",
          repo: "acme/scratch",
          label: "scratch",
          defaultBranch: "main",
          localPath: rel,
        },
      ],
      selectedConnectionId: "repo_scratch",
    });
    credentials.setSecret(root, sync.connectionTokenId("repo_scratch"), "ghp_linked");

    const target = sync.hubTarget(root);
    expect(target.role).toBe("linked");
    expect(target.repo).toBe("acme/scratch");
    expect(sync.readConfig(root).repo).toBe("devendrarj25/FRIDAY-AI-ASSISTANT");

    const space = await dev.workspace(root, target.dir);
    expect(space.hubRole).toBe("linked");
    expect(space.connectedRepo).toBe("acme/scratch");

    const branched = await dev.createBranch(root, {
      dir: target.dir,
      name: "hub-demo",
      kind: "feature",
    });
    expect(branched.ok).toBe(true);
    expect(branched.branch).toBe("feature/hub-demo");

    const written = await dev.writeWorkingFile(root, {
      dir: target.dir,
      file: "hello.txt",
      content: "second repo\n",
      confirm: true,
    });
    expect(written.ok).toBe(true);

    const validated = await dev.validate(root, { dir: target.dir, steps: ["test"] });
    expect(validated.ok).toBe(true);
    expect(
      validated.results.some(
        (s: { id: string; state: string }) => s.id === "test" && s.state === "passed",
      ),
    ).toBe(true);

    const committed = await dev.commitWorkingTree(root, {
      dir: target.dir,
      message: "hub demo",
      confirm: true,
    });
    expect(committed.ok).toBe(true);

    const pushed = await dev.git(["push", "-u", "origin", "HEAD:feature/hub-demo"], target.dir);
    expect(pushed.ok).toBe(true);

    const remoteBranches = await dev.git(["branch", "--list", "feature/hub-demo"], remote);
    expect(remoteBranches.ok).toBe(true);
    expect(remoteBranches.out).toMatch(/feature\/hub-demo/);

    stubRepo("acme/scratch");
    const pr = await dev.openPullRequest(root, {
      branch: "feature/hub-demo",
      title: "Hub demo",
      confirm: true,
    });
    expect(pr.ok).toBe(true);
    expect(pr.number).toBe(7);
    expect(pr.url).toContain("/pull/7");

    const silent = await dev.publishBranch(root, {
      dir: target.dir,
      message: "x",
    });
    expect(silent.ok).toBe(false);
    expect(String(silent.error)).toMatch(/confirmed/i);
  });
});

describe("Hub de-duplication", () => {
  it("does not duplicate Updates self-check or merge capability Clone from GitHub", () => {
    const hubPage = read("src/routes/hub.tsx");
    expect(hubPage).toContain("Clone &amp; inspect");
    expect(hubPage).toContain("hub.inspectGithub");
    expect(hubPage).toContain("Bring in a capability");
    expect(hubPage).toContain("RepoSwitch");
    expect(hubPage).toContain("ReleaseControls");
    expect(hubPage).not.toContain("githubCheck");
    expect(hubPage).not.toContain("checkForUpdates");
    expect(hubPage).not.toContain("checkAllUpdates");
    expect(read("src/lib/friday/hub-chat.ts")).not.toContain("githubCheck");
    expect(read("src/lib/friday/hub-chat.ts")).not.toContain("checkForUpdates");
    expect(read("src/components/friday/hub/HubChat.tsx")).not.toContain("githubCheck");
    expect(read("src/components/friday/settings/GithubUpdates.tsx")).toContain("githubCheck()");
    const main = read("electron/main.cjs");
    const push = main.slice(
      main.indexOf('ipcMain.handle("github:push-source"'),
      main.indexOf('ipcMain.handle("github:push-and-sync"'),
    );
    expect(push).toContain("githubPush.pushSource");
    expect(push).not.toContain("hubDir()");
    expect(main).toContain("hubDir()");
    expect(read("electron/github-push.cjs")).toContain("sync.readConfig(root)");
  });

  it("keeps write confirms on new Hub GitHub actions", () => {
    expect(read("electron/github-release.cjs")).toContain(
      "Creating a GitHub repository must be confirmed.",
    );
    expect(read("electron/github-release.cjs")).toContain(
      "Dispatching a workflow must be confirmed.",
    );
    expect(read("electron/github-release.cjs")).toContain(
      "Hub will not dispatch release.yml here.",
    );
    expect(read("electron/dev-workflow.cjs")).toContain(
      "Opening a pull request must be confirmed.",
    );
    expect(read("electron/dev-workflow.cjs")).toContain("Writing a file must be confirmed.");
  });
});
