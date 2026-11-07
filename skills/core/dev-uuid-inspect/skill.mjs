// FRIDAY · skill: dev-uuid-inspect
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Read a UUID: version, variant and, for time-based versions (1, 6, 7), the moment it was made.

const RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const GREGORIAN_TO_UNIX_100NS = 122192928000000000n;

function stamp(version, h) {
  const hex = h.replace(/-/g, "");
  let ms = null;
  if (version === 7) ms = Number.parseInt(hex.slice(0, 12), 16);
  else if (version === 1) {
    const t = BigInt("0x" + hex.slice(13, 16) + hex.slice(8, 12) + hex.slice(0, 8));
    ms = Number((t - GREGORIAN_TO_UNIX_100NS) / 10000n);
  } else if (version === 6) {
    const t =
      (BigInt("0x" + hex.slice(0, 8)) << 28n) |
      (BigInt("0x" + hex.slice(8, 12)) << 12n) |
      BigInt("0x" + hex.slice(13, 16));
    ms = Number((t - GREGORIAN_TO_UNIX_100NS) / 10000n);
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const KIND = {
  1: "time-based (MAC and clock)",
  2: "DCE security",
  3: "name-based (MD5)",
  4: "random",
  5: "name-based (SHA-1)",
  6: "reordered time-based",
  7: "Unix-time ordered (sortable)",
  8: "custom",
};

export async function run(input = {}) {
  const text = String(input?.uuid ?? input?.prompt ?? input?.text ?? "");
  const found = [...new Set(text.match(RE) ?? [])].slice(0, 20);
  if (!found.length) return { ok: false, error: "No UUID found in the text." };
  const items = found.map((raw) => {
    const h = raw.toLowerCase();
    if (h === "00000000-0000-0000-0000-000000000000")
      return { uuid: h, kind: "nil UUID", version: 0 };
    if (h === "ffffffff-ffff-ffff-ffff-ffffffffffff")
      return { uuid: h, kind: "max UUID", version: 15 };
    const version = Number.parseInt(h[14], 16);
    const v = Number.parseInt(h[19], 16);
    const variant =
      v >= 8 && v <= 11
        ? "RFC 4122 / 9562"
        : v >= 12 && v <= 13
          ? "Microsoft legacy"
          : v >= 14
            ? "reserved"
            : "NCS legacy";
    const createdAt = stamp(version, h);
    return {
      uuid: h,
      version,
      kind: KIND[version] ?? "unknown version",
      variant,
      createdAt,
    };
  });
  return {
    ok: true,
    count: items.length,
    items,
    answer: items
      .map(
        (i) =>
          `${i.uuid}: ${i.kind}${i.version ? ` (v${i.version})` : ""}${i.createdAt ? `, made ${i.createdAt}` : ""}`,
      )
      .join("\n"),
  };
}

export default run;
