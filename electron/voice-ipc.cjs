"use strict";

/**
 * The small voice bridges that main.cjs registers: restart the local speaker (the supervisor's restart-tts remedy)
 * and Windows' own microphone privacy answer. Every function takes what it touches (the voice module, Electron's
 * systemPreferences and shell, the path scrubber) so a test can drive it with fakes, and none of them throws:
 * a failure is an answer the renderer can show.
 */

/** The one Settings page the microphone link may open. Nothing else is ever handed to the shell. */
const MIC_PRIVACY_LINK = "ms-settings:privacy-microphone";

const MIC_ACCESS = new Set(["granted", "denied", "restricted", "not-determined", "unknown"]);

/**
 * Restart the local speaker.
 *   { ok: true,  state: "restarted" }    a running speaker was dropped; the next clause starts a fresh one
 *   { ok: true,  state: "not-running" }  nothing was running, nothing to do
 *   { ok: false, state: "breaker-open" } the speaker keeps crashing and is paused; a restart must not bypass that
 *   { ok: false, state: "error", error } a short, path-free text (or a fixed code)
 */
async function restartTts({ neuralVoice, scrubPaths } = {}) {
  if (
    !neuralVoice ||
    typeof neuralVoice.restartSpeaker !== "function" ||
    typeof neuralVoice.speakerHealth !== "function"
  ) {
    return { ok: false, state: "error", error: "voice-unavailable" };
  }
  try {
    const state = String(neuralVoice.speakerHealth()?.state || "");
    if (state === "breaker-open") return { ok: false, state: "breaker-open" };
    if (state === "cold" || state === "stopped") return { ok: true, state: "not-running" };
    const done = neuralVoice.restartSpeaker();
    return done && done.ok === false
      ? { ok: false, state: "error", error: "restart-failed" }
      : { ok: true, state: "restarted" };
  } catch (error) {
    const text = String(error && error.message ? error.message : error);
    let reason = "restart-failed";
    if (typeof scrubPaths === "function") {
      try {
        reason = String(scrubPaths(text)).slice(0, 200) || reason;
      } catch {
        /* a fixed code is the answer */
      }
    }
    return { ok: false, state: "error", error: reason };
  }
}

/** What Windows says about microphone access for this app: one of five words, `unknown` when it cannot say. */
function micAccessStatus({ systemPreferences } = {}) {
  let status = "unknown";
  try {
    if (systemPreferences && typeof systemPreferences.getMediaAccessStatus === "function") {
      const answer = systemPreferences.getMediaAccessStatus("microphone");
      if (typeof answer === "string" && MIC_ACCESS.has(answer)) status = answer;
    }
  } catch {
    status = "unknown";
  }
  return { ok: true, status };
}

/** Open the microphone privacy page. Only the exact string is opened; any other value is refused. */
async function openMicPrivacySettings({ shell } = {}, url) {
  if (url !== undefined && url !== MIC_PRIVACY_LINK) return { ok: false, error: "refused" };
  try {
    if (!shell || typeof shell.openExternal !== "function") throw new Error("no shell");
    await shell.openExternal(MIC_PRIVACY_LINK);
    return { ok: true };
  } catch {
    return { ok: false, error: "open-failed" };
  }
}

module.exports = { MIC_PRIVACY_LINK, restartTts, micAccessStatus, openMicPrivacySettings };
