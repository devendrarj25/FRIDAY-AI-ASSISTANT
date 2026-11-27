/**
 * scripts/ci-publish-release.sh and the build record. The bundle (friday-bundle.json) is attached whenever it sits
 * beside friday-update.json, so FRIDAY Release and FRIDAY Test Build publish it without listing it by hand, and no
 * asset above the 2 GiB release limit is ever sent. Run against a stand-in `gh` on PATH: no network, no account.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasCommand } from "./helpers/environment";

const root = path.resolve(__dirname, "..", "..");
const PUBLISH = path.join(root, "scripts", "ci-publish-release.sh");
const tools = ["bash", "sha256sum", "awk", "wc"].every((c) => hasCommand(c));
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A `gh` that logs every call and reports each file given to `release create` as uploaded with the right digest. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-publish-bundle-"));
  temp.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const files = {
    setup: path.join(dir, "FRIDAY-Setup-1.2.3.4.exe"),
    manifest: path.join(dir, "friday-update.json"),
    bundle: path.join(dir, "friday-bundle.json"),
  };
  fs.writeFileSync(files.setup, "installer bytes");
  fs.writeFileSync(files.manifest, '{"version":"1.2.3.4"}');
  fs.writeFileSync(path.join(dir, "notes.md"), "notes");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
case "$*" in
  "release create"*)
    for a in "$@"; do [ -f "$a" ] && printf '%s\\t%s\\n' "$(basename "$a")" "sha256:$(sha256sum < "$a" | cut -d' ' -f1)" >> "${dir}/uploaded"; done
    echo 777 > "${dir}/draft"; exit 0 ;;
  "api repos/owner/repo/releases?per_page=100 --jq"*) [ -f "${dir}/draft" ] && cat "${dir}/draft"; exit 0 ;;
  "api repos/owner/repo/releases/777/assets?per_page=100 --jq"*)
    awk -F'\\t' '{ print $1 "\\t" $2 "\\t" NR }' "${dir}/uploaded"; exit 0 ;;
  "api -X DELETE"*) rm -f "${dir}/draft"; exit 0 ;;
  "api -X PATCH"*) exit 0 ;;
esac
echo "unexpected gh $*" >&2; exit 9
`,
    { mode: 0o755 },
  );
  return { dir, bin, files };
}

function run(s: ReturnType<typeof setup>, assets: string[]) {
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
      path.join(s.dir, "notes.md"),
      ...assets,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${s.bin}:${process.env["PATH"]}`,
        GITHUB_REPOSITORY: "owner/repo",
        GH_TOKEN: "t",
      },
    },
  );
  const calls = fs.existsSync(path.join(s.dir, "calls"))
    ? fs.readFileSync(path.join(s.dir, "calls"), "utf8")
    : "";
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

describe.skipIf(!tools)(
  "publishing carries the build record and refuses an oversized asset",
  () => {
    it("adds friday-bundle.json when it sits beside friday-update.json, once, and verifies it", () => {
      const s = setup();
      fs.writeFileSync(s.files.bundle, '{"schema":1}');
      const r = run(s, [s.files.setup, s.files.manifest]);
      expect(r.status, r.out).toBe(0);
      expect(r.calls.match(/friday-bundle\.json/g)?.length).toBe(1);
      expect(r.out).toContain(`verified friday-bundle.json ${sha(s.files.bundle)}`);
      // Listed by hand already: not attached twice.
      fs.rmSync(path.join(s.dir, "calls"));
      fs.rmSync(path.join(s.dir, "uploaded"));
      const again = run(s, [s.files.setup, s.files.bundle, s.files.manifest]);
      expect(again.status, again.out).toBe(0);
      expect(again.calls.match(/friday-bundle\.json/g)?.length).toBe(1);
    });

    it("publishes without it when the build wrote none", () => {
      const s = setup();
      const r = run(s, [s.files.setup, s.files.manifest]);
      expect(r.status, r.out).toBe(0);
      expect(r.calls).not.toContain("friday-bundle.json");
    });

    it("stops before any upload when an asset is larger than the release limit", () => {
      const s = setup();
      // A sparse file: 2147483649 bytes on paper, nothing on disk.
      fs.writeFileSync(s.files.bundle, "");
      fs.truncateSync(s.files.bundle, 2147483649);
      const r = run(s, [s.files.setup, s.files.manifest]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("friday-bundle.json is 2147483649 bytes");
      expect(r.out).toContain("2147483648");
      expect(r.calls).toBe("");
    });
  },
);
