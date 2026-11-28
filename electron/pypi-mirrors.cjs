"use strict";

/**
 * The one place that knows how the PyPI mirrors of config/download-hosts.json (`pypiMirrors`) are validated and how
 * a files.pythonhosted.org wheel URL maps onto each of them. Pure: no electron import, no file read; the engine
 * installer and scripts/wheelhouse.cjs each read the config their own way and pass the list in.
 */

const WHEEL_HOST = "files.pythonhosted.org";

/** The usable mirrors of a `pypiMirrors` list, in order: [{ id, packages, simple }], https roads only. */
function validMirrors(list) {
  return (Array.isArray(list) ? list : []).filter(
    (m) =>
      m &&
      /^https:\/\//.test(String(m.packages || "")) &&
      /^https:\/\//.test(String(m.simple || "")),
  );
}

/** The same file on each mirror: the path after /packages/ is content-addressed, so it is the same on every road. */
function mirrorUrls(url, mirrors) {
  const text = String(url || "");
  const at = text.indexOf("/packages/");
  if (!text.startsWith(`https://${WHEEL_HOST}/`) || at < 0) return [];
  const rest = text.slice(at + "/packages/".length);
  return (mirrors || []).map((m) => `${String(m.packages).replace(/\/+$/, "")}/${rest}`);
}

module.exports = { WHEEL_HOST, validMirrors, mirrorUrls };
