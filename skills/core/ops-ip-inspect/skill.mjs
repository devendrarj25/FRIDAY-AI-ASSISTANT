// FRIDAY · skill: ops-ip-inspect
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Tell what an IPv4 or IPv6 address is: private, loopback, link-local, shared, documentation or public.

function v4(s) {
  const p = s.split(".");
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.map(Number);
}

function classify4(a) {
  const [x, y, z] = a;
  if (x === 0) return ["this-network", "0.0.0.0/8, not a real host address"];
  if (x === 10) return ["private", "10.0.0.0/8: home or office LAN"];
  if (x === 100 && y >= 64 && y <= 127)
    return ["shared", "100.64.0.0/10: carrier-grade NAT or Tailscale"];
  if (x === 127) return ["loopback", "127.0.0.0/8: this computer only"];
  if (x === 169 && y === 254)
    return ["link-local", "169.254.0.0/16: self-assigned, usually means DHCP failed"];
  if (x === 172 && y >= 16 && y <= 31)
    return ["private", "172.16.0.0/12: LAN, often Docker or WSL"];
  if (x === 192 && y === 0 && z === 2) return ["documentation", "192.0.2.0/24: examples only"];
  if (x === 192 && y === 168) return ["private", "192.168.0.0/16: home router LAN"];
  if (x === 198 && (y === 18 || y === 19)) return ["benchmark", "198.18.0.0/15: network testing"];
  if (x === 198 && y === 51 && z === 100)
    return ["documentation", "198.51.100.0/24: examples only"];
  if (x === 203 && y === 0 && z === 113) return ["documentation", "203.0.113.0/24: examples only"];
  if (x >= 224 && x <= 239) return ["multicast", "224.0.0.0/4: group delivery"];
  if (x >= 240) return ["reserved", "240.0.0.0/4: reserved (255.255.255.255 is broadcast)"];
  return ["public", "Routable on the internet"];
}

function expand6(s) {
  const t = s.toLowerCase().split("%")[0];
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  let body = t;
  if (tail) {
    const q = v4(tail[2]);
    if (!q) return null;
    body = tail[1] + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - back.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...back];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function classify6(g) {
  if (g.every((x) => x === 0)) return ["unspecified", "::, no address"];
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)
    return ["loopback", "::1: this computer only"];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [
      "ipv4-mapped",
      `an IPv4 address (${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}) inside IPv6`,
    ];
  }
  if ((g[0] & 0xffc0) === 0xfe80) return ["link-local", "fe80::/10: this network segment only"];
  if ((g[0] & 0xfe00) === 0xfc00) return ["private", "fc00::/7: unique local address, a LAN"];
  if ((g[0] & 0xff00) === 0xff00) return ["multicast", "ff00::/8: group delivery"];
  if (g[0] === 0x2001 && g[1] === 0x0db8) return ["documentation", "2001:db8::/32: examples only"];
  if ((g[0] & 0xe000) === 0x2000) return ["public", "Global unicast: routable on the internet"];
  return ["reserved", "Not in a normally used range"];
}

export async function run(input = {}) {
  const text = String(input?.ip ?? input?.prompt ?? input?.text ?? "");
  const items = [];
  const seen = new Set();
  for (const token of text.match(/[0-9a-fA-F:.%]{3,}/g) ?? []) {
    const clean = token
      .replace(/^\.+|\.+$/g, "")
      .replace(/(?<!:):$/, "")
      .replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/, "$1");
    if (seen.has(clean)) continue;
    const a = v4(clean);
    if (a) {
      seen.add(clean);
      const [kind, note] = classify4(a);
      const n = ((a[0] << 24) >>> 0) + (a[1] << 16) + (a[2] << 8) + a[3];
      items.push({
        ip: clean,
        version: 4,
        kind,
        note,
        integer: n,
        hex: "0x" + n.toString(16).padStart(8, "0"),
      });
      continue;
    }
    if ((clean.match(/:/g) ?? []).length >= 2) {
      const g = expand6(clean);
      if (g) {
        seen.add(clean);
        const [kind, note] = classify6(g);
        items.push({
          ip: clean,
          version: 6,
          kind,
          note,
          full: g.map((x) => x.toString(16).padStart(4, "0")).join(":"),
        });
      }
    }
  }
  if (!items.length) return { ok: false, error: "No IP address found in the text." };
  return { ok: true, items, answer: items.map((i) => `${i.ip}: ${i.kind} (${i.note})`).join("\n") };
}

export default run;
