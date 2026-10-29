/**
 * Which URLs the FRIDAY window may navigate to.
 * The packaged UI is friday://app. A dev server is allowed only for the
 * origin in FRIDAY_DEV_URL. file: and other hosts are refused.
 */
"use strict";

function navigationAllowed(url, devUrl) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol === "friday:") return parsed.hostname === "app";
  if (parsed.protocol === "about:" && parsed.pathname === "blank") return true;
  if (!devUrl) return false;
  let dev;
  try {
    dev = new URL(String(devUrl));
  } catch {
    return false;
  }
  return parsed.origin === dev.origin;
}

module.exports = { navigationAllowed };
