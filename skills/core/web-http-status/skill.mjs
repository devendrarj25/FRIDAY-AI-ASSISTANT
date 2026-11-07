// FRIDAY · skill: web-http-status
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Explains HTTP status codes and the network and file error names that appear in logs, with what to try.

const HTTP = {
  100: ["Continue", "The server got the request headers; the client may send the body."],
  101: ["Switching Protocols", "The connection is being upgraded (WebSocket)."],
  200: ["OK", "The request worked."],
  201: ["Created", "The request worked and made a new resource."],
  202: ["Accepted", "Received and queued; the work is not finished yet."],
  204: ["No Content", "It worked and there is nothing to return."],
  206: ["Partial Content", "Only a range of the file was returned (resumed or chunked download)."],
  301: ["Moved Permanently", "The address changed for good: use the new Location."],
  302: ["Found", "Temporary redirect: follow Location, keep the old address."],
  303: ["See Other", "Fetch the Location with GET."],
  304: ["Not Modified", "Your cached copy is still current."],
  307: ["Temporary Redirect", "Repeat the same request at Location."],
  308: ["Permanent Redirect", "Repeat the same request at the new Location, for good."],
  400: [
    "Bad Request",
    "The server could not understand the request: check the URL, headers and body.",
  ],
  401: ["Unauthorized", "Credentials are missing or wrong: sign in or send a valid key or token."],
  403: ["Forbidden", "Understood but refused: no permission, a blocked region, or a firewall."],
  404: [
    "Not Found",
    "No such address: check the spelling or whether the link was removed or moved.",
  ],
  405: ["Method Not Allowed", "This address does not accept that method (GET, POST...)."],
  406: ["Not Acceptable", "The server cannot give what the Accept headers ask for."],
  408: ["Request Timeout", "The server gave up waiting for the request."],
  409: [
    "Conflict",
    "The request clashes with the current state (a duplicate or an edit conflict).",
  ],
  410: ["Gone", "Removed on purpose and not coming back."],
  413: ["Content Too Large", "The body is bigger than the server allows."],
  414: ["URI Too Long", "The address is too long."],
  415: ["Unsupported Media Type", "The server does not accept this content type."],
  418: ["I'm a teapot", "A joke status; some servers use it to refuse bots."],
  422: ["Unprocessable Content", "Well-formed but the values are invalid."],
  429: ["Too Many Requests", "Rate limit: slow down and retry after the Retry-After time."],
  431: ["Request Header Fields Too Large", "Headers or cookies are too big."],
  451: ["Unavailable For Legal Reasons", "Blocked for a legal reason."],
  500: [
    "Internal Server Error",
    "The server failed on its side: retry later or tell the site owner.",
  ],
  501: ["Not Implemented", "The server does not support this request."],
  502: ["Bad Gateway", "A proxy or gateway got a bad answer from the server behind it."],
  503: ["Service Unavailable", "Overloaded or down for maintenance: retry later."],
  504: ["Gateway Timeout", "A proxy waited too long for the server behind it."],
  505: ["HTTP Version Not Supported", "The server does not speak this HTTP version."],
  507: ["Insufficient Storage", "The server is out of storage."],
  511: ["Network Authentication Required", "A captive portal (Wi-Fi login) is in the way."],
  520: [
    "Web Server Returned an Unknown Error (Cloudflare)",
    "Cloudflare got an empty or unexpected answer from the origin.",
  ],
  521: ["Web Server Is Down (Cloudflare)", "Cloudflare could not connect to the origin."],
  522: [
    "Connection Timed Out (Cloudflare)",
    "Cloudflare reached the origin but it did not answer in time.",
  ],
  523: ["Origin Is Unreachable (Cloudflare)", "Cloudflare cannot route to the origin."],
  524: [
    "A Timeout Occurred (Cloudflare)",
    "The origin answered the connection but was too slow to reply.",
  ],
  525: ["SSL Handshake Failed (Cloudflare)", "Cloudflare could not complete TLS with the origin."],
  526: ["Invalid SSL Certificate (Cloudflare)", "The origin's certificate is not valid."],
};

const ERRORS = {
  ENOTFOUND: [
    "DNS lookup failed: the host name does not exist or cannot be resolved.",
    "Check the spelling, the connection and the DNS or VPN settings.",
  ],
  EAI_AGAIN: ["A temporary DNS failure.", "Retry; check the connection or the DNS server."],
  ECONNREFUSED: [
    "The host answered but nothing is listening on that port.",
    "The service is not running, or the port or address is wrong.",
  ],
  ECONNRESET: [
    "The other side closed the connection abruptly.",
    "Retry; a proxy, firewall or flaky network may be cutting it.",
  ],
  ETIMEDOUT: [
    "The connection or the answer took too long.",
    "Check the network, proxy and firewall; retry with a longer timeout.",
  ],
  EPIPE: [
    "Writing to a connection that was already closed.",
    "The other side hung up first; retry.",
  ],
  EADDRINUSE: [
    "The port is already used by another program.",
    "Stop that program or choose another port.",
  ],
  EACCES: ["Permission denied.", "Run with the right permission or pick a folder you own."],
  EPERM: [
    "The operation is not permitted (a locked file, antivirus or policy).",
    "Close the program using it or run as administrator.",
  ],
  ENOENT: ["No such file or directory.", "Check the path and spelling."],
  ENOSPC: ["No space left on the device.", "Free disk space."],
  EMFILE: ["Too many open files in this process.", "Close files or raise the limit."],
  CERT_HAS_EXPIRED: [
    "The server's TLS certificate has expired.",
    "The site owner must renew it; check your PC clock is correct.",
  ],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: [
    "The certificate chain cannot be verified.",
    "A proxy or antivirus may be re-signing traffic: trust its root certificate or fix the chain.",
  ],
  DEPTH_ZERO_SELF_SIGNED_CERT: [
    "The server uses a self-signed certificate.",
    "Trust it deliberately, or use a properly signed one.",
  ],
  SELF_SIGNED_CERT_IN_CHAIN: [
    "A certificate in the chain is self-signed (often a corporate proxy).",
    "Add the proxy's root certificate to the trust store.",
  ],
  ERR_TLS_CERT_ALTNAME_INVALID: [
    "The certificate is for a different host name.",
    "Use the host name the certificate was issued for.",
  ],
};

export async function run(input = {}) {
  const text = String(input?.code ?? input?.text ?? input?.prompt ?? "");
  const results = [];
  for (const m of text.matchAll(/(?<![\d.])([1-5]\d{2})(?![\d.])/g)) {
    const row = HTTP[m[1]];
    if (row && !results.some((r) => r.code === m[1]))
      results.push({
        kind: "HTTP status",
        code: m[1],
        name: row[0],
        meaning: row[1],
        class: ["informational", "success", "redirect", "client error", "server error"][
          Number(m[1][0]) - 1
        ],
      });
  }
  const upper = text.toUpperCase();
  for (const [name, [meaning, tryThis]] of Object.entries(ERRORS)) {
    if (upper.includes(name)) results.push({ kind: "error name", code: name, meaning, tryThis });
  }
  if (!results.length) {
    const unknownHttp = (text.match(/(?<![\d.])[1-5]\d{2}(?![\d.])/) ?? [])[0];
    return {
      ok: false,
      error: unknownHttp
        ? `${unknownHttp} is not in the list of common status codes here. Check the server's own documentation.`
        : "Give an HTTP status (404, 502) or an error name (ECONNRESET, ENOTFOUND, CERT_HAS_EXPIRED).",
    };
  }
  return {
    ok: true,
    answer: results
      .map((r) =>
        r.kind === "HTTP status"
          ? `${r.code} ${r.name}: ${r.meaning}`
          : `${r.code}: ${r.meaning} ${r.tryThis}`,
      )
      .join("\n"),
    results,
    tip: "4xx means the request or your access is the problem; 5xx means the server is. A 429 or 503 usually clears if you wait and retry.",
  };
}

export default run;
