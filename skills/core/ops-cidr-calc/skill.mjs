// FRIDAY · skill: ops-cidr-calc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// IPv4 subnet maths: network, broadcast, mask, usable range, host count, and whether an address is inside.

function toInt(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

const RANGES = [
  ["10.0.0.0", 8, "private (RFC 1918)"],
  ["172.16.0.0", 12, "private (RFC 1918)"],
  ["192.168.0.0", 16, "private (RFC 1918)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local (no DHCP answer)"],
  ["100.64.0.0", 10, "carrier-grade NAT (RFC 6598)"],
  ["224.0.0.0", 4, "multicast"],
];

function kind(ip) {
  for (const [base, bits, label] of RANGES) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ip & mask) >>> 0 === (toInt(base) & mask) >>> 0) return label;
  }
  return "public";
}

export async function run(input = {}) {
  const text = String(input?.cidr ?? input?.prompt ?? input?.text ?? "");
  const m =
    text.match(/(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})/) ??
    text.match(/(\d{1,3}(?:\.\d{1,3}){3})\s+(?:mask\s+)?(255(?:\.\d{1,3}){3})/i);
  if (!m)
    return {
      ok: false,
      error: "Give a network such as 192.168.1.0/24 (and optionally an address to test).",
    };
  let bits;
  if (m[2].includes(".")) {
    const mm = toInt(m[2]);
    const bin = mm === null ? "" : mm.toString(2).padStart(32, "0");
    if (!/^1*0*$/.test(bin)) return { ok: false, error: "That subnet mask is not contiguous." };
    bits = bin.indexOf("0") === -1 ? 32 : bin.indexOf("0");
  } else bits = Number(m[2]);
  const ip = toInt(m[1]);
  if (ip === null || bits < 0 || bits > 32)
    return { ok: false, error: "Not a valid IPv4 address and prefix (0 to 32)." };
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = 2 ** (32 - bits);
  const usable = bits >= 31 ? total : total - 2;
  const out = {
    ok: true,
    cidr: `${toIp(network)}/${bits}`,
    address: toIp(ip),
    mask: toIp(mask),
    wildcard: toIp(~mask >>> 0),
    network: toIp(network),
    broadcast: bits >= 31 ? null : toIp(broadcast),
    firstHost: bits >= 31 ? toIp(network) : toIp(network + 1),
    lastHost: bits >= 31 ? toIp(broadcast) : toIp(broadcast - 1),
    totalAddresses: total,
    usableHosts: usable,
    type: kind(network),
    note:
      bits === 31
        ? "A /31 is a point-to-point link: both addresses are usable."
        : bits === 32
          ? "A /32 is a single host."
          : undefined,
  };
  const tests = [...text.replace(m[0], " ").matchAll(/\d{1,3}(?:\.\d{1,3}){3}/g)].map((x) => x[0]);
  if (input?.contains) tests.push(String(input.contains));
  if (tests.length) {
    out.contains = tests.map((t) => {
      const n = toInt(t);
      return { address: t, inside: n !== null && (n & mask) >>> 0 === network };
    });
  }
  out.answer = `${out.cidr}: mask ${out.mask}, ${out.firstHost} to ${out.lastHost}${out.broadcast ? `, broadcast ${out.broadcast}` : ""}, ${usable} usable host(s), ${out.type}.${out.contains ? ` ${out.contains.map((c) => `${c.address} is ${c.inside ? "inside" : "outside"}`).join("; ")}.` : ""}`;
  return out;
}

export default run;
