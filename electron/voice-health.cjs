/**
 * Zero-spend voice probe. The startup-task registry is the only starter.
 * Network checks pause in Privacy mode. Local status still runs.
 */
const VOICE_HEALTH_MS = 5 * 60 * 1000;
let timer = null;
let wait = null;
let lastAt = 0;

function planVoiceHealth(input = {}) {
  const privacy = input.privacy === true;
  const age = Number(input.ageMs);
  const jitter = Math.abs(Number(input.jitterMs) || 0) % 60_000;
  const fresh = Number.isFinite(age) && age >= 0 && age < VOICE_HEALTH_MS;
  if (fresh) {
    return {
      run: false,
      local: true,
      network: false,
      delayMs: jitter,
      reason: "voice health cache is fresh",
    };
  }
  return {
    run: true,
    local: true,
    network: !privacy,
    delayMs: jitter,
    reason: privacy ? "local voice probe — network paused" : "local voice probe",
  };
}

function startVoiceHealthProbe(run, readPrivacy) {
  if (timer || typeof run !== "function") return false;
  timer = setInterval(() => {
    const privacy = typeof readPrivacy === "function" ? readPrivacy() === true : false;
    const plan = planVoiceHealth({
      privacy,
      ageMs: lastAt ? Date.now() - lastAt : Number.POSITIVE_INFINITY,
      jitterMs: Math.floor(Math.random() * 60_000),
    });
    if (!plan.run) return;
    if (wait) clearTimeout(wait);
    wait = setTimeout(() => {
      wait = null;
      lastAt = Date.now();
      try {
        run(plan);
      } catch {
        /* the next tick reports again */
      }
    }, plan.delayMs);
    if (wait.unref) wait.unref();
  }, VOICE_HEALTH_MS);
  if (timer.unref) timer.unref();
  return true;
}

function stopVoiceHealthProbe() {
  if (timer) clearInterval(timer);
  if (wait) clearTimeout(wait);
  timer = null;
  wait = null;
}

module.exports = {
  VOICE_HEALTH_MS,
  planVoiceHealth,
  startVoiceHealthProbe,
  stopVoiceHealthProbe,
};
