/**
 * FRIDAY · webcam stills and short clips (main process)
 *
 * One capture path: a real getUserMedia frame (hidden BrowserWindow) or an
 * ingested data URL from the renderer / phone companion. Nothing invents
 * pixels. Write-risk tools and companion taps still go through approval /
 * owner action; this module only stores what was actually captured.
 */
const fs = require("fs");
const path = require("path");
const paths = require("./friday-paths.cjs");

const STATE_FILE = () => paths.cameraFile();

const DEFAULT_STATE = {
  enabled: false,
  lastCaptureAt: null,
  captures: 0,
  lastFile: null,
};

let state = null;

function setRoot(root) {
  if (root && typeof root === "string") paths.setRoot(root);
  state = null;
  return paths.root();
}

function load() {
  if (state) return state;
  try {
    state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) };
  } catch {
    state = { ...DEFAULT_STATE };
  }
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* a settings write failure must never break capture state in memory */
  }
}

function getState() {
  return { ...load() };
}

function setState(patch) {
  load();
  if (typeof patch?.enabled === "boolean") state.enabled = patch.enabled;
  save();
  return getState();
}

function cameraDir() {
  const root = paths.root();
  const dir = root
    ? path.join(paths.ensureDir("cache"), "camera")
    : path.join(require("os").tmpdir(), "friday-camera");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+=*)$/i.exec(
    String(dataUrl || "").replace(/\s/g, ""),
  );
  if (!match) return null;
  const ext =
    match[1].toLowerCase() === "png" ? "png" : match[1].toLowerCase() === "webp" ? "webp" : "jpg";
  try {
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length) return null;
    return { ext, buffer };
  } catch {
    return null;
  }
}

function recordFile(file, kind) {
  load();
  state.lastCaptureAt = Date.now();
  state.captures += 1;
  state.lastFile = file;
  save();
  return {
    ok: true,
    kind,
    file,
    at: state.lastCaptureAt,
    captures: state.captures,
  };
}

/** Store a renderer/companion still. Rejects anything that is not a real image data URL. */
function ingest(payload = {}) {
  const parsed = parseDataUrl(payload.dataUrl);
  if (!parsed) return { ok: false, error: "camera ingest needs a PNG/JPEG/WebP data URL" };
  const file = path.join(cameraDir(), `still-${Date.now()}.${parsed.ext}`);
  try {
    fs.writeFileSync(file, parsed.buffer);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  return recordFile(file, "still");
}

async function grabFrameViaWindow(seconds) {
  let electron;
  try {
    electron = require("electron");
  } catch {
    return { ok: false, error: "camera needs the FRIDAY desktop app" };
  }
  const BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow) return { ok: false, error: "camera needs the FRIDAY desktop app" };

  const duration = Math.max(0, Math.min(Number(seconds) || 0, 4));
  const html = `<!doctype html><meta charset="utf-8"><video id="v" autoplay playsinline muted></video><canvas id="c"></canvas>
<script>
(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const video = document.getElementById("v");
    video.srcObject = stream;
    await new Promise((resolve) => { video.onloadeddata = resolve; });
    const wait = ${duration} > 0 ? ${duration} * 1000 : 120;
    await new Promise((resolve) => setTimeout(resolve, wait));
    const canvas = document.getElementById("c");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext("2d").drawImage(video, 0, 0);
    stream.getTracks().forEach((track) => track.stop());
    document.title = canvas.toDataURL("image/jpeg", 0.85);
  } catch (error) {
    document.title = "ERR:" + (error && error.message ? error.message : String(error));
  }
})();
</script>`;

  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const title = win.getTitle();
      if (title.startsWith("data:image/")) {
        win.destroy();
        return ingest({ dataUrl: title });
      }
      if (title.startsWith("ERR:")) {
        win.destroy();
        return { ok: false, error: title.slice(4) };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    win.destroy();
    return { ok: false, error: "camera capture timed out" };
  } catch (error) {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
    return { ok: false, error: String(error?.message || error) };
  }
}

/** One webcam still. Owner enable is not required beyond the write-risk tool gate. */
async function capture(options = {}) {
  if (options.dataUrl) return ingest(options);
  return grabFrameViaWindow(0);
}

/** A short clip as sequential stills (not an unbounded live stream). */
async function clip(options = {}) {
  const frames = Math.max(2, Math.min(Number(options.frames) || 3, 8));
  const results = [];
  for (let i = 0; i < frames; i += 1) {
    const shot = await grabFrameViaWindow(i === 0 ? 0.2 : 0.4);
    if (!shot.ok) {
      if (results.length) return { ok: true, kind: "clip", frames: results, error: shot.error };
      return shot;
    }
    results.push(shot.file);
  }
  load();
  return {
    ok: true,
    kind: "clip",
    frames: results,
    at: state.lastCaptureAt,
    captures: state.captures,
  };
}

module.exports = { getState, setState, ingest, capture, clip, setRoot };
