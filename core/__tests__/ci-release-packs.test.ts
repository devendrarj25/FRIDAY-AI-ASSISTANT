/**
 * FRIDAY Release, step "Publish missing weight packs": the step's own bash is run against a stand-in `gh`, `df`,
 * `python` and a stand-in pack builder. No network, no account, no weights. It proves the rules the owner set: a pack
 * tag that already has a release is never touched, a missing one is built one model at a time into a work folder
 * outside the checkout that is emptied after each model, every upload is checked against the built file before the
 * draft is published, the published pack is never "Latest", and a low disk or a bad upload stops with the draft deleted.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { load as parseYaml } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { hasCommand } from "./helpers/environment";

const root = path.resolve(__dirname, "..", "..");
const STEP = "Publish missing weight packs";
const tools = ["bash", "node", "sha256sum", "awk", "wc", "cut"].every((c) => hasCommand(c));
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const require_ = createRequire(import.meta.url);

type Pack = {
  id: string;
  tag: string;
  title: string;
  models: { id: string; bytes: number; ct2: boolean }[];
};

/** The packs and their models, read the way the step reads them. */
function plan(): Pack[] {
  const builder = require_(path.join(root, "scripts", "build-friday-models.cjs"));
  const whole = builder.readManifest();
  const sources = {
    helperJobs: require_(path.join(root, "electron", "voice-weights.cjs")).pinnedJobs(),
    core: builder.readCore(),
  };
  return builder.packsOf(whole).map((p: { id: string }) => {
    const manifest = builder.packManifest(whole, p.id, sources);
    return {
      id: p.id,
      tag: manifest.tag,
      title: manifest.title,
      models: builder.modelsOf(manifest).map((m: { fridayId: string; assets: any[] }) => ({
        id: m.fridayId,
        bytes: m.assets.reduce((n, a) => n + a.bytes, 0),
        ct2: m.assets.some((a) => a.from?.recipe === "ct2-int8"),
      })),
    };
  });
}

function stepScript(): string {
  const doc = parseYaml(
    fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"),
  ) as any;
  const found = (doc.jobs.publish.steps as any[]).find((s) => s.name === STEP);
  if (!found) throw new Error(`release.yml publish job has no step "${STEP}"`);
  return String(found.run);
}

const GH = `#!/usr/bin/env bash
d="__DIR__"
echo "$*" >> "$d/calls"
has() { grep -qxF -- "$1" "$d/$2" 2>/dev/null; }
case "$*" in
  "release view "*)
    if [ -f "$d/view-error" ]; then echo "HTTP 502: bad gateway" >&2; exit 1; fi
    if has "$3" draftview && [ ! -f "$d/patches" ]; then echo true; exit 0; fi
    if [ -f "$d/readback-error" ] && has "$3" published && [ -f "$d/patches" ]; then echo "HTTP 502: bad gateway" >&2; exit 1; fi
    has "$3" published && { echo false; exit 0; }
    echo "release not found" >&2; exit 1 ;;
  "api repos/owner/repo/git/ref/tags/"*)
    if [ -f "$d/ref-error" ]; then echo "HTTP 403: rate limit" >&2; exit 1; fi
    has "\${2#repos/owner/repo/git/ref/tags/}" tagrefs && exit 0; echo "Not Found" >&2; exit 1 ;;
  "api --paginate repos/owner/repo/releases?per_page=100 --jq"*) [ -f "$d/draft" ] && echo 777; exit 0 ;;
  "api -X POST repos/owner/repo/releases "*)
    all="$*"; t="\${all#*tag_name=}"; echo "\${t%% *}" > "$d/draft-tag"; echo 777 > "$d/draft"; echo 777; exit 0 ;;
  "release upload "*)
    for a in "\${@:4}"; do
      [ -f "$a" ] || continue
      KEEP_HOOK
      digest="sha256:$(sha256sum < "$a" | cut -d' ' -f1)"
      [ -f "$d/corrupt" ] && digest="sha256:0000"
      printf '%s\\t%s\\t%s\\n' "$(basename "$a")" "$digest" "$(wc -l 2>/dev/null < "$d/uploaded" || echo 0)" >> "$d/uploaded"
    done
    exit 0 ;;
  "api --paginate repos/owner/repo/releases/777/assets?per_page=100 --jq"*) cat "$d/uploaded" 2>/dev/null; exit 0 ;;
  "api repos/owner/repo/releases/777 --jq .draft"*) if [ -f "$d/draft" ]; then echo true; else echo false; fi; exit 0 ;;
  "api -X DELETE repos/owner/repo/releases/777"*) rm -f "$d/draft"; echo deleted >> "$d/drops"; exit 0 ;;
  "api -X PATCH repos/owner/repo/releases/777"*)
    cat "$d/draft-tag" >> "$d/published"; rm -f "$d/draft"; echo "$*" >> "$d/patches"
    if [ -f "$d/patch-lost" ]; then echo "HTTP 502: bad gateway" >&2; exit 1; fi
    exit 0 ;;
esac
echo "unexpected gh $*" >&2; exit 9
`;

const KEEP = `case "$(basename "$a")" in SHA256SUMS|NOTICE.md|friday-*.json) cp "$a" "$d/kept-$(basename "$a")" ;; esac`;

const BUILDER = `
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const a = process.argv.slice(2);
const arg = (n) => a[a.indexOf(n) + 1];
const pack = arg("--pack"), model = arg("--only"), out = arg("--out");
fs.appendFileSync(__LOG__, JSON.stringify({ pack, model, out, partBytes: arg("--part-bytes"),
  siblings: fs.existsSync(path.dirname(out)) ? fs.readdirSync(path.dirname(out)) : [] }) + "\\n");
fs.mkdirSync(out, { recursive: true });
const file = model + "--weights.bin";
const body = "bytes of " + model;
fs.writeFileSync(path.join(out, file), body);
fs.writeFileSync(path.join(out, "SHA256SUMS"), crypto.createHash("sha256").update(body).digest("hex") + "  " + file + "\\n");
fs.writeFileSync(path.join(out, "NOTICE.md"), "# Title\\n\\nHeader line\\n\\n## Licences of the included models\\n\\n- " + model + ": licence line\\n");
fs.writeFileSync(path.join(out, "friday-" + pack + ".json"), JSON.stringify({ pack, assets: [{ fridayId: model, file }] }));
fs.writeFileSync(path.join(out, "upload-command.txt"), "not uploaded");
`;

/**
 * A path as the step's bash and the stand-ins write it: forward slashes, so a Windows drive path
 * (`C:\Users\x`) never reaches a shell string as backslash escapes. Native paths stay in every Node call.
 */
const forBash = (p: string) => p.replaceAll("\\", "/");

function sandbox(published: string[], extra: { freeKb?: number; keep?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-step-"));
  temp.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    GH.replaceAll("__DIR__", forBash(dir)).replace("KEEP_HOOK", extra.keep ? KEEP : ":"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "df"),
    `#!/usr/bin/env bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "fake 999999999999 1 ${extra.freeKb ?? 999999999999} 1% /"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "python"),
    `#!/usr/bin/env bash\necho "$*" >> "${forBash(dir)}/python-calls"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, "builder.cjs"),
    BUILDER.replaceAll("__LOG__", JSON.stringify(path.join(dir, "builds.jsonl"))),
  );
  fs.writeFileSync(path.join(dir, "published"), published.map((t) => `${t}\n`).join(""));
  fs.writeFileSync(path.join(dir, "step.sh"), stepScript());
  return { dir, bin };
}

function run(s: ReturnType<typeof sandbox>) {
  const r = spawnSync("bash", [path.join(s.dir, "step.sh")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${s.bin}${path.delimiter}${process.env["PATH"]}`,
      GH_TOKEN: "stand-in",
      GITHUB_REPOSITORY: "owner/repo",
      RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
      RUNNER_TEMP: path.join(s.dir, "runner-temp"),
      PACK_BUILD_SCRIPT: path.join(s.dir, "builder.cjs"),
      GITHUB_STEP_SUMMARY: path.join(s.dir, "summary.md"),
    },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const lines = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const builds = (s: { dir: string }) =>
  lines(path.join(s.dir, "builds.jsonl")).map((l) => JSON.parse(l));

describe("release step: Publish missing weight packs (definition)", () => {
  it("exists in the publish job, uses bash and carries the release commit through its env", () => {
    const doc = parseYaml(
      fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"),
    ) as any;
    const step = (doc.jobs.publish.steps as any[]).find((s) => s.name === STEP);
    expect(step).toBeTruthy();
    expect(step.shell).toBe("bash");
    expect(step.env.RELEASE_SHA).toContain("steps.plan.outputs.sha");
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(step["timeout-minutes"]).toBeGreaterThan(0);
    expect(step.run).not.toContain("${{");
  });
});

const suite = tools ? describe : () => undefined;

suite("release step: Publish missing weight packs (run against stand-ins)", () => {
  const packs = plan();
  const recall = packs.find((p) => p.id === "recall-weights")!;
  const allTags = packs.map((p) => p.tag);
  const withoutRecall = allTags.filter((t) => t !== recall.tag);

  it("reads at least the voice, brain and recall packs from the config", () => {
    expect(packs.map((p) => p.id)).toEqual(
      expect.arrayContaining(["voice-weights", "brain-weights", "recall-weights"]),
    );
    expect(recall.models.length).toBeGreaterThan(0);
  });

  it("is skipped with a visible reason, and nothing is built or called, when every pack release exists", () => {
    const s = sandbox(allTags);
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/skipped/i);
    expect(r.out).toMatch(/already exist/i);
    expect(builds(s)).toEqual([]);
    const calls = lines(path.join(s.dir, "calls"));
    expect(
      calls.filter(
        (c) => !c.startsWith("release view") && !c.startsWith("api repos/owner/repo/git/ref"),
      ),
    ).toEqual([]);
    expect(fs.readFileSync(path.join(s.dir, "summary.md"), "utf8")).toMatch(/skipped/i);
  });

  it("builds only the missing pack, one model per run, in a work folder outside the checkout", () => {
    const s = sandbox(withoutRecall);
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    const made = builds(s);
    expect(made.map((b) => b.model)).toEqual(recall.models.map((m) => m.id));
    for (const b of made) {
      expect(b.pack).toBe("recall-weights");
      expect(b.partBytes).toBe("1900000000");
      expect(b.out.startsWith(path.join(s.dir, "runner-temp"))).toBe(true);
      expect(b.out.startsWith(root + path.sep)).toBe(false);
      // the folder of an earlier model is already gone when the next one is built
      expect(
        b.siblings.filter((n: string) => recall.models.some((m) => m.id === n && n !== b.model)),
      ).toEqual([]);
    }
    expect(fs.existsSync(path.join(s.dir, "runner-temp", "friday-packs"))).toBe(false);
  });

  it("uploads every model, then the merged SHA256SUMS, NOTICE.md and manifest, and only then publishes without Latest", () => {
    const s = sandbox(withoutRecall);
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    const uploaded = lines(path.join(s.dir, "uploaded")).map((l) => l.split("\t")[0]);
    expect(uploaded).toEqual([
      ...recall.models.map((m) => `${m.id}--weights.bin`),
      "SHA256SUMS",
      "NOTICE.md",
      "friday-recall-weights.json",
    ]);
    const calls = lines(path.join(s.dir, "calls"));
    const create = calls.findIndex((c) =>
      c.startsWith(`api -X POST repos/owner/repo/releases -f tag_name=${recall.tag} `),
    );
    const patch = calls.findIndex((c) =>
      c.startsWith("api -X PATCH repos/owner/repo/releases/777"),
    );
    const lastUpload = calls
      .map((c, i) => (c.startsWith("release upload") ? i : -1))
      .reduce((a, b) => Math.max(a, b));
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(calls.findIndex((c) => c.startsWith("release upload")));
    expect(patch).toBeGreaterThan(lastUpload);
    expect(calls[patch]).toContain("draft=false");
    expect(calls[patch]).toContain("make_latest=false");
    expect(calls[create]).toContain("-f target_commitish=0123456789abcdef0123456789abcdef01234567");
    expect(calls[create]).toContain("-F draft=true");
    expect(calls[create]).toContain("-f make_latest=false");
    expect(calls.join("\n")).not.toContain("release create");
    expect(lines(path.join(s.dir, "published"))).toContain(recall.tag);
    expect(lines(path.join(s.dir, "drops"))).toEqual([]);
  });

  it("never touches a tag that already has a release: no create, upload, edit, delete or clobber", () => {
    const s = sandbox(withoutRecall);
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    const calls = lines(path.join(s.dir, "calls")).join("\n");
    for (const tag of withoutRecall) {
      expect(calls).not.toMatch(new RegExp(`release (create|upload|edit|delete) ${tag}`));
    }
    expect(calls).not.toContain("release delete");
    expect(calls).not.toContain("--clobber");
  });

  it("refuses when the tag exists without a release, and creates nothing", () => {
    const s = sandbox(withoutRecall);
    fs.writeFileSync(path.join(s.dir, "tagrefs"), `${recall.tag}\n`);
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.out).toContain(recall.tag);
    expect(r.out).toMatch(/without a release/i);
    expect(lines(path.join(s.dir, "calls")).some((c) => c.startsWith("api -X POST"))).toBe(false);
  });

  it("treats a draft left by a cancelled run as missing and rebuilds the pack instead of trusting it", () => {
    const s = sandbox(withoutRecall);
    fs.writeFileSync(path.join(s.dir, "draftview"), `${recall.tag}\n`);
    const r = run(s);
    expect(r.code).toBe(0);
    expect(builds(s).length).toBeGreaterThan(0);
  });

  it("never deletes a release it has already published when the read-back fails", () => {
    const s = sandbox(withoutRecall);
    fs.writeFileSync(path.join(s.dir, "readback-error"), "1");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NOT deleted/);
    expect(fs.existsSync(path.join(s.dir, "patches"))).toBe(true);
    expect(fs.existsSync(path.join(s.dir, "drops"))).toBe(false);
  });

  it("never deletes a release that is already public when the PATCH answer was lost", () => {
    const s = sandbox(withoutRecall);
    fs.writeFileSync(path.join(s.dir, "patch-lost"), "1");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(fs.existsSync(path.join(s.dir, "patches"))).toBe(true);
    expect(fs.existsSync(path.join(s.dir, "drops"))).toBe(false);
    expect(r.out).toMatch(/not a draft/);
  });

  it("stops when the tag lookup fails for a reason other than not found", () => {
    const s = sandbox(withoutRecall);
    fs.writeFileSync(path.join(s.dir, "ref-error"), "1");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(builds(s)).toEqual([]);
    expect(lines(path.join(s.dir, "calls")).some((c) => c.startsWith("api -X POST"))).toBe(false);
  });

  it("stops when the release lookup fails for a reason other than not found", () => {
    const s = sandbox(allTags);
    fs.writeFileSync(path.join(s.dir, "view-error"), "1");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(builds(s)).toEqual([]);
    expect(lines(path.join(s.dir, "calls")).some((c) => c.startsWith("api -X POST"))).toBe(false);
  });

  it("fails loud with the numbers when the runner disk is too small, deletes the draft and publishes nothing", () => {
    const s = sandbox(withoutRecall, { freeKb: 1000 });
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::/);
    expect(r.out).toContain(recall.models[0]!.id);
    expect(r.out).toContain(String(1000 * 1024));
    expect(builds(s)).toEqual([]);
    expect(lines(path.join(s.dir, "drops")).length).toBe(1);
    expect(fs.existsSync(path.join(s.dir, "patches"))).toBe(false);
  });

  it("deletes the draft and publishes nothing when an uploaded file is not the built file", () => {
    const s = sandbox(withoutRecall);
    fs.writeFileSync(path.join(s.dir, "corrupt"), "1");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/is not the built file/);
    expect(lines(path.join(s.dir, "drops")).length).toBe(1);
    expect(fs.existsSync(path.join(s.dir, "patches"))).toBe(false);
    expect(lines(path.join(s.dir, "published"))).not.toContain(recall.tag);
  });

  it("removes a draft an earlier run left for the same tag before it creates a new one", () => {
    const s = sandbox(withoutRecall);
    fs.writeFileSync(path.join(s.dir, "draft"), "777\n");
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    const calls = lines(path.join(s.dir, "calls"));
    expect(calls.findIndex((c) => c.startsWith("api -X DELETE"))).toBeLessThan(
      calls.findIndex((c) => c.startsWith("api -X POST")),
    );
  });

  it("installs the pinned numpy and CTranslate2 once, only when a model needs the ct2-int8 conversion", () => {
    const voice = packs.find((p) => p.id === "voice-weights")!;
    expect(voice.models.some((m) => m.ct2)).toBe(true);
    const s = sandbox(allTags.filter((t) => t !== voice.tag));
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    const pip = lines(path.join(s.dir, "python-calls"));
    expect(pip).toHaveLength(1);
    const lock = JSON.parse(
      fs.readFileSync(path.join(root, "config", "wheelhouse.lock.json"), "utf8"),
    );
    const pin = (n: string) => lock.wheels.find((w: { name: string }) => w.name === n).version;
    expect(pip[0]).toContain(`numpy==${pin("numpy")}`);
    expect(pip[0]).toContain(`ctranslate2==${pin("ctranslate2")}`);
    expect(builds(s).map((b) => b.model)).toEqual(voice.models.map((m) => m.id));
  });

  it("does not install anything for a pack whose models need no conversion", () => {
    const s = sandbox(withoutRecall);
    run(s);
    expect(lines(path.join(s.dir, "python-calls"))).toEqual([]);
  });

  it("merges SHA256SUMS, NOTICE.md and the manifest so they carry every model", () => {
    const s = sandbox(withoutRecall, { keep: true });
    const r = run(s);
    expect(r.code, r.out).toBe(0);
    const sums = fs.readFileSync(path.join(s.dir, "kept-SHA256SUMS"), "utf8");
    const notice = fs.readFileSync(path.join(s.dir, "kept-NOTICE.md"), "utf8");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(s.dir, "kept-friday-recall-weights.json"), "utf8"),
    );
    for (const m of recall.models) {
      expect(notice).toContain(`${m.id}: licence line`);
      expect(manifest.assets.map((a: { fridayId: string }) => a.fridayId)).toContain(m.id);
    }
    expect(notice.match(/## Licences of the included models/g)).toHaveLength(1);
    expect(sums).toBe(
      [...recall.models]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(
          (m) =>
            `${createHash("sha256").update(`bytes of ${m.id}`).digest("hex")}  ${m.id}--weights.bin`,
        )
        .join("\n") + "\n",
    );
  });
});
