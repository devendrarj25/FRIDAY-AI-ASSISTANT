/**
 * Honest status for local models.
 *
 * Four separate facts, never one "installed" flag:
 *   downloaded   a model file or a runner model exists on this PC
 *   installed    the runner program can be launched
 *   running      the runner answers on its local port
 *   servable     the runner lists the model as loaded and ready
 *
 * Pure. models.inventory() and models.engineStatus() are the only inputs, so
 * the Models page, the Doctor and the tests all read the same words.
 */
"use strict";

const STATES = ["serving", "not-loaded", "runner-stopped", "runner-not-installed", "failed"];

const BENIGN_ERROR =
  /not running|ECONNREFUSED|ECONNRESET|not reachable|fetch failed|timed? ?out|no model/i;

function describeRunner(engine, provider) {
  const name = engine.name || provider?.name || engine.id;
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const servable = models.filter((model) => model.loaded !== false && !model.notice);
  let state;
  let line;
  if (engine.running && servable.length) {
    state = "serving";
    line = `${name} is serving ${servable.length} model${servable.length === 1 ? "" : "s"}.`;
  } else if (engine.running) {
    state = "not-loaded";
    line = models.length
      ? `${name} is running, but no model is loaded. Load one in ${name}.`
      : `${name} is running with no models. Pull or import one.`;
  } else if (engine.canStart) {
    state = "runner-stopped";
    line = `${name} is installed but stopped. Start it to serve your downloaded models.`;
  } else if (/not installed|not available on PATH/i.test(engine.hint || "")) {
    state = "runner-not-installed";
    line = `${name} is not installed on this PC.`;
  } else if (provider?.error && !BENIGN_ERROR.test(String(provider.error))) {
    state = "failed";
    line = `${name} failed: ${String(provider.error).slice(0, 160)}`;
  } else {
    state = "runner-stopped";
    line = `${name} is stopped. ${engine.hint || "Start it yourself."}`.trim();
  }
  return {
    id: engine.id,
    name,
    running: Boolean(engine.running),
    canStart: Boolean(engine.canStart) && !engine.running,
    servable: servable.length,
    models: models.length,
    state,
    line,
  };
}

function describeLocal({ inventory = null, engines = [] } = {}) {
  const providers = Array.isArray(inventory?.providers) ? inventory.providers : [];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const runners = (Array.isArray(engines) ? engines : []).map((engine) =>
    describeRunner(engine, byId.get(engine.id)),
  );
  const models = [];
  for (const runner of runners) {
    for (const model of byId.get(runner.id)?.models || []) {
      const loaded = model.loaded !== false && !model.notice;
      models.push({
        id: `${runner.id}/${model.id}`,
        runner: runner.id,
        state: loaded ? "serving" : "not-loaded",
        line: loaded
          ? `${model.id}: serving in ${runner.name}`
          : `${model.id}: downloaded, not loaded in ${runner.name}`,
      });
    }
  }
  const startable = runners.find((runner) => runner.canStart);
  const serving = runners.find((runner) => runner.state === "serving");
  for (const file of byId.get("local")?.models || []) {
    const label = file.name || file.id;
    models.push({
      id: `file/${file.id || file.name}`,
      runner: startable?.id || "",
      state: startable ? "runner-stopped" : "runner-not-installed",
      line: startable
        ? `${label}: downloaded, ${startable.name} is stopped. Start it to serve this model.`
        : serving
          ? `${label}: downloaded, not imported into ${serving.name} yet.`
          : `${label}: downloaded, but no runner is installed or running to serve it.`,
    });
  }
  return { at: Date.now(), runners, models };
}

module.exports = { STATES, describeLocal, describeRunner };
