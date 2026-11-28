/**
 * The Install Manager's catalogue: every row FRIDAY can install (tools, engines and wheel bundles, runtime packs, voice
 * models, curated chat models) with
 *
 *   fit            can THIS PC run it (`engine-fit.cjs`: supported, limited, unsupported, with reasons)
 *   installed      what is on disk and its version
 *   latest         the newest version an OFFICIAL source named, which source answered, when, and whether it is stale
 *   updateStatus   current, update, unknown or error
 *
 * `snapshot()` is quick: it reads only what is already in memory and in the feed cache, never the network and never a
 * probe, so the IPC `installer:catalog` can answer at once. A stale or missing answer starts `refresh()` in the
 * background (stale-while-revalidate); `refresh()` asks each row's ordered source chain (`vendor-sources.cjs`),
 * each source with its own short timeout, through the resource governor's download lane. It owns no timer: the daily
 * pass is started by the catalogue refresh that already runs (main.cjs `runCatalogueRefresh`), a manual refresh is
 * rate limited, and privacy mode or being offline keeps to the cache.
 *
 * Updating never happens by itself. `planUpdate` decides from the autonomy dial (Ask every time, Balanced, Full) and the
 * owner's consent; only a granted update reaches the installer, which builds the new copy next to the old one.
 */
"use strict";

const nodePath = require("node:path");
const nodeFs = require("node:fs");
const vendor = require("./vendor-sources.cjs");
const fitApi = require("./engine-fit.cjs");
const engineInstall = require("./engine-install.cjs");
const llama = require("./llama-runtime.cjs");
const llmSelect = require("./llm-engine-select.cjs");
const inventory = require("./install-inventory.cjs");

const UPDATE_STATUSES = Object.freeze(["current", "update", "unknown", "error"]);
const AUTONOMY = Object.freeze(["ask", "balanced", "full"]);
/** The first wait before an automatic pass that follows one that left the cache old (it doubles, daily at most). */
const RETRY_BASE_MS = 5 * 60 * 1000;

/** current, update, unknown or error from what is installed and what the sources said. Pure. */
function updateStatusOf({ installed, installedVersion, latest, byRevision = false }) {
  if (!latest) return "unknown";
  if (latest.ok === false) return "error";
  if (installed !== true || !installedVersion || !latest.version) return "unknown";
  const same = String(installedVersion) === String(latest.version);
  if (byRevision) return same ? "current" : "update";
  if (inventory.newer(latest.version, installedVersion)) return "update";
  // A pinned answer says what FRIDAY ships, not what is newest: it can only prove "update", never "current".
  if (latest.pinned) return "unknown";
  return "current";
}

/**
 * Whether an update may start. Ask every time and Balanced need the owner's consent for this update; Full autonomy
 * may go ahead, still audited. Nothing runs without one of the two. Pure.
 */
function planUpdate({ row, autonomy, consent } = {}) {
  const dial = AUTONOMY.includes(String(autonomy)) ? String(autonomy) : "ask";
  if (!row) return { allowed: false, needsConsent: false, reason: "unknown row" };
  // A runtime bundled in the app (Electron, FRIDAY Node, the pip bootstrap) only reports a newer version: no dial and
  // no consent swaps it at run time; the owner's version bump does.
  if (row.notifyOnly === true) {
    return {
      allowed: false,
      needsConsent: false,
      notifyOnly: true,
      reason:
        "a newer version is available; this runtime is bundled and changes only with a FRIDAY update",
      dial,
    };
  }
  if (row.updateStatus !== "update") {
    return { allowed: false, needsConsent: false, reason: "there is no update for this row" };
  }
  if (row.fit?.state === "unsupported") {
    return { allowed: false, needsConsent: false, reason: "this PC cannot run the update" };
  }
  // A machine-home install writes into Windows' own folders: Windows shows its own permission prompt, FRIDAY never
  // answers it, and the plan says so.
  const machine = row.home === "machine" ? { home: "machine", elevation: "windows" } : {};
  if (consent?.granted === true)
    return { allowed: true, needsConsent: false, via: "consent", dial, ...machine };
  if (dial === "full")
    return { allowed: true, needsConsent: false, via: "full-autonomy", dial, ...machine };
  return {
    allowed: false,
    needsConsent: true,
    reason:
      dial === "balanced"
        ? "Balanced asks before updating a tool"
        : "Ask every time: updating needs your OK",
    dial,
    ...(row.home === "machine" ? { home: "machine" } : {}),
  };
}

/** The source chain of a tool row and the key its answers are stored under (shared with the installers). */
function chainOfTool(tool) {
  if (tool.engine && engineInstall.ENGINES[tool.engine]) {
    const spec = engineInstall.ENGINES[tool.engine];
    const sources = engineInstall.engineSources(spec);
    // FRIDAY's own build has nothing to read until its release asset is recorded; no chain means no "error" row.
    return sources.length ? { key: spec.id, sources, spec } : null;
  }
  if (tool.pipBundle && engineInstall.PIP_BUNDLES[tool.pipBundle]) {
    const main = engineInstall.PIP_BUNDLES[tool.pipBundle].parts.at(-1).dist;
    return { key: main, sources: engineInstall.wheelSources(main) };
  }
  const sources = vendor.chainFor(tool);
  return sources.length ? { key: tool.id, sources } : null;
}

/** Where a tool without a declared home goes, from the one route it installs through. */
function routeHome(tool) {
  if (tool.winget) return "machine";
  if (tool.npm) return "npm-global";
  if (tool.pip || tool.pipDist || tool.pipBundle) return "friday-root";
  return null;
}

/** Rows from the tool list the Install Manager already scans. */
function toolRows(tools, detected) {
  const seen = new Map((detected?.tools || []).map((t) => [t.id, t]));
  const out = [];
  for (const tool of tools || []) {
    if (!tool || !tool.id || tool.aliasOf) continue;
    const found = seen.get(tool.id);
    const chain = chainOfTool(tool);
    // What the data file says about the row (home, notify-only, download, silent switches): read, never copied.
    const spec = vendor.rowSpec(tool.id);
    out.push({
      id: tool.id,
      home: vendor.declaredHome(tool) || routeHome(tool),
      notifyOnly: spec?.notifyOnly === true,
      ...(spec?.download ? { download: spec.download } : {}),
      ...(spec?.silentInstall ? { silentInstall: spec.silentInstall } : {}),
      ...(spec ? { downloadReady: vendor.downloadReadiness(spec).installable } : {}),
      kind: tool.engine || tool.pipBundle ? "engine" : "tool",
      name: tool.name || tool.id,
      category: tool.category || "Tool",
      installed: found ? Boolean(found.installed) : null,
      installedVersion: found?.version || null,
      requirements: tool.requirements || null,
      optional: tool.requirements?.recommended === false || Boolean(tool.optional),
      chain,
      engine: tool.engine || null,
      pinnedVersion: tool.pinVersion || null,
    });
  }
  return out;
}

/** Runtime packs (config/toolchain-manifest.json): their pin is the newest FRIDAY knows. */
function packRows(packs, tools, detected) {
  const seen = new Map((detected?.tools || []).map((t) => [t.id, t]));
  const owner = new Map((tools || []).filter((t) => t.packId).map((t) => [t.packId, t.id]));
  return (packs || []).map((pack) => {
    const found = seen.get(owner.get(pack.id));
    return {
      id: `pack:${pack.id}`,
      kind: "runtime-pack",
      name: pack.name || pack.id,
      category: pack.tier === "bundled" ? "Bundled runtime" : "Runtime pack",
      installed: found ? Boolean(found.installed) : null,
      installedVersion: found?.version || null,
      requirements: { diskBytes: Number(pack.bytes) || undefined },
      optional: pack.tier !== "bundled",
      chain: {
        key: `pack:${pack.id}`,
        sources: [{ kind: "pinned", version: pack.version, assets: [] }],
      },
      license: pack.license || null,
    };
  });
}

/** Voice models (electron/voice-weights.cjs registry + electron/voice-pins.cjs manifest). */
function voiceRows(root, deps = {}) {
  const weights = deps.voiceWeights || require("./voice-weights.cjs");
  const pins = deps.voicePins || require("./voice-pins.cjs");
  const fsApi = deps.fs || nodeFs;
  const out = [];
  for (const entry of weights.modelRegistry()) {
    const manifest = weights.manifestOf(entry.catalogId);
    const dir = root ? nodePath.join(root, ...entry.dir) : null;
    let installed = null;
    let version = null;
    let servedFrom = null;
    // A derived ear (the converted copy of a source checkpoint) reads its install state from the FRIDAY release files:
    // `null` while the release has none (no Download button; the row says so), never the source repository.
    const derived =
      entry.derivedFrom && typeof weights.derivedEarState === "function"
        ? weights.derivedEarState(root, entry.catalogId, {
            ...deps.releaseDeps,
            exists: (file) => fsApi.existsSync(file),
          })
        : null;
    const derivedPin =
      derived?.plan && typeof weights.derivedEarPin === "function"
        ? weights.derivedEarPin(entry.catalogId, deps.releaseDeps)
        : null;
    if (derived) {
      if (dir && derived.state !== "needs-release") {
        installed = derived.state === "installed";
        version = installed ? pins.readMarker(dir)?.revision || null : null;
        servedFrom = installed ? weights.RELEASE_LABEL || null : null;
      }
    } else if (dir) {
      const pin = entry.repo ? pins.pinForRepo(entry.repo) : null;
      if (pin) {
        installed = Object.keys(pin.files).every((name) =>
          fsApi.existsSync(nodePath.join(dir, name)),
        );
        version = installed ? pins.readMarker(dir)?.revision || null : null;
        // Which source served the folder on this PC: "FRIDAY release" or "official source" (null when unknown).
        servedFrom =
          installed && typeof weights.servedSource === "function"
            ? weights.servedSource(dir, pin) || null
            : null;
      } else if (entry.file) {
        installed = fsApi.existsSync(nodePath.join(dir, entry.file));
      }
    }
    const pin = derivedPin || (entry.repo ? pins.pinForRepo(entry.repo) : null);
    out.push({
      id: `voice:${entry.catalogId}`,
      kind: "voice-model",
      name: entry.label || entry.catalogId,
      category: entry.kind === "tts" ? "Voice output" : "Voice input",
      installed,
      installedVersion: version,
      servedFrom,
      ...(derived?.state === "needs-release" ? { needsRelease: true, note: derived.text } : {}),
      facts: manifest || null,
      // Internal catalog metadata; the Models and Installer pages never print either field.
      license: manifest?.license || entry.license || null,
      firewallClass: manifest?.firewallClass || entry.firewallClass || null,
      optional: manifest?.fallbackPriority === "experimental",
      byRevision: Boolean(pin),
      // FRIDAY installs the PINNED revision; the model host's newest revision is shown, never installed unseen.
      chain: pin
        ? {
            key: `voice:${entry.catalogId}`,
            sources: [
              // A derived ear never asks the source repository for a newer revision: its files are the release's.
              ...(derived ? [] : [{ kind: "hf-api", repo: manifest?.repo || entry.repo }]),
              { kind: "pinned", version: pin.revision, revision: pin.revision, assets: [] },
            ],
            revisionPolicy: "pinned",
            pinnedVersion: pin.revision,
          }
        : null,
    });
  }
  // File sets (voice-weights.cjs `fileSets`): a model of several single files from the publisher's own host, each one
  // pinned by url, SHA-256 and size. Installed only when every file is on disk at its pinned size; the Models page
  // downloads the whole set and repairs a damaged file (electron/model-download.cjs).
  for (const set of typeof weights.fileSets === "function" ? weights.fileSets() : []) {
    const installed = root
      ? weights.fileSetReady(root, set.id, {
          sizeOf: (file) => (fsApi.existsSync(file) ? fsApi.statSync(file).size : -1),
        })
      : null;
    // The publisher's folder name in the url (quantized_26_11_02) is the version of the pinned set.
    const version = /\/([\w.-]+)\/[^/]+$/.exec(String(set.files[0]?.url || ""))?.[1] || "pinned";
    out.push({
      id: `voice:${set.id}`,
      kind: "voice-model",
      name: set.label,
      category: set.kind === "tts" ? "Voice output" : "Voice input",
      installed,
      installedVersion: installed ? version : null,
      servedFrom: null,
      facts: { catalogId: set.id, kind: set.kind, repo: null, diskBytes: set.diskBytes },
      license: set.license || null,
      firewallClass: set.firewallClass || null,
      optional: set.optional === true,
      byRevision: true,
      chain: {
        key: `voice:${set.id}`,
        sources: [
          {
            kind: "pinned",
            version,
            assets: set.files.map((file) => ({
              name: file.file,
              bytes: file.bytes,
              sha256: file.sha256,
            })),
          },
        ],
        revisionPolicy: "pinned",
        pinnedVersion: version,
      },
    });
  }
  return out;
}

/** The curated chat models (config/local-runners.json): fit only, there is no version feed for a tag. */
function modelRows(runners) {
  const out = [];
  for (const runner of runners || []) {
    for (const model of runner.models || []) {
      out.push({
        id: `model:${runner.id}:${model.tag}`,
        kind: "model",
        name: `${model.tag} (${runner.name || runner.id})`,
        category: "Chat model",
        installed: null,
        installedVersion: null,
        requirements: null,
        optional: false,
        chain: null,
      });
    }
  }
  return out;
}

/**
 * @param deps { root(), facts(), tools(), detected(), packs(), runners(), voice(root), store, fetchImpl, now(),
 *               run(kind, fn), privacy(), online(), log(line), computeCap() }  everything injected; all optional
 */
function createInstallerCatalog(deps = {}) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const run = deps.run || ((_kind, fn) => fn());
  let refreshing = null;
  let lastRefreshAt = null;
  let lastManualAt = null;
  let lastError = null;
  // The last automatic pass that left the cache old (a row whose sources all fail keeps it old for good): the next
  // automatic pass waits 5 min, then 10, 20 ... up to the daily interval. The owner's refresh button is never held.
  let lastTriedAt = null;
  let failedPasses = 0;

  const rootDir = () => (typeof deps.root === "function" ? deps.root() : null);
  const storeOf = () => deps.store || (rootDir() ? vendor.storeFor(rootDir()) : null);
  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (error) {
      log(`installer catalogue: ${String(error?.message || error)}`);
      return fallback;
    }
  };

  function baseRows() {
    const root = rootDir();
    const tools = safe(() => (deps.tools ? deps.tools() : []), []);
    const detected = safe(() => (deps.detected ? deps.detected() : null), null);
    return [
      ...toolRows(tools, detected),
      ...packRows(
        safe(() => (deps.packs ? deps.packs() : []), []),
        tools,
        detected,
      ),
      ...safe(() => (deps.voice ? deps.voice(root) : voiceRows(root)), []),
      ...modelRows(safe(() => (deps.runners ? deps.runners() : []), [])),
    ];
  }

  const factsNow = () => safe(() => (deps.facts ? deps.facts() : null), null);

  /** Which engine runs and the row strings of both (`llama-runtime.engineState`); null when nothing can be read. */
  function ownEngineState() {
    const root = rootDir();
    if (!root) return null;
    const state = safe(
      () =>
        deps.engineState
          ? deps.engineState(root)
          : llama.engineState(root, {
              prefer: deps.enginePrefer ? safe(deps.enginePrefer, "auto") : "auto",
            }),
      null,
    );
    return state
      ? { active: state.active, outdated: Boolean(state.outdated), rows: state.rows }
      : null;
  }

  /** The catalogue as it is now: quick, no network, no probe. */
  function snapshot() {
    const facts = factsNow();
    const store = storeOf();
    const rows = baseRows().map((row) => {
      const cached = row.chain && store ? store.getRow(row.chain.key) : null;
      let latest = null;
      if (cached?.value?.version) {
        latest = {
          ok: true,
          version: row.chain.spec
            ? engineInstall.engineVersion(row.chain.spec, cached.value)
            : String(cached.value.version),
          source: cached.source,
          pinned: false,
          stale: now() - (Number(cached.checkedAt) || 0) >= vendor.FEED_FRESH_MS,
          checkedAt: cached.checkedAt ?? null,
          upstream: cached.value.version,
        };
      } else if (row.chain && (failures.get(row.chain.key) || null)) {
        latest = { ok: false, error: failures.get(row.chain.key) };
      }
      if (row.chain?.revisionPolicy === "pinned" && row.chain.pinnedVersion) {
        latest = {
          ...(latest || { ok: true, source: "pinned", checkedAt: null, stale: false }),
          ok: true,
          version: row.chain.pinnedVersion,
          upstream: latest?.upstream || null,
        };
      } else if (!latest && row.chain) {
        const pin = row.chain.sources.find((s) => s.kind === "pinned");
        if (pin?.version)
          latest = {
            ok: true,
            version: String(pin.version),
            source: "pinned",
            pinned: true,
            stale: false,
            checkedAt: null,
          };
      }
      // How the newest version was reached: this session's answer, else what the stored row recorded, else the pin.
      const via =
        row.chain && latest?.ok !== false && latest
          ? latest.pinned || latest.source === "pinned"
            ? "pinned"
            : reached.get(row.chain.key) || cached?.via || "cache"
          : null;
      const installed = row.installed;
      const fit = fitApi.classify(
        {
          id: row.id,
          requirements: row.requirements,
          facts: row.facts,
          installed: installed === true,
        },
        facts,
      );
      const updateStatus = updateStatusOf({
        installed,
        installedVersion: row.installedVersion,
        latest,
        byRevision: row.byRevision,
      });
      const out = {
        id: row.id,
        kind: row.kind,
        name: row.name,
        category: row.category,
        optional: row.optional,
        installed,
        installedVersion: row.installedVersion,
        latestVersion: latest?.version ?? null,
        updateStatus,
        source: latest?.source ?? null,
        checkedAt: latest?.checkedAt ?? null,
        stale: latest ? Boolean(latest.stale) : false,
        pinnedAnswer: Boolean(latest?.pinned),
        ...(row.home ? { home: row.home } : {}),
        notifyOnly: row.notifyOnly === true,
        ...(row.id && row.kind === "tool" && typeof row.downloadReady === "boolean"
          ? { downloadReady: row.downloadReady, installable: row.downloadReady }
          : {}),
        ...(via ? { via } : {}),
        ...(row.servedFrom ? { servedFrom: row.servedFrom } : {}),
        ...(row.needsRelease ? { needsRelease: true, note: row.note } : {}),
        ...(latest?.ok === false ? { error: latest.error } : {}),
        ...(latest?.upstream && latest.upstream !== latest.version
          ? { upstreamVersion: latest.upstream }
          : {}),
        fit,
      };
      if (row.engine === "llama.cpp" || row.engine === "stable-diffusion.cpp") {
        const plan = llama.backendChain(facts, {
          computeCap: deps.computeCap ? safe(deps.computeCap, null) : null,
        });
        out.engine = {
          chain: plan.chain.map((c) => c.backend),
          skipped: plan.skipped,
          active: rootDir()
            ? engineInstall.detectEngine(rootDir(), engineInstall.ENGINES[row.engine])
            : null,
        };
      }
      if (row.engine === "friday-runtime-llm") out.engineState = ownEngineState();
      return out;
    });
    return {
      ok: true,
      generatedAt: now(),
      refreshing: Boolean(refreshing),
      lastRefreshAt,
      nextManualRefreshInMs: manualWait(),
      online: deps.online ? safe(deps.online, null) : null,
      privacy: Boolean(deps.privacy && safe(deps.privacy, false)),
      hardwareKnown: Boolean(facts && Array.isArray(facts.sources) && facts.sources.length > 0),
      oldestCheckedAt: storeOf()?.oldestCheckedAt?.() ?? null,
      rows,
      split: fitApi.splitByState(rows),
      counts: {
        rows: rows.length,
        updates: rows.filter((r) => r.updateStatus === "update").length,
        errors: rows.filter((r) => r.updateStatus === "error").length,
        stale: rows.filter((r) => r.stale).length,
      },
      doctor: doctorRows(rows),
    };
  }

  const failures = new Map();
  /** How each key's newest version was last reached this session (primary, fallback, cache, pinned). */
  const reached = new Map();
  const manualWait = () => {
    const plan = vendor.planFeedRefresh({
      trigger: "manual",
      sinceManualMs: lastManualAt === null ? null : now() - lastManualAt,
    });
    return plan.refresh ? 0 : plan.retryInMs;
  };

  const backoffMs = () =>
    Math.min(vendor.FEED_FRESH_MS, RETRY_BASE_MS * 2 ** Math.max(0, failedPasses - 1));

  /** The plan for one trigger from the cache's age, privacy, the network, the manual rate limit and the retry wait. */
  function planFor(trigger, jitterMs = 0) {
    const plan = planBase(trigger, jitterMs);
    const manual = trigger === "manual" || trigger === "foreground";
    if (plan.refresh && !manual && failedPasses > 0 && lastTriedAt !== null) {
      const left = lastTriedAt + backoffMs() - now();
      if (left > 0) {
        return {
          refresh: false,
          delayMs: 0,
          retryInMs: left,
          reason: "the last check left some versions unanswered; trying again later",
        };
      }
    }
    return plan;
  }

  function planBase(trigger, jitterMs) {
    const store = storeOf();
    const online = deps.online ? safe(deps.online, null) : null;
    return vendor.planFeedRefresh({
      trigger,
      ageMs: !store || store.oldestCheckedAt() === null ? null : now() - store.oldestCheckedAt(),
      jitterMs,
      privacy: Boolean(deps.privacy && safe(deps.privacy, false)),
      online: online === false ? false : true,
      sinceManualMs: lastManualAt === null ? null : now() - lastManualAt,
    });
  }

  /** Ask the sources. `trigger`: startup, interval, sleep-resume, catalogue-open (daily, jittered by the caller) or manual (once a minute at most). Never throws. */
  async function refresh({ trigger = "startup", jitterMs = 0 } = {}) {
    const store = storeOf();
    if (!store) return { refreshed: false, reason: "no FRIDAY folder is selected" };
    if (refreshing)
      return { refreshed: false, reason: "a refresh is already running", running: true };
    const plan = planFor(trigger, jitterMs);
    if (!plan.refresh) return { refreshed: false, ...plan };
    if (trigger === "manual" || trigger === "foreground") lastManualAt = now();
    const work = baseRows().filter((row) => row.chain);
    // One key may serve several rows (a bundle shares its main wheel with the installer's own lookups).
    const unique = [...new Map(work.map((row) => [row.chain.key, row.chain])).values()];
    const started = now();
    refreshing = (async () => {
      // The jitter is waited out by the caller's own one-shot sleep (main.cjs), so this file owns no timer.
      if (plan.delayMs > 0 && typeof deps.sleep === "function") await deps.sleep(plan.delayMs);
      let ok = 0;
      let failed = 0;
      for (const chain of unique) {
        const sources = chain.sources.filter(
          (s) => s.kind !== "pinned" || chain.revisionPolicy !== "pinned",
        );
        const answer = await run("download", () =>
          vendor.resolveLatest(chain.key, sources, { store, fetchImpl: deps.fetchImpl, now }),
        ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
        if (answer.ok && answer.via) reached.set(chain.key, answer.via);
        if (answer.ok && !answer.stale && !answer.pinned) {
          ok += 1;
          failures.delete(chain.key);
        } else if (answer.ok) {
          failed += 1;
        } else {
          failed += 1;
          failures.set(chain.key, answer.error || "no source answered");
        }
      }
      store.flush();
      lastRefreshAt = now();
      lastTriedAt = lastRefreshAt;
      const oldest = store.oldestCheckedAt();
      failedPasses =
        oldest === null || lastRefreshAt - oldest >= vendor.FEED_FRESH_MS ? failedPasses + 1 : 0;
      lastError =
        failed === unique.length && unique.length > 0 ? "no official source answered" : null;
      log(
        `installer versions refreshed: ${ok} answered, ${failed} used the cache or failed (${now() - started} ms)`,
      );
      return { refreshed: true, ok, failed, total: unique.length };
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** The owner's refresh button: answers at once with whether it started, and works in the background. */
  function requestRefresh(trigger = "manual") {
    if (refreshing)
      return { started: false, running: true, reason: "a refresh is already running" };
    if (!storeOf()) return { started: false, reason: "no FRIDAY folder is selected" };
    const plan = planFor(trigger);
    if (!plan.refresh) return { started: false, ...plan };
    void refresh({ trigger }).catch(() => {});
    return { started: true, reason: plan.reason };
  }

  /** The quick answer the IPC gives; starts a background refresh when the cache is old and the plan allows it. */
  function catalog({ background = true } = {}) {
    const snap = snapshot();
    if (background && !refreshing) {
      const plan = planFor("catalogue-open");
      if (plan.refresh && rootDir()) void refresh({ trigger: "catalogue-open" }).catch(() => {});
    }
    return { ...snap, refreshing: Boolean(refreshing), lastError };
  }

  return {
    snapshot,
    catalog,
    refresh,
    requestRefresh,
    planUpdate,
    status: () => ({
      refreshing: Boolean(refreshing),
      lastRefreshAt,
      lastManualAt,
      lastTriedAt,
      failedPasses,
    }),
  };
}

/** Doctor rows for the pieces that can be repaired: the CUDA runtime pair and the installed engines. */
function doctorRows(rows) {
  const out = [];
  const pick = (id) => rows.find((r) => r.id === id);
  const libs = pick("CUDA runtime libraries");
  if (libs) {
    const needed = libs.fit.state !== "unsupported";
    out.push({
      id: "cuda-libs",
      label: "CUDA runtime libraries (cuBLAS 12, cuDNN 9)",
      status: !needed ? "skip" : libs.installed ? "ok" : "warn",
      detail: !needed
        ? libs.fit.reasons[0]?.text || "no NVIDIA GPU"
        : libs.installed
          ? `installed ${libs.installedVersion || ""}`.trim()
          : "not installed: speech and ONNX stay on the CPU",
      repair: needed ? { id: libs.id, action: libs.installed ? "repair" : "install" } : null,
    });
  }
  for (const id of ["llama.cpp", "stable-diffusion.cpp", "FFmpeg (LGPL, portable)"]) {
    const row = pick(id);
    if (!row) continue;
    out.push({
      id: `engine:${id}`,
      label: row.name,
      status: row.installed ? "ok" : "skip",
      detail: row.installed
        ? `${row.installedVersion || "installed"}${row.engine?.active?.backend ? `, ${row.engine.active.backend} build` : ""}`
        : "optional: not installed",
      repair: row.installed ? { id, action: "repair" } : null,
    });
  }
  // A bundled runtime with a newer version out: shown, never installed (it changes with a FRIDAY update).
  for (const row of rows) {
    if (row.notifyOnly !== true || row.updateStatus !== "update") continue;
    out.push({
      id: `bundled:${row.id}`,
      label: `${row.name}: a newer version is available`,
      status: "warn",
      detail: `installed ${row.installedVersion || "unknown"}, newest ${row.latestVersion}; bundled with FRIDAY, so it changes only with a FRIDAY update`,
      repair: null,
    });
  }
  const ownRow = pick("friday-runtime-llm");
  if (ownRow) {
    const state = ownRow.engineState;
    const names = state?.rows || llmSelect.rowNames({});
    out.push({
      id: "engine:friday-runtime-llm",
      label: ownRow.installed ? names.own : "FRIDAY Runtime LLM (own build, native)",
      status: !ownRow.installed ? "skip" : state?.outdated ? "warn" : "ok",
      detail: !ownRow.installed
        ? "optional: not installed, the official llama.cpp runs FRIDAY Core"
        : [names.status, names.outdated].filter(Boolean).join("; ") ||
          `installed ${ownRow.installedVersion || ""}`.trim(),
      repair: { id: ownRow.id, action: ownRow.installed ? "repair" : "install" },
    });
  }
  return out;
}

/**
 * The setup notices (scripts/setup-notices.cjs, <root>/runtime/setup-notices.json: what setup, Doctor and the build could
 * not finish) as the catalogue's `setupNotices`: each open notice with the catalogue row or the Doctor row that finishes
 * it (`installManagerId` is a row id such as `voice:<id>` or `model:ollama:<tag>`, or a Doctor id such as `cuda-libs`).
 * A notice whose row is installed, or whose Doctor row is ok, is cleared from the record: the inventory is the truth.
 * Only the reader and the clear are used here; nothing is written to the record otherwise. Never throws; a catalogue
 * that is not a list comes back as it was.
 *
 * @param {object|null} catalog   the catalogue payload (rows, doctor)
 * @param {{root?: string|null, notices?: {readNotices: Function, clearNotice: Function}|null}} options
 */
function withSetupNotices(catalog, { root = null, notices = null } = {}) {
  if (!catalog || !Array.isArray(catalog.rows)) return catalog;
  const open = [];
  try {
    const list = root && notices ? notices.readNotices(root) : [];
    const doctor = Array.isArray(catalog.doctor) ? catalog.doctor : [];
    for (const notice of list) {
      const row = notice.installManagerId
        ? catalog.rows.find((item) => item.id === notice.installManagerId)
        : null;
      const doctorRow =
        !row && notice.installManagerId
          ? doctor.find((item) => item.id === notice.installManagerId)
          : null;
      if (row?.installed === true || doctorRow?.status === "ok") {
        try {
          notices.clearNotice(notice.id, { root });
        } catch {
          /* a record that cannot be written only stays listed until the next read */
        }
        continue;
      }
      open.push({
        id: notice.id,
        kind: notice.kind,
        label: notice.label,
        reason: notice.reason,
        installManagerId: notice.installManagerId,
        repair: notice.repair,
        at: notice.at,
        rowId: row ? row.id : null,
        doctorId: doctorRow ? doctorRow.id : null,
      });
    }
  } catch {
    return { ...catalog, setupNotices: [] };
  }
  return { ...catalog, setupNotices: open };
}

module.exports = {
  withSetupNotices,
  UPDATE_STATUSES,
  AUTONOMY,
  updateStatusOf,
  planUpdate,
  createInstallerCatalog,
  toolRows,
  packRows,
  voiceRows,
  modelRows,
  doctorRows,
  chainOfTool,
};
