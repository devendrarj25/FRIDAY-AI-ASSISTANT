/**
 * FRIDAY · character runtime & asset manager
 *
 * Owns everything the desktop companion needs on disk and reports its REAL
 * health. Nothing here is cosmetic: every status comes from a filesystem
 * check, a JSON parse, Chromium's own GPU feature report or a live probe
 * result published by the running overlay renderer.
 *
 * Asset pipeline (source -> runtime):
 *   dist-desktop/character/<id>/base.png   (SOURCE artwork shipped with FRIDAY)
 *        -> <FRIDAY root>/Character/Assets/<id>/base.png      (installed copy)
 *        -> <FRIDAY root>/Character/Models/<id>/model.json    (RIG definition)
 *        -> <FRIDAY root>/Character/Runtime/registry.json     (versions/health)
 * The renderer reads the rig from the installed copy, so a repaired or
 * updated character takes effect without touching application code.
 */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const paths = require("../friday-paths.cjs");

/** Folder layout owned by the character feature, inside the FRIDAY root. */
const FOLDERS = [
  "Assets",
  "Models",
  "Textures",
  "Animations",
  "Expressions",
  "Voice",
  "Config",
  "Cache",
  "Runtime",
];

const CHARACTER_ID = "friday";
/** Bumped whenever the shipped artwork or the rig definition changes. */
const ASSET_VERSION = "1.0.0";

/**
 * The rig: bones deform the artwork on the GPU, landmarks drive the eyes and
 * the mouth. Coordinates are normalised (0..1) against the texture, measured
 * once from the shipped artwork.
 */
const RIG = {
  id: CHARACTER_ID,
  name: "FRIDAY",
  version: ASSET_VERSION,
  engine: "friday-2d-skeletal",
  texture: "base.png",
  /**
   * The shipped artwork is 768x1152 with the character inside this pixel box;
   * the renderer samples only the crop so the transparent window hugs her
   * silhouette instead of empty canvas.
   */
  crop: { u0: 168 / 768, v0: 29 / 1152, u1: 581 / 768, v1: 1126 / 1152 },
  aspect: 1097 / 413,
  /** Mesh resolution used for skeletal deformation. */
  mesh: { cols: 12, rows: 24 },
  /** Bones, root first; `pivot` is normalised texture space. */
  bones: [
    { name: "hips", pivot: [0.5, 0.62], parent: null },
    { name: "torso", pivot: [0.5, 0.42], parent: "hips" },
    { name: "neck", pivot: [0.5, 0.19], parent: "torso" },
    { name: "head", pivot: [0.5, 0.155], parent: "neck" },
    { name: "hair", pivot: [0.5, 0.12], parent: "head" },
  ],
  landmarks: {
    eyeLeft: { cx: 0.435, cy: 0.12, hw: 0.045, hh: 0.021 },
    eyeRight: { cx: 0.567, cy: 0.12, hw: 0.045, hh: 0.021 },
    mouth: { cx: 0.5, cy: 0.1435, hw: 0.032, hh: 0.014 },
    headTop: 0.0,
    headBottom: 0.185,
  },
  /** Idle/secondary motion, all physically driven in the renderer. */
  motion: {
    breathHz: 0.22,
    swayHz: 0.13,
    blinkMinMs: 2600,
    blinkMaxMs: 7000,
    hairSpring: { stiffness: 90, damping: 12 },
  },
  expressions: [
    "idle",
    "listening",
    "thinking",
    "working",
    "coding",
    "searching",
    "speaking",
    "waiting_approval",
    "success",
    "error",
    "offline",
    "installing",
    "updating",
  ],
};

/* --------------------------------------------------------------- locations */

const characterRoot = () => path.join(paths.base(), "Character");
const folder = (name) => path.join(characterRoot(), name);
const assetsDir = () => path.join(folder("Assets"), CHARACTER_ID);
const modelDir = () => path.join(folder("Models"), CHARACTER_ID);
const modelFile = () => path.join(modelDir(), "model.json");
const textureFile = () => path.join(assetsDir(), "base.png");
const registryFile = () => path.join(folder("Runtime"), "registry.json");

/** Where the artwork ships: dist-desktop in a packaged app, public/ in dev. */
function sourceDir() {
  const appPath = app.getAppPath();
  const resources = process.resourcesPath || "";
  const candidates = [
    path.join(appPath, "dist-desktop", "character", CHARACTER_ID),
    path.join(appPath, "public", "character", CHARACTER_ID),
    // Defensive: an unpacked/extraResources copy of the same artwork.
    resources ? path.join(resources, "app.asar", "dist-desktop", "character", CHARACTER_ID) : null,
    resources ? path.join(resources, "dist-desktop", "character", CHARACTER_ID) : null,
    resources ? path.join(resources, "character", CHARACTER_ID) : null,
    path.join(__dirname, "..", "..", "dist-desktop", "character", CHARACTER_ID),
    path.join(__dirname, "..", "..", "public", "character", CHARACTER_ID),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, "base.png"))) return candidate;
    } catch {
      /* unreadable location — try the next one */
    }
  }
  return candidates[0];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/* ------------------------------------------------------------ gpu / probes */

/** Chromium's own report — never a guess. */
function gpuStatus() {
  let features = {};
  try {
    features = app.getGPUFeatureStatus() || {};
  } catch {
    features = {};
  }
  const gl = String(features.gpu_compositing || features.webgl || "");
  const accelerated = /enabled/i.test(String(features.webgl || "")) && !/software/i.test(gl);
  return {
    accelerated,
    webgl: String(features.webgl || "unknown"),
    webgl2: String(features.webgl2 || "unknown"),
    compositing: String(features.gpu_compositing || "unknown"),
    rasterization: String(features.rasterization || "unknown"),
    detail: features,
  };
}

/** Last real probe published by the overlay renderer (renderer/vendor/fps). */
let lastProbe = null;
function recordProbe(probe) {
  if (!probe || typeof probe !== "object") return lastProbe;
  lastProbe = {
    at: Date.now(),
    ok: Boolean(probe.ok),
    api: String(probe.api || ""),
    renderer: String(probe.renderer || ""),
    vendor: String(probe.vendor || ""),
    fps: Number(probe.fps) || 0,
    frameMs: Number(probe.frameMs) || 0,
    error: probe.error ? String(probe.error) : null,
  };
  return lastProbe;
}
const probe = () => lastProbe;

/* ------------------------------------------------------------- operations */

function ensureStructure() {
  const created = [];
  for (const name of FOLDERS) {
    const full = folder(name);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
      created.push(name);
    }
  }
  return created;
}

/** Copy the shipped artwork into the FRIDAY root and write the rig. */
function install() {
  if (!paths.hasRoot()) {
    return { ok: false, error: "Select the FRIDAY primary folder first." };
  }
  ensureStructure();
  const src = sourceDir();
  const source = path.join(src, "base.png");
  if (!fs.existsSync(source)) {
    return { ok: false, error: `Character artwork missing from the build: ${source}` };
  }
  fs.mkdirSync(assetsDir(), { recursive: true });
  fs.copyFileSync(source, textureFile());
  // Any additional shipped parts (expressions, extra textures) travel too.
  for (const entry of fs.readdirSync(src)) {
    if (entry === "base.png") continue;
    const from = path.join(src, entry);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(assetsDir(), entry));
  }
  writeJson(modelFile(), RIG);
  const stat = fs.statSync(textureFile());
  writeJson(registryFile(), {
    id: CHARACTER_ID,
    assetVersion: ASSET_VERSION,
    installedAt: Date.now(),
    texture: textureFile(),
    textureBytes: stat.size,
    model: modelFile(),
    source: src,
  });
  return { ok: true, health: health() };
}

const repair = () => install();

function update() {
  const registry = readJson(registryFile());
  if (registry && registry.assetVersion === ASSET_VERSION && isHealthy()) {
    return { ok: true, updated: false, health: health() };
  }
  const result = install();
  return { ...result, updated: result.ok };
}

function remove() {
  for (const target of [assetsDir(), modelDir(), registryFile()]) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* reported by the next health read */
    }
  }
  return { ok: true, health: health() };
}

function isHealthy() {
  try {
    if (!fs.existsSync(textureFile())) return false;
    if (fs.statSync(textureFile()).size < 1024) return false;
    const model = readJson(modelFile());
    return Boolean(model && model.texture && model.landmarks && model.bones?.length);
  } catch {
    return false;
  }
}

/**
 * Real component health. Statuses are only ever derived from a check that
 * actually ran — "ready" is never assumed.
 */
function health() {
  const registry = readJson(registryFile());
  const model = readJson(modelFile());
  const gpu = gpuStatus();
  const hasRoot = paths.hasRoot();
  const textureOk = fs.existsSync(textureFile());
  const textureBytes = textureOk ? fs.statSync(textureFile()).size : 0;
  const outdated = Boolean(registry) && registry.assetVersion !== ASSET_VERSION;

  const components = [
    {
      id: "character-root",
      label: "Character folder",
      status: hasRoot ? (fs.existsSync(characterRoot()) ? "ready" : "missing") : "blocked",
      version: "—",
      location: hasRoot ? characterRoot() : "no FRIDAY folder selected",
      detail: hasRoot
        ? fs.existsSync(characterRoot())
          ? `${FOLDERS.length} folders`
          : "not created yet"
        : "Select the FRIDAY primary folder first.",
    },
    {
      id: "character-assets",
      label: "Character assets",
      status: !textureOk
        ? "missing"
        : textureBytes < 1024
          ? "broken"
          : outdated
            ? "outdated"
            : "ready",
      version: registry?.assetVersion ?? "—",
      location: textureOk ? textureFile() : assetsDir(),
      detail: textureOk ? `${Math.round(textureBytes / 1024)} KB texture` : "artwork not installed",
    },
    {
      id: "character-model",
      label: "Character model (rig)",
      status: !model ? "missing" : model.bones?.length ? "ready" : "broken",
      version: model?.version ?? "—",
      location: modelFile(),
      detail: model?.bones?.length
        ? `${model.bones.length} bones · ${model.mesh?.cols}×${model.mesh?.rows} mesh`
        : "rig definition not written",
    },
    {
      id: "character-animation",
      label: "Animation runtime",
      status: lastProbe ? (lastProbe.ok ? "ready" : "broken") : "unknown",
      version: RIG.engine,
      location: "overlay renderer",
      detail: lastProbe
        ? lastProbe.ok
          ? `${lastProbe.api} · ${Math.round(lastProbe.fps)} fps`
          : (lastProbe.error ?? "renderer reported a failure")
        : "start the character to run a live probe",
    },
    {
      id: "character-gpu",
      label: "GPU acceleration",
      status: gpu.accelerated ? "ready" : "degraded",
      version: lastProbe?.renderer || gpu.webgl,
      location: lastProbe?.vendor || "chromium",
      detail: gpu.accelerated
        ? `hardware accelerated (${gpu.webgl})`
        : `software fallback in use (${gpu.webgl})`,
    },
  ];

  const ready = components.every((c) => c.status === "ready" || c.status === "degraded");
  return {
    id: CHARACTER_ID,
    ready,
    assetVersion: ASSET_VERSION,
    installedVersion: registry?.assetVersion ?? null,
    outdated,
    root: hasRoot ? characterRoot() : null,
    gpu,
    probe: lastProbe,
    components,
  };
}

/** Rig + texture the overlay renderer should load right now. */
function modelPayload() {
  const model = readJson(modelFile()) || RIG;
  const installed = fs.existsSync(textureFile());
  return {
    model,
    // The overlay loads the installed copy when it exists (so a repaired or
    // user-replaced texture wins) and the shipped one otherwise.
    textureUrl: installed ? null : `/character/${CHARACTER_ID}/base.png`,
    textureFile: installed ? textureFile() : null,
    ready: isHealthy(),
  };
}

/** Raw bytes of the installed texture, for the sandboxed overlay renderer. */
function textureData() {
  try {
    const file = fs.existsSync(textureFile()) ? textureFile() : path.join(sourceDir(), "base.png");
    if (!fs.existsSync(file)) return null;
    return { mime: "image/png", base64: fs.readFileSync(file).toString("base64"), file };
  } catch {
    return null;
  }
}

module.exports = {
  CHARACTER_ID,
  ASSET_VERSION,
  RIG,
  FOLDERS,
  characterRoot,
  assetsDir,
  modelFile,
  textureFile,
  sourceDir,
  ensureStructure,
  install,
  repair,
  update,
  remove,
  health,
  isHealthy,
  gpuStatus,
  recordProbe,
  probe,
  modelPayload,
  textureData,
};
