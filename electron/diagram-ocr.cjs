/**
 * FRIDAY · local diagram OCR.
 *
 * Runs the Tesseract binary from Install Manager. It is looked for on PATH first, then where its installer puts it
 * when it did not touch PATH (Program Files, the folders FRIDAY probes). Hindi, English and Hinglish screens read
 * with `hin+eng` when the Hindi data is installed (`tesseract --list-langs` says so), and with `eng` otherwise.
 * A missing engine is an honest error. This process never calls a cloud OCR.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HINDI_FILE = "hin.traineddata";
const SIBLINGS = ["eng.traineddata", "osd.traineddata"];
const CONFIG_DIRS = ["configs", "tessconfigs"];
const LANG_CACHE_MS = 60_000;

const flavour = (platform) => (platform === "win32" ? path.win32 : path);
const exeName = (platform) => (platform === "win32" ? "tesseract.exe" : "tesseract");

/** The per-user data folder FRIDAY setup falls back to when the engine's own folder is not writable. */
function userTessdataDir(env = process.env, platform = process.platform) {
  if (platform !== "win32") return "";
  const home = env.USERPROFILE || "";
  const local = env.LOCALAPPDATA || (home ? path.win32.join(home, "AppData", "Local") : "");
  return local ? path.win32.join(local, "FRIDAY", "tools", "tessdata") : "";
}

/** Full path of the engine: PATH first, then the folders an installer leaves it in without a PATH entry. */
function findTesseract({
  env = process.env,
  exists = fs.existsSync,
  platform = process.platform,
  toolDirs = null,
} = {}) {
  const p = flavour(platform);
  const file = exeName(platform);
  const dirs = String(env.PATH || env.Path || "")
    .split(p.delimiter)
    .filter(Boolean);
  if (platform === "win32") {
    let machine = toolDirs;
    if (!machine) {
      try {
        machine = require("./managed-path.cjs").machineToolDirs({ env, exists, platform });
      } catch {
        machine = [];
      }
    }
    dirs.push(...machine);
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (base) dirs.push(p.join(base, "Tesseract-OCR"));
    }
    if (env.LOCALAPPDATA) dirs.push(p.join(env.LOCALAPPDATA, "Programs", "Tesseract-OCR"));
  }
  for (const dir of dirs) {
    const candidate = p.join(dir, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The language codes in the output of `tesseract --list-langs`. */
function parseLangList(text) {
  const out = [];
  let seenHeader = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^list of available languages/i.test(line)) {
      seenHeader = true;
      continue;
    }
    if (seenHeader && /^[A-Za-z0-9_]+$/.test(line)) out.push(line);
  }
  return out;
}

const defaultLister = (bin, env) => {
  const run = spawnSync(bin, ["--list-langs"], {
    timeout: 8000,
    windowsHide: true,
    encoding: "utf8",
    ...(env ? { env } : {}),
  });
  if (run.error) return [];
  return parseLangList(`${run.stdout || ""}\n${run.stderr || ""}`);
};

/** `hin+eng` when both are installed, `hin` alone, else `eng`; `env` is set when the per-user data folder is used. */
function chooseLanguages(
  bin,
  {
    env = process.env,
    platform = process.platform,
    listLangs = defaultLister,
    exists = fs.existsSync,
  } = {},
) {
  const pick = (langs) =>
    langs.includes("hin") ? (langs.includes("eng") ? "hin+eng" : "hin") : "";
  const own = pick(listLangs(bin, env));
  if (own) return { lang: own, env: null };
  const folder = userTessdataDir(env, platform);
  if (folder && exists(flavour(platform).join(folder, HINDI_FILE))) {
    const withFolder = { ...env, TESSDATA_PREFIX: folder };
    const there = pick(listLangs(bin, withFolder));
    if (there) return { lang: there, env: withFolder };
  }
  return { lang: "eng", env: null };
}

const langCache = new Map();
function cachedLanguages(bin, options = {}) {
  const now = (options.now || Date.now)();
  const key = `${bin}|${(options.env || process.env).TESSDATA_PREFIX || ""}`;
  const hit = langCache.get(key);
  if (hit && now - hit.at < LANG_CACHE_MS) return hit.value;
  const value = chooseLanguages(bin, options);
  langCache.set(key, { at: now, value });
  return value;
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Add the Hindi data (hin.traineddata, pinned URL and SHA-256 in config/toolchain-versions.json) to the engine when
 * `--list-langs` does not list it. Detect first; skipped offline. The engine's own tessdata folder is used when it
 * can be written (administrator install); otherwise a per-user folder with eng and osd copied along, which
 * {@link chooseLanguages} finds. `download(url)` returns the bytes. Resolves to `{ ok, skipped?, folder?, reason? }`.
 */
async function ensureHindiData({
  bin,
  pin,
  download,
  env = process.env,
  platform = process.platform,
  listLangs = defaultLister,
  fsApi = fs,
  say = () => {},
} = {}) {
  if (!bin) return { ok: false, skipped: "engine-missing" };
  const p = flavour(platform);
  if (listLangs(bin, env).includes("hin")) return { ok: true, skipped: "present" };
  if (String(env.FRIDAY_OFFLINE || "").trim() === "1") {
    say("Hindi OCR data skipped: offline");
    return { ok: false, skipped: "offline" };
  }
  if (!pin || !pin.url || !/^[0-9a-f]{64}$/i.test(String(pin.sha256 || ""))) {
    return { ok: false, skipped: "no-pin" };
  }
  let bytes;
  try {
    bytes = await download(pin.url);
  } catch (error) {
    return { ok: false, reason: `download failed: ${error?.message || error}` };
  }
  if (!bytes || !bytes.length || (pin.bytes && bytes.length !== Number(pin.bytes))) {
    return { ok: false, reason: "the Hindi data has an unexpected size" };
  }
  if (sha256Hex(bytes) !== String(pin.sha256).toLowerCase()) {
    return { ok: false, reason: "the Hindi data did not match its pinned SHA-256" };
  }
  const own = p.join(p.dirname(bin), "tessdata");
  const targets = [env.TESSDATA_PREFIX, own].filter((dir) => dir && fsApi.existsSync(dir));
  const write = (dir) => {
    const part = p.join(dir, `${HINDI_FILE}.part`);
    fsApi.writeFileSync(part, bytes);
    fsApi.renameSync(part, p.join(dir, HINDI_FILE));
  };
  let folder = "";
  let childEnv = env;
  for (const dir of targets) {
    try {
      write(dir);
      folder = dir;
      break;
    } catch {
      /* not writable without administrator rights: the next folder */
    }
  }
  if (!folder) {
    const user = userTessdataDir(env, platform);
    if (!user) return { ok: false, reason: "no writable folder for the Hindi data" };
    try {
      fsApi.mkdirSync(user, { recursive: true });
      for (const name of SIBLINGS) {
        const from = p.join(own, name);
        const to = p.join(user, name);
        if (fsApi.existsSync(from) && !fsApi.existsSync(to)) fsApi.copyFileSync(from, to);
      }
      // The output configs (tsv ...) sit in tessdata/configs: TESSDATA_PREFIX replaces the whole folder.
      for (const name of CONFIG_DIRS) {
        const from = p.join(own, name);
        const to = p.join(user, name);
        if (fsApi.existsSync(from) && !fsApi.existsSync(to)) {
          fsApi.cpSync(from, to, { recursive: true });
        }
      }
      write(user);
    } catch (error) {
      return { ok: false, reason: `could not write the Hindi data: ${error?.message || error}` };
    }
    folder = user;
    childEnv = { ...env, TESSDATA_PREFIX: user };
  }
  langCache.clear();
  if (!listLangs(bin, childEnv).includes("hin")) {
    return { ok: false, folder, reason: "Tesseract still does not list the Hindi data" };
  }
  say(`Hindi OCR data added to ${folder}`);
  return { ok: true, folder };
}

function recognize(bytes, options = {}) {
  if (!bytes || !bytes.length) return { ok: false, error: "no image" };
  const found = findTesseract(options);
  const bin = found || exeName(process.platform);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ocr-"));
  const file = path.join(dir, "page.png");
  try {
    fs.writeFileSync(file, bytes);
    const choice = found ? cachedLanguages(found, options) : { lang: "eng", env: null };
    const run = spawnSync(bin, [file, "stdout", "-l", choice.lang, "--psm", "6", "tsv"], {
      timeout: 20000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      ...(choice.env ? { env: choice.env } : {}),
    });
    if (run.error && run.error.code === "ENOENT") {
      return { ok: false, error: "Tesseract OCR is not installed" };
    }
    if (run.status !== 0) {
      const detail = String(run.stderr || run.error || "tesseract failed").trim();
      return { ok: false, error: detail.slice(0, 240) || "tesseract failed" };
    }
    return { ok: true, tsv: run.stdout || "", lang: choice.lang };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function recognizeDataUrl(dataUrl, options = {}) {
  const text = String(dataUrl || "");
  const comma = text.indexOf(",");
  if (comma < 0) return { ok: false, error: "no image" };
  let bytes;
  try {
    bytes = Buffer.from(text.slice(comma + 1), "base64");
  } catch {
    return { ok: false, error: "no image" };
  }
  return recognize(bytes, options);
}

module.exports = {
  recognize,
  recognizeDataUrl,
  findTesseract,
  parseLangList,
  chooseLanguages,
  ensureHindiData,
  userTessdataDir,
};
