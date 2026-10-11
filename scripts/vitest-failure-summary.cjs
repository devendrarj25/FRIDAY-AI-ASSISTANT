/**
 * Turn a Vitest JSON report, and a pipeline report when one exists, into
 * one job summary. A missing runtime token skips the upload. A failed
 * upload does not change the test exit code. Tokens and signed URLs are
 * never printed.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /(CERTIFICATE_PASSWORD|CSC_KEY_PASSWORD|ACTIONS_RUNTIME_TOKEN|GITHUB_TOKEN|GH_TOKEN|ACTIONS_RESULTS_URL)\s*[:=]\s*\S+/gi,
  /sig=[A-Za-z0-9%._~-]{8,}/g,
];

function redact(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return text;
}

function firstAssertion(message) {
  const lines = String(message || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hit =
    lines.find((line) => /AssertionError|expected|Expected|Error:/.test(line)) || lines[0] || "";
  return redact(hit).slice(0, 400);
}

function quoteArg(value) {
  const text = String(value).replace(/"/g, '""');
  return `"${text}"`;
}

function summarizeVitest(report) {
  const failed = [];
  for (const file of report?.testResults || []) {
    for (const test of file.assertionResults || []) {
      if (test.status !== "failed") continue;
      const title = test.title || test.fullName || "failed test";
      const fileName = String(file.name || "").replace(/\\/g, "/");
      failed.push({
        file: fileName,
        title,
        fullName: test.fullName || title,
        line: firstAssertion((test.failureMessages || []).join("\n")),
        reproduce: `npx vitest run --testTimeout=60000 ${quoteArg(fileName)} -t ${quoteArg(title)}`,
      });
    }
  }
  return failed;
}

function summarizePipeline(report) {
  return (report?.phases || [])
    .filter((phase) => phase && phase.status === "failed")
    .map((phase) => ({
      name: String(phase.name || "phase"),
      detail: redact(phase.detail || "failed"),
      reproduce:
        "node scripts/build-pipeline.cjs --channel production --caller release --from stage-toolchain --report release/build-report.json",
    }));
}

function summaryText({ vitest, pipeline, notes }) {
  const lines = ["## FRIDAY check summary", ""];
  if (!vitest.length && !pipeline.length) {
    lines.push("No failed Vitest assertion or pipeline phase was in the reports.");
  }
  for (const test of vitest) {
    lines.push(`- \`${test.fullName}\``);
    if (test.line) lines.push(`  - ${test.line}`);
    lines.push(`  - Reproduce: \`${test.reproduce}\``);
  }
  for (const phase of pipeline) {
    lines.push(`- Pipeline \`${phase.name}\`: ${phase.detail}`);
    lines.push(`  - Reproduce: \`${phase.reproduce}\``);
  }
  for (const note of notes) lines.push(`- ${note}`);
  return lines.join("\n");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data));
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function backendIds(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const scope = String(payload.scp || "")
      .split(/\s+/)
      .find((item) => item.startsWith("Actions.Results:"));
    if (!scope) return null;
    const bits = scope.split(":");
    if (bits.length !== 3 || !bits[1] || !bits[2]) return null;
    return { workflowRunBackendId: bits[1], workflowJobRunBackendId: bits[2] };
  } catch {
    return null;
  }
}

async function uploadReports(files, env, fetchImpl) {
  const token = env.ACTIONS_RUNTIME_TOKEN || "";
  const base = env.ACTIONS_RESULTS_URL || "";
  if (!token || !base) return { uploaded: false, reason: "no runtime token" };
  const ids = backendIds(token);
  if (!ids) return { uploaded: false, reason: "runtime token has no artifact scope" };
  const name = "friday-test-report";
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return { uploaded: false, reason: "artifact service URL was refused" };
  }
  const endpoint = (method) =>
    new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, origin).href;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  try {
    const created = await fetchImpl(endpoint("CreateArtifact"), {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 4, name, ...ids }),
    });
    const createdBody = await created.json();
    const uploadUrl = createdBody.signedUploadUrl || createdBody.signed_upload_url;
    if (!created.ok || !uploadUrl)
      return { uploaded: false, reason: "artifact create was refused" };
    const zip = zipStored(files);
    const put = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(zip.length),
      },
      body: zip,
    });
    if (!put.ok) return { uploaded: false, reason: "artifact upload was refused" };
    const done = await fetchImpl(endpoint("FinalizeArtifact"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        name,
        size: zip.length,
        hash: crypto.createHash("sha256").update(zip).digest("hex"),
        ...ids,
      }),
    });
    if (!done.ok) return { uploaded: false, reason: "artifact finalize was refused" };
    return { uploaded: true, reason: "uploaded friday-test-report" };
  } catch {
    return { uploaded: false, reason: "artifact upload failed" };
  }
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const vitest = [];
  const pipeline = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pipeline") {
      pipeline.push(argv[i + 1] || "");
      i += 1;
    } else if (arg) vitest.push(arg);
  }
  return { vitest, pipeline };
}

async function report(argv, env, fetchImpl, io = {}) {
  const args = parseArgs(argv);
  const notes = [];
  const vitest = [];
  for (const file of args.vitest) {
    if (!fs.existsSync(file)) {
      notes.push(`Vitest report not written: ${file}`);
      continue;
    }
    vitest.push(...summarizeVitest(readJson(file)));
  }
  const pipeline = [];
  for (const file of args.pipeline) {
    if (!file || !fs.existsSync(file)) {
      notes.push(`Pipeline report not written: ${file || "release/build-report.json"}`);
      continue;
    }
    pipeline.push(...summarizePipeline(readJson(file)));
  }
  const text = redact(summaryText({ vitest, pipeline, notes }));
  const log = io.log || console.log;
  log(text);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  const error = io.error || ((line) => console.log(line));
  for (const test of vitest) {
    error(`::error file=${test.file}::${redact(test.fullName)} — ${test.line}`);
  }
  for (const phase of pipeline) {
    error(`::error::pipeline ${phase.name} — ${phase.detail}`);
  }
  const uploads = [];
  for (const file of [...args.vitest, ...args.pipeline]) {
    if (file && fs.existsSync(file)) {
      uploads.push({ name: path.basename(file), data: fs.readFileSync(file) });
    }
  }
  const upload = uploads.length
    ? await uploadReports(uploads, env, fetchImpl || globalThis.fetch)
    : { uploaded: false, reason: "no report file" };
  log(upload.reason);
  return { text, vitest, pipeline, upload };
}

async function main() {
  await report(process.argv.slice(2), process.env);
}

module.exports = {
  redact,
  summarizeVitest,
  summarizePipeline,
  summaryText,
  zipStored,
  backendIds,
  uploadReports,
  report,
};

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
