/**
 * A default bound so a renderer invoke cannot wait forever.
 * Downloads, imports, and doctor repairs keep their own longer work.
 */
const DEFAULT_MS = 30_000;

function timeoutMs(channel) {
  const name = String(channel || "");
  if (
    name.startsWith("tools:") ||
    name.startsWith("import:") ||
    name.startsWith("updater:") ||
    name === "doctor:run" ||
    name === "doctor:fix" ||
    name.startsWith("models:pull") ||
    name.startsWith("models:download")
  ) {
    return 0;
  }
  return DEFAULT_MS;
}

function withIpcTimeout(channel, work, ms = timeoutMs(channel)) {
  const promise = Promise.resolve().then(() => work);
  if (!ms) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ipc timed out: ${channel}`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

module.exports = { DEFAULT_MS, timeoutMs, withIpcTimeout };
