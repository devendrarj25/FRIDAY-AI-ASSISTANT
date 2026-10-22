/**
 * Report-only Content-Security-Policy for the packaged page.
 * Enforcing mode stays off unless FRIDAY_CSP_ENFORCE=1. A violation is kept
 * here for the Doctor. The policy string is static: nothing from a page or
 * a request is copied into a header.
 */
const MAX = 40;
const violations = [];

function reportOnlyHeader() {
  return [
    "default-src 'self' friday:",
    "base-uri 'self' friday:",
    "object-src 'none'",
    "frame-src 'none'",
    "script-src 'self' friday:",
    "style-src 'self' friday: 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' friday: data: https://fonts.gstatic.com",
    "img-src 'self' friday: blob: data:",
    "media-src 'self' friday: blob: data:",
    "worker-src 'self' friday: blob:",
    // The status bar network meter (src/lib/friday/network.ts) measures
    // latency and speed against these three hosts and nothing else.
    "connect-src 'self' friday: blob: data: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https://cloudflare.com https://www.gstatic.com https://speed.cloudflare.com",
  ].join("; ");
}

function enforcing() {
  return process.env.FRIDAY_CSP_ENFORCE === "1";
}

function headerName() {
  return enforcing() ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

function noteViolation(entry = {}) {
  const row = {
    at: Date.now(),
    directive: String(entry.directive || entry.effectiveDirective || "").slice(0, 80),
    blocked: String(entry.blocked || entry.blockedURI || "").slice(0, 180),
    source: String(entry.source || entry.sourceFile || "").slice(0, 180),
  };
  violations.unshift(row);
  if (violations.length > MAX) violations.length = MAX;
  return row;
}

function listViolations() {
  return violations.slice();
}

function doctorCheck() {
  const rows = listViolations();
  const latest = rows[0];
  return {
    id: "csp:report-only",
    label: "Content Security Policy",
    group: "FRIDAY",
    status: rows.length ? "Warning" : "Ready",
    detail: rows.length
      ? `${rows.length} report-only violation(s). Latest: ${latest.directive} ${latest.blocked}`.trim()
      : enforcing()
        ? "Enforcing. Remote scripts stay blocked."
        : "Report-only. Enforcing mode stays off until you turn it on.",
    fixable: false,
  };
}

function applyDocumentHeaders(headers) {
  const next = { ...(headers || {}) };
  next[headerName()] = reportOnlyHeader();
  return next;
}

module.exports = {
  reportOnlyHeader,
  enforcing,
  headerName,
  noteViolation,
  listViolations,
  doctorCheck,
  applyDocumentHeaders,
};
