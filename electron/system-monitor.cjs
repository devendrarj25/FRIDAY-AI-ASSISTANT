/**
 * FRIDAY · live system monitor (one canonical sampler).
 *
 * Everything reported here is measured on this machine right now:
 *   - CPU load from /proc-equivalent os.cpus() tick deltas between samples
 *   - RAM from os.totalmem()/os.freemem()
 *   - GPU load / VRAM / temperature from nvidia-smi (throttled, cached)
 *   - Disk usage from the OS, refreshed slowly because it barely moves
 *
 * A reading that cannot be taken on this machine is reported as `null` with a
 * reason — never as a decorative number. There is exactly one interval for the
 * whole app: renderers subscribe, the monitor samples once and broadcasts.
 */
const os = require("node:os");
const path = require("node:path");
const { runProbe, runPowerShell, nvidiaSmiPath } = require(path.join(__dirname, "probe-exec.cjs"));

const SAMPLE_MS = 2000;
let sampleMs = SAMPLE_MS;
const GPU_MS = 5000;
const DISK_MS = 60000;
const NET_MS = 4000;
// Windows PowerShell 5.1 has to cold-start and auto-load the NetAdapter /
// CIM modules on first use. On an AV-scanned machine that regularly exceeds
// six seconds, which is why the old budget timed out on every single sample.
const PS_TIMEOUT_MS = 15000;

/** Backwards-compatible thin wrapper: returns stdout or null. */
const run = (cmd, args, timeout = 4000) =>
  runProbe(cmd, args, timeout).then((r) => (r.ok ? r.stdout : null));

const round = (n, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const GB = 1024 * 1024 * 1024;

// ------------------------------------------------------------------- CPU ---
let lastTicks = null;

function cpuTicks() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const key of Object.keys(cpu.times)) total += cpu.times[key];
    idle += cpu.times.idle;
  }
  return { idle, total, cores: cpus.length, model: cpus[0]?.model?.trim() || "unknown" };
}

/** Load between this call and the previous one. First call has no delta yet. */
function cpuLoad() {
  const now = cpuTicks();
  const previous = lastTicks;
  lastTicks = now;
  if (!previous || now.total <= previous.total) {
    return { percent: null, cores: now.cores, model: now.model };
  }
  const idleDelta = now.idle - previous.idle;
  const totalDelta = now.total - previous.total;
  const percent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  return { percent, cores: now.cores, model: now.model };
}

// ------------------------------------------------------------------- GPU ---
// `nvidia-smi` is resolved by absolute path: on many machines it is NOT on the
// PATH a packaged, elevated process inherits, which used to look identical to
// "no NVIDIA GPU". A failure now carries the real reason.
let gpuCache = { at: 0, value: null, reason: null };
let gpuInFlight = null;

async function readGpu() {
  const exe = nvidiaSmiPath();
  if (!exe) {
    return {
      value: null,
      reason:
        "nvidia-smi not found on this machine (checked PATH, System32 and the NVIDIA Corporation\\NVSMI install folder)",
    };
  }
  const result = await runProbe(
    exe,
    [
      "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
    ],
    8000,
  );
  const line = result.stdout ? result.stdout.split(/\r?\n/)[0] : null;
  if (!result.ok || !line) {
    return {
      value: null,
      reason: `GPU query failed: ${result.error ?? "nvidia-smi returned nothing"}`,
    };
  }
  const [name, util, used, total, temp] = line.split(",").map((s) => s.trim());
  const usedMb = Number(used);
  const totalMb = Number(total);
  return {
    value: {
      name: name || "GPU",
      percent: Number.isFinite(Number(util)) ? Number(util) : null,
      vramUsedMb: Number.isFinite(usedMb) ? usedMb : null,
      vramTotalMb: Number.isFinite(totalMb) ? totalMb : null,
      vramPercent:
        Number.isFinite(usedMb) && totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : null,
      temperatureC: Number.isFinite(Number(temp)) ? Number(temp) : null,
    },
    reason: null,
  };
}

async function gpuSample() {
  const now = Date.now();
  if (gpuCache.at && now - gpuCache.at < GPU_MS) return gpuCache;
  if (!gpuInFlight) {
    gpuInFlight = readGpu()
      .then((next) => {
        gpuCache = { at: Date.now(), value: next.value, reason: next.reason };
        return gpuCache;
      })
      .finally(() => {
        gpuInFlight = null;
      });
  }
  // Cold start: wait for the very first reading so the UI is never blank on
  // open. Afterwards the cached value is served instantly and refreshed in the
  // background, so a slow probe can never stall a sample.
  if (!gpuCache.at) return gpuInFlight;
  return gpuCache;
}

// ------------------------------------------------------------------ disk ---
let diskCache = { at: 0, value: [] };
let diskInFlight = null;

async function diskSample() {
  const now = Date.now();
  if (now - diskCache.at < DISK_MS) return diskCache.value;
  if (diskInFlight) return diskCache.value;
  const job =
    process.platform === "win32"
      ? runPowerShell(
          "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress",
          PS_TIMEOUT_MS,
        ).then(({ ok, stdout }) => {
          const out = ok ? stdout : null;

          if (!out) return [];
          try {
            const parsed = JSON.parse(out);
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            return rows
              .filter((d) => Number(d.Size) > 0)
              .map((d) => ({
                id: String(d.DeviceID),
                totalGb: round(Number(d.Size) / GB),
                freeGb: round(Number(d.FreeSpace) / GB),
                percent: Math.round(
                  ((Number(d.Size) - Number(d.FreeSpace)) / Number(d.Size)) * 100,
                ),
              }));
          } catch {
            return [];
          }
        })
      : Promise.resolve([]);
  diskInFlight = job
    .then((value) => {
      diskCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      diskInFlight = null;
    });
  return diskCache.value;
}

// --------------------------------------------------------------- network ---
// Real interface byte counters. Windows exposes them through
// Get-NetAdapterStatistics; the delta between two reads is actual throughput.
// Cached on its own cadence so a slow PowerShell call never stalls a sample.
let netCache = { at: 0, value: null };
let netInFlight = null;
let netCounters = null; // { rx, tx, at }

/** IPv4 addresses a phone on the same LAN can actually reach. */
function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces() || {};
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal) continue;
      out.push({ name, address: entry.address, mac: entry.mac || null });
    }
  }
  return out;
}

async function readCounters() {
  if (process.platform !== "win32") {
    return { counters: null, reason: "interface counters are Windows-only" };
  }
  // `Import-Module NetAdapter` is explicit so the (slow) autoload happens
  // inside our budget, and a missing module reports itself instead of
  // returning an empty sum that would look like a real zero-byte reading.
  const { ok, stdout, error } = await runPowerShell(
    "$ErrorActionPreference='Stop'; " +
      'try { Import-Module NetAdapter -ErrorAction Stop } catch { Write-Error "NetAdapter module unavailable: $($_.Exception.Message)"; exit 1 }; ' +
      "$s = Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes,SentBytes -Sum; " +
      "if (-not $s) { Write-Error 'no network adapters reported statistics'; exit 1 }; " +
      "[pscustomobject]@{ rx = ($s | Where-Object Property -eq 'ReceivedBytes').Sum; tx = ($s | Where-Object Property -eq 'SentBytes').Sum } | ConvertTo-Json -Compress",
    PS_TIMEOUT_MS,
  );
  if (!ok || !stdout) {
    return { counters: null, reason: error || "Get-NetAdapterStatistics returned nothing" };
  }
  try {
    const parsed = JSON.parse(stdout);
    // A null sum is NOT zero traffic — it means the counters were not read.
    // Treating it as 0 is what made a broken probe look like an idle link.
    if (parsed.rx === null || parsed.tx === null || parsed.rx === undefined) {
      return { counters: null, reason: "adapter statistics returned no byte counters" };
    }
    const rx = Number(parsed.rx);
    const tx = Number(parsed.tx);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) {
      return { counters: null, reason: "adapter statistics were not numeric" };
    }
    return { counters: { rx, tx, at: Date.now() }, reason: null };
  } catch (err) {
    return {
      counters: null,
      reason: `could not parse adapter statistics: ${String(err.message || err)}`,
    };
  }
}

async function netSample() {
  const now = Date.now();
  if (netCache.at && now - netCache.at < NET_MS) return netCache.value;
  if (!netInFlight) {
    netInFlight = readCounters()
      .then(({ counters, reason }) => {
        const addresses = lanAddresses();
        if (!counters) {
          netCache = {
            at: Date.now(),
            value: {
              available: false,
              downMbps: null,
              upMbps: null,
              addresses,
              reason: reason || "network adapter statistics unavailable",
            },
          };
          return netCache.value;
        }
        const previous = netCounters;
        netCounters = counters;
        if (!previous || counters.at <= previous.at) {
          netCache = {
            at: Date.now(),
            value: {
              available: true,
              downMbps: null,
              upMbps: null,
              addresses,
              reason: "measuring — needs a second counter read",
            },
          };
          return netCache.value;
        }
        const seconds = (counters.at - previous.at) / 1000;
        const toMbps = (bytes) => Math.max(0, round((bytes * 8) / seconds / 1_000_000, 2));
        netCache = {
          at: Date.now(),
          value: {
            available: true,
            downMbps: toMbps(counters.rx - previous.rx),
            upMbps: toMbps(counters.tx - previous.tx),
            addresses,
            reason: null,
          },
        };
        return netCache.value;
      })
      .finally(() => {
        netInFlight = null;
      });
  }
  // Cold start waits once so the very first sample carries either a real
  // reading or a real reason — never blank.
  if (!netCache.at) return netInFlight;
  return netCache.value;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

/** One measured snapshot. Never throws. */
async function sample() {
  const cpu = cpuLoad();
  const totalGb = round(os.totalmem() / GB);
  const freeGb = round(os.freemem() / GB);
  // GPU/disk resolve from their own cache so a slow probe can never stall a
  // sample; they simply report the last measured value until they refresh.
  const [gpuRead, disks, network] = await Promise.all([gpuSample(), diskSample(), netSample()]);
  const gpu = gpuRead?.value ?? null;
  return {
    at: Date.now(),
    live: true,
    cpu: {
      percent: cpu.percent,
      cores: cpu.cores,
      model: cpu.model,
      loadAvg: process.platform === "win32" ? null : round(os.loadavg()[0] ?? 0, 2),
    },
    ram: {
      percent: totalGb > 0 ? Math.round(((totalGb - freeGb) / totalGb) * 100) : null,
      usedGb: round(totalGb - freeGb),
      freeGb,
      totalGb,
    },
    gpu: gpu
      ? { available: true, ...gpu, reason: null }
      : {
          available: false,
          name: null,
          percent: null,
          vramUsedMb: null,
          vramTotalMb: null,
          vramPercent: null,
          temperatureC: null,
          // The real probe failure, so the owner sees WHY — a missing
          // nvidia-smi, a blocked spawn, or genuinely no NVIDIA GPU.
          reason:
            gpuRead?.reason ??
            "live utilization requires an NVIDIA GPU with nvidia-smi; other GPUs remain listed in hardware detection",
        },

    disks,
    network: network ?? {
      available: false,
      downMbps: null,
      upMbps: null,
      addresses: lanAddresses(),
      reason: "not measured yet",
    },
    uptime: formatUptime(os.uptime()),
    uptimeSeconds: Math.round(os.uptime()),
    process: {
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
}

// -------------------------------------------------------------- broadcast ---
let timer = null;
let subscribers = 0;
let latest = null;
let publish = null;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    latest = await sample();
    publish?.(latest);
  } catch {
    /* a failed sample keeps the previous one — never crash the main process */
  } finally {
    ticking = false;
  }
}

/** Wire the broadcast channel once (main process owns `send`). */
function init(send) {
  publish = (value) => send("system:metrics", value);
}

/** A renderer wants live samples. Reference-counted: one interval, app-wide. */
function subscribe() {
  subscribers += 1;
  if (!timer) {
    void tick();
    timer = setInterval(() => void tick(), sampleMs);
    timer.unref?.();
  }
  return latest;
}

/** Settings → Performance sample interval. Clamped 1–30s. */
function setSampleMs(ms) {
  const next = Math.min(30_000, Math.max(1_000, Math.round(Number(ms) || SAMPLE_MS)));
  sampleMs = next;
  if (timer) {
    clearInterval(timer);
    timer = setInterval(() => void tick(), sampleMs);
    timer.unref?.();
  }
  return sampleMs;
}

function unsubscribe() {
  subscribers = Math.max(0, subscribers - 1);
  if (subscribers === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function stop() {
  subscribers = 0;
  if (timer) clearInterval(timer);
  timer = null;
}

/** Last measured sample, or a fresh one when nothing is subscribed yet. */
async function snapshot() {
  if (latest && Date.now() - latest.at < sampleMs) return latest;
  await tick();
  return latest;
}

module.exports = {
  sample,
  snapshot,
  subscribe,
  unsubscribe,
  init,
  stop,
  lanAddresses,
  SAMPLE_MS,
  setSampleMs,
};
