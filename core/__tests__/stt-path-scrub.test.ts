/**
 * An error text or status field the speech bridge hands the renderer never carries a path of this PC (G2): the user
 * profile name sits in it. A child's last stderr lines, a failed write of the clip and the engine's own error are
 * scrubbed to a short placeholder before they leave the module. No process, no model, no microphone.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWorker, STATUS_OK } from "./helpers/fake-stt-worker";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");

const WIN_PATH = "C:\\Users\\devendra.singh\\AppData\\Local\\Temp\\friday\\clip.wav";
const WAV = new Uint8Array(64);

beforeEach(() => {
  stt.useForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  stt.useForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scrubPaths", () => {
  it("replaces a Windows drive path, a POSIX home path and this PC's home folder, and keeps the rest", () => {
    const out = stt.scrubPaths(
      `open '${WIN_PATH}' failed; also /home/devendra/.cache/x.bin and ${homedir()}/models, code 13`,
    );
    expect(out).not.toMatch(/devendra|AppData|Users|\/home\//);
    expect(out).toContain("open '");
    expect(out).toContain("failed");
    expect(out).toContain("code 13");
  });

  it("handles forward-slash drive paths and UNC paths, and leaves plain text and non-strings alone", () => {
    expect(stt.scrubPaths("D:/work/FRIDAY/kernel/stt.py line 4")).not.toMatch(/work|kernel/);
    expect(stt.scrubPaths("\\\\pc-name\\share\\a.wav gone")).not.toMatch(/pc-name|share/);
    expect(stt.scrubPaths("the model is loading")).toBe("the model is loading");
    expect(stt.scrubPaths(null)).toBe("");
  });
});

describe("what reaches the renderer", () => {
  it("a failed write of the clip answers write-failed without the profile path", async () => {
    installFakeWorker(stt);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error(`EACCES: permission denied, open '${WIN_PATH}'`);
    });
    const out = await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(out).toMatchObject({ ok: false, reason: "write-failed" });
    expect(String(out.error)).toContain("permission denied");
    expect(String(out.error)).not.toMatch(/devendra|AppData/);
  });

  it("a failed probe's error and stderr reach the status reason without the profile path", async () => {
    stt.useForTests({
      python: async () => ["python-test", []],
      run: async () => ({
        ok: false,
        stdout: JSON.stringify({ ok: false, error: `ImportError in ${WIN_PATH}` }),
        stderr: "",
      }),
    });
    const status = await stt.status(true, { localOnly: true });
    expect(String(status.reason)).toContain("ImportError");
    expect(JSON.stringify(status)).not.toMatch(/devendra|AppData/);
  });

  it("a child's last stderr lines pass through the scrub before they become the status reason", () => {
    const src = fs.readFileSync(new URL("../../electron/stt.cjs", import.meta.url), "utf8");
    expect(src).toMatch(/STT worker exited — \$\{scrubPaths\(tail\)\}/);
    expect(src).toMatch(/if \(typeof value\.reason === "string"\) value\.reason = scrubPaths/);
  });

  it("the engine's own error and the load failure text are scrubbed", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = (msg) => {
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load")
        return { id: msg.id, ok: false, error: `cannot open ${WIN_PATH} (model missing)` };
      return { id: msg.id, ok: false, error: `bad file ${WIN_PATH}` };
    };
    const out = await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(JSON.stringify(out)).not.toMatch(/devendra|AppData/);
    const status = await stt.status(false, { localOnly: true });
    expect(JSON.stringify(status)).not.toMatch(/devendra|AppData/);
  });
});
