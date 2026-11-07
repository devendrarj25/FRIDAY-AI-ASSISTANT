// FRIDAY · skill: ops-size-convert
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Convert data sizes between bytes, KB/MB/GB/TB (1000s) and KiB/MiB/GiB/TiB (1024s), and explain what Windows shows.

const U = {
  b: 1,
  byte: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};
const norm = (u) => {
  const k = u.toLowerCase().replace(/s$/, "");
  return k === "bytes" ? "b" : k;
};
const fmt = (n) => Number(n.toPrecision(7));
const label = (k) =>
  k.endsWith("ib") ? k[0].toUpperCase() + "iB" : k === "b" ? "bytes" : k.toUpperCase();
const SHOW = ["kb", "mb", "gb", "tb", "kib", "mib", "gib", "tib"];

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? "")
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1");
  const m = /(\d+(?:\.\d+)?)\s*(bytes?|b|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib)\b/.exec(text);
  const value = input.value != null ? Number(input.value) : m ? Number(m[1]) : NaN;
  const unit = norm(String(input.unit ?? (m ? m[2] : "")));
  if (!Number.isFinite(value) || !(unit in U)) {
    return { ok: false, error: "Give a size such as 1.5 GB, 2048 KiB or 700 MB." };
  }
  const bytes = value * U[unit];
  const table = Object.fromEntries(
    SHOW.map((k) => [k.toUpperCase().replace("IB", "iB"), fmt(bytes / U[k])]),
  );
  const to = /(?:to|in|into)\s+(bytes?|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib)\b/.exec(text);
  const target = to ? norm(to[1]) : null;
  const windows = unit === "gb" || unit === "gib" || unit === "tb" || unit === "mb";
  const note =
    "Drive makers sell in 1000s (GB); Windows File Explorer divides by 1024 and still writes GB, so a 500 GB drive shows about 465 GB.";
  return {
    ok: true,
    bytes: fmt(bytes),
    table,
    answer: target
      ? `${value} ${label(unit)} = ${fmt(bytes / U[target])} ${label(target)}.${windows ? ` ${note}` : ""}`
      : `${value} ${label(unit)} = ${fmt(bytes)} bytes = ${table.GB} GB = ${table.GiB} GiB.${windows ? ` ${note}` : ""}`,
  };
}

export default run;
