/**
 * What Chromium is really doing with the graphics card, in one line for the boot screen and the log.
 *
 * `app.getGPUFeatureStatus()` answers per feature ("enabled_on", "disabled_software", "unavailable_off" ...). A window
 * that is drawn in software looks like a slow app on a fast PC, so the boot screen says plainly whether the card is
 * used and, when it is not, why (a driver fault FRIDAY remembered, a blocklisted driver, or the software switch).
 * Pure: the status object is passed in.
 */
"use strict";

const USED = /^enabled/;

/**
 * @param status the object `app.getGPUFeatureStatus()` returns (or null when unavailable)
 * @param opts   `softwareMode`: FRIDAY itself switched to software drawing after repeated graphics-driver crashes
 */
function summarizeGpu(status, { softwareMode = false } = {}) {
  if (softwareMode) {
    return {
      accelerated: false,
      text: "Graphics: software drawing (the graphics driver crashed before; FRIDAY_FORCE_GPU=1 tries the card again)",
    };
  }
  if (!status || typeof status !== "object") {
    return { accelerated: null, text: "Graphics: status not reported yet" };
  }
  const compositing = String(status.gpu_compositing || "");
  const raster = String(status.rasterization || "");
  if (USED.test(compositing)) {
    const parts = ["compositing"];
    if (USED.test(raster)) parts.push("rasterization");
    if (USED.test(String(status.video_decode || ""))) parts.push("video");
    return { accelerated: true, text: `Graphics: card in use (${parts.join(", ")})` };
  }
  const why = compositing || raster || "unknown";
  return {
    accelerated: false,
    text: `Graphics: window drawn in software (${why}); the card is not used for the window`,
  };
}

module.exports = { summarizeGpu };
