async function run({ url } = {}) {
  if (!url) return { ok: false, error: "A URL is required." };
  try {
    const parsed = new URL(String(url));
    return {
      ok: true,
      protocol: parsed.protocol,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
