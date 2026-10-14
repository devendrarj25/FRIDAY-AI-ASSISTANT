/**
 * One download allowlist and one transfer state machine.
 * Remote bytes are HTTPS on an allowlisted host. Loopback HTTP stays for the
 * local daemon and for tests. A redirect off the list aborts.
 */
const fs = require("node:fs");
const path = require("node:path");

const HOSTS = require("../config/download-hosts.json");

const TRANSFER_STATUSES = [
  "not-installed",
  "queued",
  "downloading",
  "paused",
  "verifying",
  "installing",
  "installed",
  "active",
  "failed",
  "update-available",
];

function hostnameOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function allowedHostSet(extraHosts = []) {
  const set = new Set((HOSTS.hosts || []).map((host) => String(host).toLowerCase()));
  for (const extra of extraHosts) {
    const host = hostnameOf(extra) || String(extra || "").toLowerCase();
    if (host && set.has(host)) set.add(host);
  }
  return set;
}

function assertAllowedUrl(raw, extraHosts = []) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    const error = new Error("invalid download url");
    error.code = "BAD_URL";
    throw error;
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = (HOSTS.loopbackHttp || []).includes(host);
  if (parsed.protocol === "http:" && loopback) return parsed;
  if (parsed.protocol !== "https:") {
    const error = new Error("only https downloads are allowed");
    error.code = "UNSAFE_URL";
    throw error;
  }
  if (!allowedHostSet(extraHosts).has(host)) {
    const error = new Error(`host is not allowlisted: ${host}`);
    error.code = "OFF_ALLOWLIST";
    throw error;
  }
  return parsed;
}

async function fetchAllowlisted(raw, options = {}, extraHosts = []) {
  let current = String(raw);
  for (let hop = 0; hop < 5; hop += 1) {
    assertAllowedUrl(current, extraHosts);
    const res = await fetch(current, { ...options, redirect: "manual" });
    const status = res.status;
    if (status >= 300 && status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        const error = new Error("redirect missing location");
        error.code = "OFF_ALLOWLIST";
        throw error;
      }
      current = new URL(location, current).href;
      continue;
    }
    return { res, url: current };
  }
  const error = new Error("too many redirects");
  error.code = "OFF_ALLOWLIST";
  throw error;
}

function blankTransfer(input = {}) {
  return {
    id: String(input.id || ""),
    modelId: String(input.modelId || ""),
    sourceUrl: input.sourceUrl ? String(input.sourceUrl) : "",
    dest: input.dest ? String(input.dest) : "",
    status: "queued",
    bytes: Number(input.bytes) || 0,
    done: 0,
    error: "",
    sha256: input.sha256 ? String(input.sha256) : "",
  };
}

const NEXT = {
  "not-installed": ["queued"],
  queued: ["downloading", "failed"],
  downloading: ["paused", "verifying", "failed", "not-installed"],
  paused: ["downloading", "not-installed", "failed"],
  verifying: ["installing", "failed"],
  installing: ["installed", "failed"],
  installed: ["active", "update-available", "not-installed"],
  active: ["installed"],
  failed: ["queued", "not-installed"],
  "update-available": ["queued", "installed"],
};

function transition(job, event) {
  const current = job && TRANSFER_STATUSES.includes(job.status) ? job.status : "not-installed";
  const to = String(event || "");
  if (!TRANSFER_STATUSES.includes(to) || !(NEXT[current] || []).includes(to)) {
    const error = new Error(`cannot move ${current} to ${to || "empty"}`);
    error.code = "BAD_STATUS";
    throw error;
  }
  return { ...job, status: to };
}

function loadTransfers(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    return jobs
      .filter((job) => job && typeof job === "object")
      .map((job) => {
        const row = blankTransfer(job);
        if (TRANSFER_STATUSES.includes(job.status)) row.status = job.status;
        row.done = Number(job.done) || 0;
        row.error = String(job.error || "").slice(0, 240);
        return row;
      });
  } catch {
    return [];
  }
}

function saveTransfers(file, jobs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safe = (jobs || []).map((job) => {
    const copy = blankTransfer(job);
    copy.status = TRANSFER_STATUSES.includes(job.status) ? job.status : "queued";
    copy.done = Number(job.done) || 0;
    copy.error = String(job.error || "").slice(0, 240);
    return copy;
  });
  fs.writeFileSync(file, JSON.stringify({ jobs: safe }, null, 2));
  return safe;
}

function recoverTransfers(file) {
  const jobs = loadTransfers(file);
  let changed = false;
  const next = jobs.map((job) => {
    if (job.status !== "downloading") return job;
    changed = true;
    return { ...job, status: "paused", error: job.error || "stopped before it finished" };
  });
  if (changed) saveTransfers(file, next);
  return next;
}

function cleanupPart(file) {
  if (!file) return false;
  const part = String(file).endsWith(".part") ? String(file) : `${file}.part`;
  if (!fs.existsSync(part)) return false;
  fs.rmSync(part, { force: true });
  return true;
}

function admitJobs(jobs, concurrency = 1) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const active = (jobs || []).filter((job) => job.status === "downloading");
  const room = Math.max(0, limit - active.length);
  const next = (jobs || []).filter((job) => job.status === "queued").slice(0, room);
  return { running: active.length, starting: next.map((job) => job.id) };
}

module.exports = {
  HOSTS,
  TRANSFER_STATUSES,
  assertAllowedUrl,
  fetchAllowlisted,
  blankTransfer,
  transition,
  loadTransfers,
  saveTransfers,
  recoverTransfers,
  cleanupPart,
  admitJobs,
};
