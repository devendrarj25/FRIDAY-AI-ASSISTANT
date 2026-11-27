/**
 * The offline Python wheelhouse the Setup EXE carries.
 *
 * config/wheelhouse.lock.json pins the Windows x64 wheels of the kernel and voice packages
 * (kernel/requirements.txt and their dependencies; the optional capabilities file stays online), one set per Python
 * series the runtime repair can meet. At build, scripts/stage-toolchain.cjs calls stageWheelhouse(): every wheel is
 * fetched once into the cache, checked against its pinned SHA-256 and size, and packed with one exact-pin
 * constraints file and one hashed requirements file (name==version --hash=sha256:...) per series into a stored zip at
 * resources/toolchain/wheelhouse/pack.bin. The zip has no timestamps, so the same lock gives the same bytes on every
 * builder. installer/build/repair-runtime.ps1 unpacks it only when something must be installed and runs pip with
 * --no-index --require-hashes first, so only a wheel with a pinned hash can be installed.
 *
 *   node scripts/wheelhouse.cjs check   plan the committed lock against kernel/requirements.txt (no network)
 *   node scripts/wheelhouse.cjs lock    resolve the closure for each series on PyPI and rewrite the lock
 *                                       (needs Python with pip; FRIDAY_PYTHON picks the interpreter)
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const LOCK_FILE = path.join(ROOT, "config", "wheelhouse.lock.json");
const DEST = "toolchain/wheelhouse";
const WHEEL_HOST = "files.pythonhosted.org";
const INDEX_URL = "https://pypi.org/simple";
const DEFAULT_TAGS = ["cp312", "cp313", "cp314"];

/** PEP 503 name: lower case, runs of -_. become one dash. */
function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
}

/** name-version(-build)?-python-abi-platform.whl, a plain file name only. */
function parseWheelFilename(filename) {
  const text = String(filename || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+!-]*\.whl$/.test(text) || text.includes("..")) return null;
  const parts = text.slice(0, -4).split("-");
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [name, version] = parts;
  const [python, abi, platform] = parts.slice(-3);
  return { name: normalizeName(name), version, python, abi, platform };
}

/** True when the wheel installs on CPython <tag> (cp312) for Windows x64. */
function wheelFits(filename, tag) {
  const parsed = parseWheelFilename(filename);
  const want = /^cp(\d)(\d+)$/.exec(String(tag || ""));
  if (!parsed || !want) return false;
  const minor = Number(want[2]);
  const platforms = parsed.platform.split(".");
  if (!platforms.includes("win_amd64") && !platforms.includes("any")) return false;
  const abis = parsed.abi.split(".");
  return parsed.python.split(".").some((py) => {
    if (py === "py3" || py === `py${want[1]}${want[2]}`) return abis.includes("none");
    const cp = /^cp(\d)(\d+)$/.exec(py);
    if (!cp || cp[1] !== want[1]) return false;
    if (abis.includes("abi3")) return Number(cp[2]) <= minor;
    return Number(cp[2]) === minor && (abis.includes(tag) || abis.includes("none"));
  });
}

/** PEP 440 subset: numeric release, then dev < a < b < rc < final < post. */
function versionKey(version) {
  const match = /^(\d+(?:\.\d+)*)(?:[.-]?(dev|a|b|rc|c|post)[.-]?(\d*))?/i.exec(
    String(version || "").trim(),
  );
  if (!match) return { release: [0], rank: 3, n: 0 };
  const ranks = { dev: 0, a: 1, b: 2, rc: 2.5, c: 2.5, post: 4 };
  const label = (match[2] || "").toLowerCase();
  return {
    release: match[1].split(".").map(Number),
    rank: label ? ranks[label] : 3,
    n: Number(match[3] || 0),
  };
}

function compareVersions(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  const length = Math.max(left.release.length, right.release.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left.release[i] || 0) - (right.release[i] || 0);
    if (diff) return diff;
  }
  return left.rank - right.rank || left.n - right.n;
}

/** Plain requirement lines (name[extras]specs); comments, options and markers are skipped. */
function parseRequirements(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").split(";")[0].trim();
    if (!line || line.startsWith("-")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (!match) continue;
    const specs = match[3]
      .split(",")
      .map((part) => /^\s*(===|==|!=|~=|>=|<=|>|<)\s*([^\s]+)\s*$/.exec(part))
      .filter(Boolean)
      .map((m) => ({ op: m[1], version: m[2] }));
    out.push({ name: normalizeName(match[1]), specs, line });
  }
  return out;
}

function satisfies(version, specs) {
  return (specs || []).every(({ op, version: want }) => {
    const cmp = compareVersions(version, want);
    if (op === ">=") return cmp >= 0;
    if (op === ">") return cmp > 0;
    if (op === "<=") return cmp <= 0;
    if (op === "<") return cmp < 0;
    if (op === "!=") return cmp !== 0;
    if (op === "~=") {
      const head = want.split(".").slice(0, -1).join(".");
      return (
        cmp >= 0 &&
        compareVersions(version.split(".").slice(0, head.split(".").length).join("."), head) === 0
      );
    }
    return cmp === 0;
  });
}

/** Every rule the build and the tests apply to a lock. Returns the wheels, the tags, the byte sum and the errors. */
function planWheelhouse(lock, { budgetBytes = 0, requirementsText = null } = {}) {
  const errors = [];
  const wheels = Array.isArray(lock?.wheels) ? lock.wheels : [];
  const tags = Array.isArray(lock?.pythonTags) ? lock.pythonTags.map(String) : [];
  if (lock?.schema !== 1) errors.push("wheelhouse lock schema must be 1");
  if (!wheels.length) errors.push("wheelhouse lock has no wheels");
  if (wheels.length && !tags.length) errors.push("wheelhouse lock names no Python series");
  const seen = new Set();
  const perTag = new Map(tags.map((tag) => [tag, new Map()]));
  let sum = 0;
  for (const wheel of wheels) {
    const label = String(wheel?.filename || wheel?.name || "?");
    const parsed = parseWheelFilename(wheel?.filename);
    if (!parsed) {
      errors.push(`${label}: not a plain wheel file name`);
      continue;
    }
    if (seen.has(wheel.filename)) errors.push(`${label}: listed twice`);
    seen.add(wheel.filename);
    if (normalizeName(wheel.name) !== parsed.name || String(wheel.version) !== parsed.version) {
      errors.push(`${label}: name or version does not match the file name`);
    }
    let url = null;
    try {
      url = new URL(String(wheel.url || ""));
    } catch {
      url = null;
    }
    if (
      !url ||
      url.protocol !== "https:" ||
      url.hostname !== WHEEL_HOST ||
      url.username ||
      url.password ||
      !url.pathname.endsWith(`/${wheel.filename}`)
    ) {
      errors.push(`${label}: url must be https://${WHEEL_HOST}/.../${wheel.filename}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(wheel.sha256 || "")))
      errors.push(`${label}: no valid sha256`);
    const bytes = Number(wheel.bytes || 0);
    if (!Number.isInteger(bytes) || bytes <= 0) errors.push(`${label}: no size`);
    else sum += bytes;
    const wheelTags = Array.isArray(wheel.tags) ? wheel.tags.map(String) : [];
    if (!wheelTags.length) errors.push(`${label}: serves no Python series`);
    for (const tag of wheelTags) {
      if (!perTag.has(tag)) {
        errors.push(`${label}: ${tag} is not one of the lock's Python series`);
        continue;
      }
      if (!wheelFits(wheel.filename, tag))
        errors.push(`${label}: does not fit ${tag} on Windows x64`);
      const byName = perTag.get(tag);
      const before = byName.get(parsed.name);
      if (before && before.version !== parsed.version) {
        errors.push(
          `${parsed.name}: two versions for ${tag} (${before.version}, ${parsed.version})`,
        );
      }
      byName.set(parsed.name, { version: parsed.version, filename: wheel.filename });
    }
  }
  if (requirementsText != null) {
    for (const req of parseRequirements(requirementsText)) {
      for (const tag of tags) {
        const hit = perTag.get(tag).get(req.name);
        if (!hit) errors.push(`${req.line}: no wheel for ${tag}`);
        else if (!satisfies(hit.version, req.specs)) {
          errors.push(`${req.line}: the lock has ${hit.version} for ${tag}`);
        }
      }
    }
  }
  const budget = Number(budgetBytes || 0);
  if (budget && sum > budget) errors.push(`wheelhouse ${sum} bytes exceeds budget ${budget}`);
  return { wheels, tags, sum, budget, errors };
}

/** One exact pin per package for one Python series, sorted; empty when the lock does not carry that series. */
function constraintsFor(lock, tag) {
  const pins = new Map();
  for (const wheel of lock?.wheels || []) {
    if (!(wheel.tags || []).includes(tag)) continue;
    const parsed = parseWheelFilename(wheel.filename);
    if (parsed) pins.set(parsed.name, parsed.version);
  }
  return [...pins.keys()]
    .sort()
    .map((name) => `${name}==${pins.get(name)}\n`)
    .join("");
}

/**
 * One line per package for one Python series, sorted: name==version plus the SHA-256 of every wheel of that
 * version the lock lists for the series. pip --require-hashes installs from this file and from nothing else, so an
 * unpinned or swapped wheel cannot be installed. Empty when the lock does not carry that series.
 */
function requirementsFor(lock, tag) {
  const pins = new Map();
  for (const wheel of lock?.wheels || []) {
    if (!(wheel.tags || []).includes(tag)) continue;
    const parsed = parseWheelFilename(wheel.filename);
    if (!parsed) continue;
    const pin = pins.get(parsed.name) || { version: parsed.version, hashes: new Set() };
    pin.version = parsed.version;
    pin.hashes.add(String(wheel.sha256));
    pins.set(parsed.name, pin);
  }
  return [...pins.keys()]
    .sort()
    .map((name) => {
      const { version, hashes } = pins.get(name);
      return `${name}==${version}${[...hashes]
        .sort()
        .map((digest) => ` --hash=sha256:${digest}`)
        .join("")}\n`;
    })
    .join("");
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

/**
 * A stored (uncompressed) zip: wheels are compressed already. Fixed 1980-01-01 times and sorted entries make the
 * bytes depend on the content only. Writes to <file>.part and renames, so a failed build leaves no pack.
 */
function writeStoredZip(file, entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const part = `${file}.part`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(part, "w");
  const central = [];
  let offset = 0;
  const write = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  try {
    if (sorted.length > 0xfffe) throw new Error("too many entries for a zip without ZIP64");
    for (const entry of sorted) {
      const name = Buffer.from(entry.name, "ascii");
      const body = entry.body || fs.readFileSync(entry.file);
      const crc = zlib.crc32(body) >>> 0;
      if (offset + body.length + 30 + name.length > 0xfffffffe)
        throw new Error("wheelhouse zip above 4 GiB");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(10, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(body.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      central.push({ name, crc, size: body.length, offset });
      write(local);
      write(name);
      write(body);
    }
    const start = offset;
    for (const row of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(10, 6);
      head.writeUInt16LE(0, 8);
      head.writeUInt16LE(0, 10);
      head.writeUInt16LE(0, 12);
      head.writeUInt16LE(0x21, 14);
      head.writeUInt32LE(row.crc, 16);
      head.writeUInt32LE(row.size, 20);
      head.writeUInt32LE(row.size, 24);
      head.writeUInt16LE(row.name.length, 28);
      head.writeUInt32LE(row.offset, 42);
      write(head);
      write(row.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    write(end);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(part, file);
  return { entries: central.length, bytes: offset };
}

/** The central directory of a zip with no comment: name, size, CRC and local header offset of each entry. */
function readZipIndex(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const end = Buffer.alloc(22);
    fs.readSync(fd, end, 0, 22, size - 22);
    if (end.readUInt32LE(0) !== 0x06054b50) throw new Error(`${file} is not a zip FRIDAY wrote`);
    const count = end.readUInt16LE(10);
    const dir = Buffer.alloc(end.readUInt32LE(12));
    fs.readSync(fd, dir, 0, dir.length, end.readUInt32LE(16));
    const out = [];
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (dir.readUInt32LE(at) !== 0x02014b50)
        throw new Error(`${file} has a broken central directory`);
      const nameLength = dir.readUInt16LE(at + 28);
      const extra = dir.readUInt16LE(at + 30);
      const comment = dir.readUInt16LE(at + 32);
      out.push({
        name: dir.toString("ascii", at + 46, at + 46 + nameLength),
        crc: dir.readUInt32LE(at + 16),
        size: dir.readUInt32LE(at + 24),
        offset: dir.readUInt32LE(at + 42),
      });
      at += 46 + nameLength + extra + comment;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Re-reads every wheel stored in the zip and checks its size and SHA-256 against the lock. Returns the problems. */
function verifyWheelhouseZip(file, wheels) {
  const problems = [];
  let index;
  try {
    index = new Map(readZipIndex(file).map((row) => [row.name, row]));
  } catch (error) {
    return [String((error && error.message) || error)];
  }
  const fd = fs.openSync(file, "r");
  try {
    for (const wheel of wheels) {
      const row = index.get(wheel.filename);
      if (!row) {
        problems.push(`${wheel.filename}: missing from the wheelhouse`);
        continue;
      }
      const local = Buffer.alloc(30);
      fs.readSync(fd, local, 0, 30, row.offset);
      const dataAt = row.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const body = Buffer.alloc(row.size);
      fs.readSync(fd, body, 0, row.size, dataAt);
      if (row.size !== Number(wheel.bytes) || sha256(body) !== wheel.sha256) {
        problems.push(`${wheel.filename}: failed SHA-256 or size check inside the wheelhouse`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return problems;
}

function readLock(file = LOCK_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readRequirements(lock, root = ROOT) {
  return fs.readFileSync(path.join(root, lock?.requirements || "kernel/requirements.txt"), "utf8");
}

/**
 * Fetches (or takes from the cache) every wheel of the lock, checks size and SHA-256, and writes the stored zip
 * to <stageDir>/toolchain/wheelhouse/pack.bin. Any failed check throws before a pack is written.
 */
async function stageWheelhouse({
  lock,
  requirementsText = null,
  budgetBytes = 0,
  cacheDir,
  stageDir,
  fetchImpl,
  offline = false,
  log = () => {},
}) {
  const plan = planWheelhouse(lock, { budgetBytes, requirementsText });
  if (plan.errors.length) {
    const error = new Error(`wheelhouse lock: ${plan.errors.join("; ")}`);
    error.errors = plan.errors;
    throw error;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(stageDir, ...DEST.split("/"), "pack.bin");
  fs.rmSync(target, { force: true });
  const entries = [];
  for (const wheel of plan.wheels) {
    const cacheFile = path.join(cacheDir, `${wheel.sha256}.whl`);
    const good = (body) =>
      body && body.length === Number(wheel.bytes) && sha256(body) === wheel.sha256;
    let body = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile) : null;
    if (!good(body)) {
      if (offline) {
        const error = new Error(`offline build: ${wheel.filename} is not in the staging cache`);
        error.errors = ["offline"];
        throw error;
      }
      try {
        const res = await fetchImpl(wheel.url, {
          pack: { id: wheel.name, sha256: wheel.sha256, bytes: Number(wheel.bytes) },
          log,
        });
        body = Buffer.isBuffer(res) ? res : Buffer.from(res?.body || []);
      } catch (err) {
        const error = new Error(
          `${wheel.filename} could not be downloaded (${String((err && err.message) || err)})`,
        );
        error.errors = ["download"];
        throw error;
      }
      if (!good(body)) {
        const error = new Error(`${wheel.filename} failed SHA-256 or size check`);
        error.errors = ["sha256"];
        throw error;
      }
      fs.writeFileSync(cacheFile, body);
    }
    entries.push({ name: wheel.filename, file: cacheFile });
  }
  for (const tag of plan.tags) {
    entries.push({ name: `constraints-${tag}.txt`, body: Buffer.from(constraintsFor(lock, tag)) });
    entries.push({
      name: `requirements-${tag}.txt`,
      body: Buffer.from(requirementsFor(lock, tag)),
    });
  }
  const index = {
    schema: 1,
    platform: lock.platform,
    pythonTags: plan.tags,
    wheels: plan.wheels.map(({ name, version, filename, sha256: digest, bytes, tags }) => ({
      name,
      version,
      filename,
      sha256: digest,
      bytes,
      tags,
    })),
  };
  entries.push({
    name: "wheelhouse.json",
    body: Buffer.from(`${JSON.stringify(index, null, 2)}\n`),
  });
  writeStoredZip(target, entries);
  const problems = verifyWheelhouseZip(target, plan.wheels);
  if (problems.length) {
    fs.rmSync(target, { force: true });
    const error = new Error(problems.join("; "));
    error.errors = ["sha256"];
    throw error;
  }
  return { file: target, wheels: plan.wheels.length, bytes: plan.sum, tags: plan.tags };
}

/** Removes a wheelhouse an earlier build staged, so a build with the wheelhouse switched off never ships it. */
function removeStaged(stageDir) {
  fs.rmSync(path.join(stageDir, ...DEST.split("/")), { recursive: true, force: true });
}

/**
 * Turns one pip --report per Python series and the PyPI JSON of every release into the lock. The digest pip
 * resolved and the digest PyPI lists must agree; the size comes from PyPI.
 */
/** The lock as the repository's formatter writes it: two-space JSON with the short tag lists on one line. */
function formatLock(lock) {
  const text = JSON.stringify(lock, null, 2).replace(
    /\[\n\s+("cp\d+"(?:,\n\s+"cp\d+")*)\n\s+\]/g,
    (_, items) => `[${items.split(/,\n\s+/).join(", ")}]`,
  );
  return `${text}\n`;
}

function buildLock({ reports, pypi, checked, requirements = "kernel/requirements.txt" }) {
  const tags = Object.keys(reports).sort();
  const byFile = new Map();
  for (const tag of tags) {
    for (const item of reports[tag]?.install || []) {
      const url = String(item?.download_info?.url || "");
      const filename = decodeURIComponent(url.split("/").pop() || "");
      const digest = item?.download_info?.archive_info?.hashes?.sha256 || "";
      const name = normalizeName(item?.metadata?.name);
      const version = String(item?.metadata?.version || "");
      const release = pypi[`${name}==${version}`];
      const listed = (release?.urls || []).find((row) => row.filename === filename);
      if (!listed) throw new Error(`${name} ${version}: ${filename} is not listed on PyPI`);
      if (listed.digests?.sha256 !== digest) {
        throw new Error(
          `${name} ${version}: the digest pip resolved differs from PyPI's for ${filename}`,
        );
      }
      const row = byFile.get(filename) || {
        name,
        version,
        filename,
        url,
        sha256: digest,
        bytes: Number(listed.size),
        tags: [],
      };
      if (!row.tags.includes(tag)) row.tags.push(tag);
      byFile.set(filename, row);
    }
  }
  const wheels = [...byFile.values()].sort((a, b) =>
    a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0,
  );
  return {
    schema: 1,
    checked,
    platform: "win_amd64",
    index: INDEX_URL,
    requirements,
    pythonTags: tags,
    wheels,
  };
}

/**
 * pip evaluates environment markers for the machine it runs on even with --platform, so a Linux run would pull
 * uvloop and drop colorama. This shim gives pip Windows markers for the target series, then runs it.
 */
const RESOLVE_SHIM = [
  "import sys",
  "import pip._vendor.packaging.markers as markers",
  "PV = sys.argv[1]",
  "_base = markers.default_environment",
  "def _windows():",
  "    env = dict(_base())",
  "    env.update({'os_name': 'nt', 'sys_platform': 'win32', 'platform_system': 'Windows',",
  "                'platform_machine': 'AMD64', 'platform_release': '10', 'implementation_name': 'cpython',",
  "                'platform_python_implementation': 'CPython', 'python_version': PV,",
  "                'python_full_version': PV + '.0'})",
  "    return env",
  "markers.default_environment = _windows",
  "from pip._internal.cli.main import main",
  "sys.exit(main(sys.argv[2:]))",
  "",
].join("\n");

function resolveReport({
  python,
  tag,
  requirementsFile,
  spawn = require("child_process").spawnSync,
}) {
  const version = `${tag.slice(2, 3)}.${tag.slice(3)}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "friday-wheel-lock-"));
  try {
    const shim = path.join(work, "resolve.py");
    const report = path.join(work, "report.json");
    fs.writeFileSync(shim, RESOLVE_SHIM);
    const args = [
      "-I",
      shim,
      version,
      "install",
      "--isolated",
      "--disable-pip-version-check",
      "--dry-run",
      "--ignore-installed",
      "--quiet",
      "--report",
      report,
      "--only-binary=:all:",
      "--platform",
      "win_amd64",
      "--python-version",
      version,
      "--implementation",
      "cp",
      "--abi",
      tag,
      "--index-url",
      INDEX_URL,
      "-r",
      requirementsFile,
    ];
    const run = spawn(python, args, { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] });
    if (run.error || run.status !== 0) {
      throw new Error(
        `pip could not resolve the ${tag} wheels (${run.error?.message || `exit ${run.status}`})`,
      );
    }
    return JSON.parse(fs.readFileSync(report, "utf8"));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function writeLockFromPypi({
  python = process.env.FRIDAY_PYTHON || (process.platform === "win32" ? "python" : "python3"),
  tags = DEFAULT_TAGS,
  requirements = "kernel/requirements.txt",
  file = LOCK_FILE,
  fetchJson = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  },
} = {}) {
  const reports = {};
  for (const tag of tags) {
    reports[tag] = resolveReport({ python, tag, requirementsFile: path.join(ROOT, requirements) });
  }
  const pypi = {};
  for (const report of Object.values(reports)) {
    for (const item of report.install || []) {
      const key = `${normalizeName(item.metadata.name)}==${item.metadata.version}`;
      if (!pypi[key]) {
        pypi[key] = await fetchJson(
          `https://pypi.org/pypi/${encodeURIComponent(item.metadata.name)}/${encodeURIComponent(item.metadata.version)}/json`,
        );
      }
    }
  }
  const lock = buildLock({
    reports,
    pypi,
    checked: new Date().toISOString().slice(0, 10),
    requirements,
  });
  fs.writeFileSync(file, formatLock(lock));
  return lock;
}

module.exports = {
  LOCK_FILE,
  DEST,
  WHEEL_HOST,
  normalizeName,
  parseWheelFilename,
  wheelFits,
  compareVersions,
  parseRequirements,
  satisfies,
  planWheelhouse,
  constraintsFor,
  requirementsFor,
  writeStoredZip,
  readZipIndex,
  verifyWheelhouseZip,
  readLock,
  readRequirements,
  stageWheelhouse,
  removeStaged,
  buildLock,
  formatLock,
  resolveReport,
  writeLockFromPypi,
};

if (require.main === module) {
  const command = process.argv[2] || "check";
  if (command === "lock") {
    writeLockFromPypi().then(
      (lock) => {
        const mib = Math.round(lock.wheels.reduce((sum, w) => sum + w.bytes, 0) / 1024 ** 2);
        console.log(
          `[friday] ok       wheelhouse lock: ${lock.wheels.length} wheels for ${lock.pythonTags.join(", ")} (${mib} MB)`,
        );
      },
      (err) => {
        console.error(`[friday] FAIL     wheelhouse lock: ${String((err && err.message) || err)}`);
        process.exitCode = 1;
      },
    );
  } else {
    const lock = readLock();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, "config", "toolchain-manifest.json"), "utf8"),
    );
    const plan = planWheelhouse(lock, {
      budgetBytes: manifest?.wheelhouse?.budgetBytes,
      requirementsText: readRequirements(lock),
    });
    if (plan.errors.length) {
      for (const line of plan.errors) console.error(`[friday] FAIL     wheelhouse: ${line}`);
      process.exitCode = 1;
    } else {
      console.log(
        `[friday] ok       wheelhouse: ${plan.wheels.length} wheels for ${plan.tags.join(", ")} (${Math.round(plan.sum / 1024 ** 2)} MB)`,
      );
    }
  }
}
