// FRIDAY · skill: ops-download-time
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// How long a download takes for a size and a line speed, or the speed needed to finish in a given time.

const SIZE = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};
// Speeds in bits per second (network "Mbps") or bytes per second ("MB/s").
const BITS = { bps: 1, kbps: 1e3, mbps: 1e6, gbps: 1e9 };
const BYTES = { "kb/s": 1e3, "mb/s": 1e6, "gb/s": 1e9, kbps_bytes: 1e3 };

const bytesFromText = (text) => {
  const m = text
    .toLowerCase()
    .match(/(\d+(?:[.,]\d+)?)\s*(kib|mib|gib|tib|kb|mb|gb|tb|b)\b(?!\s*\/s|ps)/);
  return m ? Number(m[1].replace(",", ".")) * SIZE[m[2]] : NaN;
};
const bytesPerSecondFromText = (text) => {
  const t = text.toLowerCase();
  const bits = t.match(/(\d+(?:[.,]\d+)?)\s*(gbps|mbps|kbps|bps)\b/);
  if (bits) return (Number(bits[1].replace(",", ".")) * BITS[bits[2]]) / 8;
  const bytes = t.match(/(\d+(?:[.,]\d+)?)\s*(gb\/s|mb\/s|kb\/s)/);
  if (bytes) return Number(bytes[1].replace(",", ".")) * BYTES[bytes[2]];
  return NaN;
};
const secondsFromText = (text) => {
  let total = 0;
  let any = false;
  for (const m of text
    .toLowerCase()
    .matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g)) {
    const unit = m[2][0];
    total += Number(m[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
    any = true;
  }
  return any ? total : NaN;
};

function human(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : "", !h && r ? `${r} s` : ""]
    .filter(Boolean)
    .join(" ");
}
const size = (bytes) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : bytes >= 1e6
      ? `${(bytes / 1e6).toFixed(1)} MB`
      : `${Math.round(bytes / 1e3)} KB`;

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? "");
  const bytes = Number.isFinite(Number(input?.bytes))
    ? Number(input.bytes)
    : bytesFromText(String(input?.size ?? text));
  const speed = bytesPerSecondFromText(String(input?.speed ?? text));
  const secondsGiven = Number.isFinite(Number(input?.seconds))
    ? Number(input.seconds)
    : secondsFromText(
        String(
          input?.time ??
            text.replace(
              /\d+(?:[.,]\d+)?\s*(?:kib|mib|gib|tib|kb|mb|gb|tb|gbps|mbps|kbps|bps)\b(?:\/s)?/gi,
              " ",
            ),
        ),
      );
  const efficiency = Math.min(1, Math.max(0.1, Number(input?.efficiency ?? 0.85)));
  if (Number.isFinite(bytes) && Number.isFinite(speed)) {
    const ideal = bytes / speed;
    const real = ideal / efficiency;
    return {
      ok: true,
      answer: `${size(bytes)} at ${((speed * 8) / 1e6).toFixed(1)} Mbps takes about ${human(real)} in practice (${human(ideal)} at full line speed).`,
      sizeBytes: bytes,
      lineSpeedMbps: Number(((speed * 8) / 1e6).toFixed(3)),
      fullSpeedSeconds: Math.round(ideal),
      realisticSeconds: Math.round(real),
      assumption: `Realistic time assumes ${Math.round(efficiency * 100)}% of the line speed (protocol overhead, server speed, Wi-Fi). Mbps is megabits: divide by 8 for megabytes per second.`,
    };
  }
  if (Number.isFinite(bytes) && Number.isFinite(secondsGiven)) {
    const needed = (bytes / secondsGiven) * 8;
    const withOverhead = needed / efficiency;
    return {
      ok: true,
      answer: `To get ${size(bytes)} in ${human(secondsGiven)} you need about ${(withOverhead / 1e6).toFixed(1)} Mbps of real line speed (${(needed / 1e6).toFixed(1)} Mbps at 100% efficiency).`,
      requiredMbps: Number((withOverhead / 1e6).toFixed(2)),
      requiredMbpsAtFullEfficiency: Number((needed / 1e6).toFixed(2)),
    };
  }
  if (Number.isFinite(speed) && Number.isFinite(secondsGiven)) {
    const got = speed * secondsGiven * efficiency;
    return {
      ok: true,
      answer: `In ${human(secondsGiven)} at ${((speed * 8) / 1e6).toFixed(1)} Mbps you download about ${size(got)}.`,
      downloadedBytes: Math.round(got),
    };
  }
  return {
    ok: false,
    error:
      "Give two of: a size (4.2 GB), a speed (20 Mbps or 5 MB/s) and a time (30 minutes). For example: how long does 4.2 GB take at 20 Mbps.",
  };
}

export default run;
