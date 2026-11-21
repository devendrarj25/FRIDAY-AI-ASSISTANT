/**
 * Draft-first publishing and the credential the workflows keep away from the repository's own code.
 *
 * scripts/ci-publish-release.sh (FRIDAY Release and FRIDAY Test Build) creates the release as a draft, checks every
 * uploaded asset's SHA-256 against the built file, and only then publishes it; a mismatch deletes the draft.
 * scripts/ci-git.sh gives one git network command the workflow token on its command line only. Both run here
 * against a stand-in `gh` and `git` on PATH, so no network and no GitHub account is needed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasCommand } from "./helpers/environment";

const root = path.resolve(__dirname, "..", "..");
const PUBLISH = path.join(root, "scripts", "ci-publish-release.sh");
const GIT = path.join(root, "scripts", "ci-git.sh");
const tools = ["bash", "jq", "sha256sum", "awk", "base64"].every((c) => hasCommand(c));
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake `gh` that answers the calls the script makes and logs every call. */
function fakeGh(
  dir: string,
  assets: { name: string; digest: string; id: number }[],
  drafts: number[],
) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(assets));
  fs.writeFileSync(path.join(dir, "drafts"), drafts.map((id) => `${id}\n`).join(""));
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
case "$*" in
  "release create"*) echo 777 >> "${dir}/drafts"; exit 0 ;;
  "api repos/owner/repo/releases?per_page=100 --jq"*) grep -v '^$' "${dir}/drafts" || true; exit 0 ;;
  "api repos/owner/repo/releases/777/assets?per_page=100 --jq"*)
    jq -r '.[] | [.name, .digest, (.id | tostring)] | @tsv' "${dir}/assets.json"; exit 0 ;;
  "api -H Accept: application/octet-stream repos/owner/repo/releases/assets/"*) cat "${dir}/served"; exit 0 ;;
  "api -X DELETE repos/owner/repo/releases/"*)
    last="\${@: -1}"; id="\${last##*/}"; grep -vx "$id" "${dir}/drafts" > "${dir}/drafts.next" || true; mv "${dir}/drafts.next" "${dir}/drafts"; exit 0 ;;
  "api -X PATCH"*) exit 0 ;;
esac
echo "unexpected gh $*" >&2; exit 9
`,
    { mode: 0o755 },
  );
  return bin;
}

function setup(drafts: number[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-publish-"));
  temp.push(dir);
  const setupExe = path.join(dir, "FRIDAY-Setup-1.2.3.4.exe");
  const manifest = path.join(dir, "friday-update.json");
  fs.writeFileSync(setupExe, "installer bytes");
  fs.writeFileSync(manifest, '{"version":"1.2.3.4"}');
  fs.writeFileSync(path.join(dir, "notes.md"), "notes");
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return { dir, setupExe, manifest, sha, drafts };
}

function run(
  dir: string,
  bin: string,
  files: string[],
  extra: string[] = [],
): { status: number | null; out: string; calls: string } {
  const r = spawnSync(
    "bash",
    [
      PUBLISH,
      "--tag",
      "v1.2.3.4",
      "--target",
      "abc123",
      "--title",
      "FRIDAY v1.2.3.4",
      "--notes-file",
      path.join(dir, "notes.md"),
      ...extra,
      ...files,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"]}`,
        GITHUB_REPOSITORY: "owner/repo",
        GH_TOKEN: "t",
      },
    },
  );
  const calls = fs.existsSync(path.join(dir, "calls"))
    ? fs.readFileSync(path.join(dir, "calls"), "utf8")
    : "";
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

describe.skipIf(!tools)("draft-first release publishing", () => {
  it("creates a draft, verifies every asset against the built file, then publishes it as latest", () => {
    const s = setup();
    const bin = fakeGh(
      s.dir,
      [
        { name: "FRIDAY-Setup-1.2.3.4.exe", digest: `sha256:${s.sha(s.setupExe)}`, id: 1 },
        { name: "friday-update.json", digest: `sha256:${s.sha(s.manifest)}`, id: 2 },
      ],
      [],
    );
    const r = run(s.dir, bin, [s.setupExe, s.manifest]);
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain("release create v1.2.3.4 --draft --target abc123");
    expect(r.calls).not.toContain("--prerelease");
    expect(r.calls).toContain(
      "api -X PATCH repos/owner/repo/releases/777 -F draft=false -f make_latest=true",
    );
    expect(r.calls).not.toContain("-X DELETE");
    // The draft is published only after every asset was checked.
    expect(r.calls.indexOf("releases/777/assets")).toBeLessThan(r.calls.indexOf("-X PATCH"));
    expect(r.out).toContain("verified FRIDAY-Setup-1.2.3.4.exe");
  });

  it("hashes a file whose path holds a backslash correctly (a Windows path in Git Bash)", () => {
    // PR Validation on windows-latest: sha256sum printed "\\<hash>" for such a path and every asset looked changed.
    const s = setup();
    const folder = path.join(s.dir, "release\\x64");
    fs.mkdirSync(folder);
    const odd = path.join(folder, "FRIDAY-Setup-1.2.3.4.exe");
    fs.writeFileSync(odd, "installer bytes");
    const bin = fakeGh(
      s.dir,
      [{ name: path.basename(odd), digest: `sha256:${s.sha(odd)}`, id: 1 }],
      [],
    );
    const r = run(s.dir, bin, [odd]);
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain("-F draft=false -f make_latest=true");
  });

  it("deletes the draft and publishes nothing when an uploaded asset is not the built file", () => {
    const s = setup();
    const bin = fakeGh(
      s.dir,
      [
        { name: "FRIDAY-Setup-1.2.3.4.exe", digest: `sha256:${"0".repeat(64)}`, id: 1 },
        { name: "friday-update.json", digest: `sha256:${s.sha(s.manifest)}`, id: 2 },
      ],
      [],
    );
    const r = run(s.dir, bin, [s.setupExe, s.manifest]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("is not the built file");
    expect(r.calls).toContain("api -X DELETE repos/owner/repo/releases/777");
    expect(r.calls).not.toContain("-X PATCH");
  });

  it("deletes the draft when an asset is missing from it", () => {
    const s = setup();
    const bin = fakeGh(
      s.dir,
      [{ name: "FRIDAY-Setup-1.2.3.4.exe", digest: `sha256:${s.sha(s.setupExe)}`, id: 1 }],
      [],
    );
    const r = run(s.dir, bin, [s.setupExe, s.manifest]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("friday-update.json was not uploaded");
    expect(r.calls).not.toContain("-X PATCH");
  });

  it("reads an asset back when the API gives no digest, removes a draft a cancelled run left, and keeps a prerelease off latest", () => {
    const s = setup([555]);
    fs.writeFileSync(path.join(s.dir, "served"), fs.readFileSync(s.setupExe));
    const bin = fakeGh(s.dir, [{ name: "FRIDAY-Setup-1.2.3.4.exe", digest: "", id: 41 }], [555]);
    const r = run(s.dir, bin, [s.setupExe], ["--prerelease"]);
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain("api -X DELETE repos/owner/repo/releases/555");
    expect(r.calls).toContain(
      "release create v1.2.3.4 --draft --target abc123 --title FRIDAY v1.2.3.4",
    );
    expect(r.calls).toContain("--prerelease");
    expect(r.calls).toContain("repos/owner/repo/releases/assets/41");
    expect(r.calls).toContain("-F draft=false -f make_latest=false");
  });

  it("refuses to start without its arguments or with a missing asset", () => {
    const s = setup();
    const bin = fakeGh(s.dir, [], []);
    expect(run(s.dir, bin, []).status).toBe(1);
    const missing = run(s.dir, bin, [path.join(s.dir, "nope.exe")]);
    expect(missing.status).toBe(1);
    expect(missing.out).toContain("does not exist");
    expect(missing.calls).toBe("");
  });
});

describe.skipIf(!tools)("one git network command with the token, nothing left behind", () => {
  function fakeGit() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-git-"));
    temp.push(dir);
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args"\n`,
      { mode: 0o755 },
    );
    return { dir, bin };
  }

  it("passes the token as a one-command header and runs plain git without one", () => {
    const g = fakeGit();
    const env = {
      ...process.env,
      PATH: `${g.bin}:${process.env["PATH"]}`,
      GITHUB_SERVER_URL: "https://github.com",
    };
    execFileSync("bash", [GIT, "push", "origin", "HEAD:refs/heads/x"], {
      env: { ...env, GH_TOKEN: "secret" },
    });
    const args = fs.readFileSync(path.join(g.dir, "args"), "utf8").trim().split("\n");
    const header = Buffer.from("x-access-token:secret").toString("base64");
    expect(args).toEqual([
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${header}`,
      "push",
      "origin",
      "HEAD:refs/heads/x",
    ]);
    const plain = Object.fromEntries(
      Object.entries(env).filter(([key]) => key !== "GH_TOKEN" && key !== "GITHUB_TOKEN"),
    );
    execFileSync("bash", [GIT, "fetch", "origin", "main"], { env: plain });
    expect(fs.readFileSync(path.join(g.dir, "args"), "utf8").trim().split("\n")).toEqual([
      "fetch",
      "origin",
      "main",
    ]);
  });
});

describe("the workflows keep the write credential away from the code they build", () => {
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
  const jobText = (file: string, job: string) => {
    const src = read(file);
    const at = src.indexOf(`\n  ${job}:\n`);
    const next = src.slice(at + 1).search(/\n {2}[a-z-]+:\n/);
    return src.slice(at, next < 0 ? undefined : at + 1 + next);
  };
  const DROP = "name: Remove the checkout credential before";

  it.each([
    [".github/workflows/release.yml", "prepare", /\n\s+run: npm ci\n/],
    [".github/workflows/release.yml", "publish", /\n\s+run: npm ci\n/],
    [".github/workflows/test-build.yml", "test-build", /name: Node toolchain/],
    [".github/workflows/pr-validation.yml", "static", /\n\s+run: npm ci\n/],
    [".github/workflows/pr-validation.yml", "docs-only", /\n\s+run: npm ci\n/],
  ])(
    "%s %s removes the credential before its code runs and authenticates later git calls itself",
    (file, job, code) => {
      const text = jobText(file, job);
      const drop = text.indexOf(DROP);
      expect(drop, `${file} ${job}`).toBeGreaterThan(-1);
      expect(text.search(code), `${file} ${job}`).toBeGreaterThan(drop);
      const after = text
        .slice(drop)
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(after, `${file} ${job}`).not.toMatch(/(^|[^\w/.-])git (fetch|push|ls-remote|pull)\b/);
    },
  );

  it("publishes an official release and a TEST prerelease only through the draft-first script", () => {
    for (const file of [".github/workflows/release.yml", ".github/workflows/test-build.yml"]) {
      const code = read(file)
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(code, file).toContain("bash scripts/ci-publish-release.sh");
      expect(code, file).not.toContain("gh release create");
    }
    expect(read(".github/workflows/test-build.yml")).toMatch(
      /ci-publish-release\.sh[\s\S]{0,200}--prerelease/,
    );
  });

  it("does not mistake a draft left by a cancelled run for a published release", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).not.toMatch(/gh release view "\$tag" >\/dev\/null/);
    expect(
      release.match(
        /gh release view "\$tag" --json isDraft --jq '\.isDraft' 2>\/dev\/null\)" = "false"/g,
      ),
    ).toHaveLength(3);
    // A rebuild under immutable releases says what to do instead of failing silently.
    expect(release).toContain("immutable releases forbid it");
  });

  it("never packs the CI helpers into the EXE", () => {
    const builder = read("electron-builder.yml");
    for (const helper of ["ci-delete-branch.sh", "ci-publish-release.sh", "ci-git.sh"]) {
      expect(builder).toContain(`- "!${helper}"`);
    }
  });
});
