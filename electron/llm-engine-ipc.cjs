/**
 * The two IPC channels of the dual chat engine, kept out of main.cjs so they can be tested without Electron.
 *
 *  - `llm-engine:state` (read): both engines, the active one, the stored bench, the row texts of the Doctor and the
 *    Install Manager, and the adapter line ("adapter retrain needed" when the base file changed). The owner's
 *    `brain.engine.prefer` is passed into `engineState`; a valid word in the payload wins over the stored one (the
 *    page has just changed it and the save is still on its way to the disk).
 *  - `llm-engine:bench` (long-running, owner-started): one bench at a time, engines one after the other, never
 *    during a voice turn, stopped at once by `{ stop: true }`, and capped so it can never run for ever.
 *
 * Nothing here starts a timer that outlives a bench, and nothing leaves this PC.
 */

const PREFER = ["auto", "own", "official"];
const BENCH_CAP_MS = 20 * 60 * 1000;

const preferOf = (value) => (PREFER.includes(value) ? value : null);
const messageOf = (error) => (error && error.message ? String(error.message) : String(error));

/**
 * @param {object} deps
 * @param {object} deps.runtime llama-runtime.cjs (`engineState`, `runBench`, `corePlan`)
 * @param {object} deps.finetune finetune.cjs (`resolveActive`)
 * @param {object} deps.core friday-core.cjs (`planAssets`)
 * @param {() => string} deps.root the FRIDAY data root
 * @param {() => string|undefined} deps.readPrefer the stored `brain.engine.prefer`
 * @param {() => boolean} [deps.voiceBusy] true while a voice turn runs
 * @param {object|null} [deps.governor] the resource governor (the bench takes its lease from it)
 * @param {() => boolean} [deps.coreLoaded] FRIDAY Core holds the model in RAM now
 * @param {() => Promise<unknown>} [deps.stopCore] stops Core so the bench fits
 * @param {() => Promise<unknown>} [deps.resumeCore] starts Core again when it was on
 */
function createLlmEngineIpc(deps) {
  let running = null;

  /** The pinned SHA-256 of the installed base model, or null when no Core model is present. */
  function baseSha(root) {
    try {
      const plan = deps.runtime.corePlan(root);
      if (!plan.ok) return null;
      const planned = deps.core.planAssets(root, plan.variant);
      const model = planned.ok ? planned.assets.find((a) => a.kind === "model" && a.present) : null;
      return model ? model.sha256 : null;
    } catch {
      return null;
    }
  }

  function adapterOf(root) {
    try {
      const active = deps.finetune.resolveActive(baseSha(root));
      return { id: active.id ?? null, scale: active.scale ?? 0, reason: active.reason ?? null };
    } catch {
      return { id: null, scale: 0, reason: null };
    }
  }

  function state(payload) {
    try {
      const root = deps.root();
      const prefer = preferOf(payload && payload.prefer) || preferOf(deps.readPrefer?.()) || "auto";
      const out = deps.runtime.engineState(root, { prefer });
      const adapter = adapterOf(root);
      const doctor = Array.isArray(out.doctor) ? [...out.doctor] : [];
      if (adapter.reason) {
        doctor.push({
          id: "adapter",
          name: adapter.reason,
          ok: false,
          detail: `${adapter.id} is paused (scale 0) until the base model matches again`,
        });
      }
      return { ...out, ok: true, doctor, adapter, benchRunning: Boolean(running) };
    } catch (error) {
      return { ok: false, error: messageOf(error), benchRunning: Boolean(running) };
    }
  }

  async function bench(payload) {
    if (payload && payload.stop === true) {
      if (running) running.controller.abort();
      return { ok: true, stopping: Boolean(running) };
    }
    if (running) return { ok: false, ran: false, reason: "already-running" };
    if (deps.voiceBusy?.() === true) return { ok: false, ran: false, reason: "voice-turn" };
    const controller = new AbortController();
    const cap = setTimeout(() => controller.abort(), BENCH_CAP_MS);
    running = { controller };
    try {
      return await deps.runtime.runBench(deps.root(), {
        ownerStarted: true,
        signal: controller.signal,
        voiceBusy: deps.voiceBusy,
        governor: deps.governor,
        coreLoaded: deps.coreLoaded,
        stopCore: deps.stopCore,
        resumeCore: deps.resumeCore,
      });
    } catch (error) {
      return { ok: false, ran: false, reason: "error", error: messageOf(error) };
    } finally {
      clearTimeout(cap);
      running = null;
    }
  }

  return { state, bench };
}

module.exports = { createLlmEngineIpc, BENCH_CAP_MS };
