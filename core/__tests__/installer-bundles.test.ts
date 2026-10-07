/**
 * listInstallerBundles splits Stable vs Test with github-sync.isTestRelease.
 * testConnection surfaces the existing public/private and token-needed errors.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const sync = require_(path.resolve(process.cwd(), "electron/github-sync.cjs"));
const release = require_(path.resolve(process.cwd(), "electron/github-release.cjs"));

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-bundles-"));
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

const RELEASES = [
  {
    tag_name: "v1.0.0.3",
    name: "FRIDAY 1.0.0.3",
    body: "stable notes",
    draft: false,
    prerelease: false,
    published_at: "2026-09-07T00:00:00Z",
    html_url: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/tag/v1.0.0.3",
    assets: [
      {
        name: "FRIDAY-Setup-1.0.0.3.exe",
        browser_download_url: "https://example.invalid/stable.exe",
        size: 42,
      },
    ],
  },
  {
    tag_name: "v1.0.0.3-test.1",
    name: "FRIDAY 1.0.0.3 TEST",
    body: "test notes",
    draft: false,
    prerelease: true,
    published_at: "2026-09-07T01:00:00Z",
    html_url: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/tag/v1.0.0.3-test.1",
    assets: [
      {
        name: "FRIDAY-Setup-1.0.0.3-test.1.exe",
        browser_download_url: "https://example.invalid/test.exe",
        size: 41,
      },
    ],
  },
];

describe("listInstallerBundles", () => {
  it("keeps stable and test installers on separate channels via isTestRelease", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", updateChannel: "stable" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/releases")) return json(RELEASES);
        return json({ message: "not used" }, 404);
      }),
    );

    expect(sync.isTestRelease(RELEASES[0])).toBe(false);
    expect(sync.isTestRelease(RELEASES[1])).toBe(true);

    const stable = await release.listInstallerBundles(root);
    expect(stable.ok).toBe(true);
    expect(stable.channel).toBe("stable");
    expect(stable.bundles).toHaveLength(1);
    expect(stable.bundles[0].testBuild).toBe(false);
    expect(stable.bundles[0].installer.name).toBe("FRIDAY-Setup-1.0.0.3.exe");

    const test = await release.listInstallerBundles(root, { updateChannel: "test" });
    expect(test.ok).toBe(true);
    expect(test.channel).toBe("test");
    expect(test.bundles).toHaveLength(1);
    expect(test.bundles[0].testBuild).toBe(true);
    expect(test.bundles[0].installer.name).toBe("FRIDAY-Setup-1.0.0.3-test.1.exe");
  });

  it("keeps the GitHub API asset URL on a private-style installer bundle", async () => {
    sync.writeConfig(root, { repo: "owner/secret", token: "ghp_x", updateChannel: "stable" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/releases")) {
          return json([
            {
              tag_name: "v1.0.0.3",
              name: "FRIDAY 1.0.0.3",
              body: "stable notes",
              draft: false,
              prerelease: false,
              published_at: "2026-09-07T00:00:00Z",
              html_url: "https://github.com/owner/secret/releases/tag/v1.0.0.3",
              assets: [
                {
                  id: 99,
                  name: "FRIDAY-Setup-1.0.0.3.exe",
                  url: "https://api.github.com/repos/owner/secret/releases/assets/99",
                  size: 42,
                },
              ],
            },
          ]);
        }
        return json({ message: "not used" }, 404);
      }),
    );
    const listed = await release.listInstallerBundles(root);
    expect(listed.ok).toBe(true);
    expect(listed.bundles[0].installer.apiUrl).toBe(
      "https://api.github.com/repos/owner/secret/releases/assets/99",
    );
    expect(listed.bundles[0].installer.id).toBe(99);
  });

  it("returns the real missing-repo error instead of an empty success", async () => {
    const listed = await release.listInstallerBundles(root);
    expect(listed.ok).toBe(false);
    expect(listed.error).toMatch(/No repository is connected/i);
  });
});

describe("testConnection", () => {
  it("reports a public repo without inventing write-side success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (
          String(url).includes("/repos/devendrarj25/FRIDAY-AI-ASSISTANT") &&
          !String(url).includes("/releases")
        ) {
          return json({
            full_name: "devendrarj25/FRIDAY-AI-ASSISTANT",
            private: false,
            default_branch: "main",
            pushed_at: "2026-09-04T00:00:00Z",
            permissions: { pull: true },
          });
        }
        return json({ message: "Not Found" }, 404);
      }),
    );
    const result = await sync.testConnection(root, {
      repo: "devendrarj25/FRIDAY-AI-ASSISTANT",
      token: "",
    });
    expect(result.ok).toBe(true);
    expect(result.private).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.canRelease).toBe(false);
    expect(String(result.warning)).toMatch(/Read-only/i);
  });

  it("uses github-sync's existing private-repo token message on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "Not Found" }, 404)),
    );
    const result = await sync.testConnection(root, { repo: "owner/private", token: "" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/add a token if it is private/i);
  });

  it("surfaces a rate-limit rejection without claiming the connection worked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "API rate limit exceeded" }, 403)),
    );
    const result = await sync.testConnection(root, {
      repo: "devendrarj25/FRIDAY-AI-ASSISTANT",
      token: "",
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/rate limit/i);
  });
});

describe("live public FRIDAY repo (network when available)", () => {
  it("never fakes a successful check", async () => {
    const result = await sync.testConnection(root, {
      repo: "devendrarj25/FRIDAY-AI-ASSISTANT",
      token: "",
    });
    if (result.ok) {
      expect(result.repo).toMatch(/friday/i);
      expect(result.private).toBe(false);
    } else {
      expect(String(result.error).length).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
    }
  }, 20000);
});

describe("connect session (public and private)", () => {
  const publicRepo = (url: string) =>
    String(url).includes("/repos/devendrarj25/FRIDAY-AI-ASSISTANT") &&
    !String(url).includes("/releases") &&
    !String(url).includes("/actions");

  beforeEach(async () => {
    sync.writeConfig(root, { repo: "" });
    await sync.connect(root);
  });

  it("normalizes a pasted github.com URL before calling /repos", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (publicRepo(String(url))) {
        return json({
          full_name: "devendrarj25/FRIDAY-AI-ASSISTANT",
          private: false,
          default_branch: "main",
          permissions: { pull: true },
        });
      }
      return json({ message: "Not Found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await sync.testConnection(root, {
      repo: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.git",
      token: "",
    });
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/repos/devendrarj25/FRIDAY-AI-ASSISTANT",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("https://github.com");
  });

  it("connects a public repo without a token and keeps CONNECTED across reconnect", async () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (publicRepo(String(url))) {
          return json({
            full_name: "devendrarj25/FRIDAY-AI-ASSISTANT",
            private: false,
            default_branch: "main",
            permissions: { pull: true },
          });
        }
        return json({ message: "Not Found" }, 404);
      }),
    );
    const first = await sync.connect(root);
    expect(first.state).toBe("connected");
    expect(first.hasToken).toBe(false);
    expect(first.private).toBe(false);
    const again = await sync.connect(root);
    expect(again.state).toBe("connected");
    expect(sync.connection().state).toBe("connected");
    expect(sync.connection().hasToken).toBe(false);
  });

  it("does not keep private: true after a later public connect", async () => {
    sync.writeConfig(root, { repo: "owner/secret", token: "ghp_x" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/actions/workflows")) return json({ name: "release.yml" });
        if (String(url).includes("/repos/owner/secret")) {
          return json({
            full_name: "owner/secret",
            private: true,
            default_branch: "main",
            permissions: { push: true, admin: true },
          });
        }
        if (publicRepo(String(url))) {
          return json({
            full_name: "devendrarj25/FRIDAY-AI-ASSISTANT",
            private: false,
            default_branch: "main",
            permissions: { pull: true },
          });
        }
        return json({ message: "Not Found" }, 404);
      }),
    );
    const priv = await sync.connect(root);
    expect(priv.state).toBe("connected");
    expect(priv.private).toBe(true);
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "" });
    const pub = await sync.connect(root);
    expect(pub.state).toBe("connected");
    expect(pub.private).toBe(false);
    expect(pub.hasToken).toBe(false);
  });

  it("marks a 404 without a token as reauth-required with the real error", async () => {
    sync.writeConfig(root, { repo: "owner/private" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "Not Found" }, 404)),
    );
    const result = await sync.connect(root);
    expect(result.state).toBe("reauth-required");
    expect(result.hasToken).toBe(false);
    expect(String(result.message)).toMatch(/add a token if it is private/i);
  });

  it("connects a private repo when a token is stored", async () => {
    sync.writeConfig(root, { repo: "owner/secret", token: "ghp_private" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/actions/workflows")) return json({ name: "release.yml" });
        if (String(url).includes("/repos/owner/secret")) {
          return json({
            full_name: "owner/secret",
            private: true,
            default_branch: "main",
            permissions: { push: true, admin: true },
          });
        }
        return json({ message: "Not Found" }, 404);
      }),
    );
    const result = await sync.connect(root);
    expect(result.state).toBe("connected");
    expect(result.hasToken).toBe(true);
    expect(result.private).toBe(true);
    expect(sync.connection().state).toBe("connected");
  });
});
