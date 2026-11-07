// FRIDAY · skill: ops-network-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Ports, IP addresses, subnets and HTTP status codes. Network facts without a network call.
// It holds 4 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "ops-port-lookup",
    gate: /\bports?\b|what runs on/,
    run: (() => {
      // FRIDAY · skill: ops-port-lookup
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // What runs on a TCP/UDP port, or which port a service uses; includes the ports FRIDAY and its tools use.

      const PORTS = {
        20: ["FTP data", "Plain text file transfer; use SFTP instead."],
        21: ["FTP", "Plain text file transfer; use SFTP instead."],
        22: ["SSH / SFTP", "Encrypted remote shell and file copy."],
        23: ["Telnet", "Unencrypted remote shell; turn it off."],
        25: ["SMTP", "Mail between servers; often blocked by home ISPs."],
        53: ["DNS", "Name lookups (UDP, and TCP for large answers)."],
        67: ["DHCP server", "Hands out IP addresses on a LAN."],
        68: ["DHCP client", "Receives an IP address on a LAN."],
        80: ["HTTP", "Web without encryption."],
        110: ["POP3", "Mail download without encryption."],
        123: ["NTP", "Clock sync (UDP)."],
        135: ["Windows RPC", "Windows services; never expose to the internet."],
        139: ["NetBIOS session", "Old Windows file sharing."],
        143: ["IMAP", "Mail access without encryption."],
        161: ["SNMP", "Network device monitoring (UDP)."],
        389: ["LDAP", "Directory lookups."],
        443: ["HTTPS", "Web with encryption."],
        445: ["SMB", "Windows file sharing; never expose to the internet."],
        465: ["SMTPS", "Mail submission over TLS."],
        587: ["SMTP submission", "Mail sending from a mail app, with STARTTLS."],
        636: ["LDAPS", "Directory lookups over TLS."],
        993: ["IMAPS", "Mail access over TLS."],
        995: ["POP3S", "Mail download over TLS."],
        1433: ["Microsoft SQL Server", "Database; keep it on the LAN."],
        1521: ["Oracle database", "Database; keep it on the LAN."],
        3000: ["Node dev server", "Common default for local web development."],
        3306: ["MySQL / MariaDB", "Database; keep it on the LAN."],
        3389: ["RDP", "Windows Remote Desktop; do not open it to the internet."],
        5173: ["Vite dev server", "Default port of the Vite development server."],
        5432: ["PostgreSQL", "Database; keep it on the LAN."],
        5900: ["VNC", "Remote screen sharing; weak by default."],
        5985: ["WinRM (HTTP)", "Windows remote management."],
        5986: ["WinRM (HTTPS)", "Windows remote management over TLS."],
        6379: ["Redis", "Cache and queue; never expose without a password."],
        8000: ["Local web server", "Common default for development servers."],
        8080: ["HTTP alternate", "Proxies and development servers; FRIDAY's dev UI in cloud mode."],
        8443: ["HTTPS alternate", "Web with encryption on a non-standard port."],
        8765: ["FRIDAY kernel", "FRIDAY's local Python kernel; loopback only."],
        9200: ["Elasticsearch", "Search server HTTP API."],
        11434: ["Ollama", "Local model server HTTP API."],
        27017: ["MongoDB", "Database; keep it on the LAN."],
      };

      const NAMES = [];
      for (const [port, [name]] of Object.entries(PORTS))
        NAMES.push([name.toLowerCase(), Number(port)]);

      async function run(input = {}) {
        const text = String(input?.prompt ?? input?.text ?? input?.port ?? "").toLowerCase();
        const ports = new Set();
        for (const m of text.matchAll(/\b(\d{1,5})\b/g)) {
          const n = Number(m[1]);
          if (n >= 1 && n <= 65535 && PORTS[n]) ports.add(n);
        }
        const asked = [];
        for (const m of text.matchAll(/\b(\d{1,5})\b/g)) {
          const n = Number(m[1]);
          if (n >= 1 && n <= 65535) asked.push(n);
        }
        const byName = new Set();
        for (const [name, port] of NAMES) {
          const words = name
            .split(/[\s/()]+/)
            .filter((w) => w.length >= 3 || /^(?:ssh|ftp|dns|rdp|smb|vnc)$/.test(w));
          if (words.some((w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}\\b`).test(text)))
            byName.add(port);
        }
        const hits = [...new Set([...ports, ...(ports.size ? [] : byName)])].sort((a, b) => a - b);
        if (!hits.length) {
          return {
            ok: false,
            error: asked.length
              ? `No well-known service listed for port ${asked.slice(0, 5).join(", ")}.`
              : "Name a port number or a service, e.g. what is port 3389, or which port does ssh use.",
          };
        }
        const items = hits.map((p) => ({ port: p, service: PORTS[p][0], note: PORTS[p][1] }));
        return {
          ok: true,
          items,
          answer: items.map((i) => `${i.port}: ${i.service}. ${i.note}`).join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-ip-inspect",
    gate: null,
    run: (() => {
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
        if (x === 192 && y === 0 && z === 2)
          return ["documentation", "192.0.2.0/24: examples only"];
        if (x === 192 && y === 168) return ["private", "192.168.0.0/16: home router LAN"];
        if (x === 198 && (y === 18 || y === 19))
          return ["benchmark", "198.18.0.0/15: network testing"];
        if (x === 198 && y === 51 && z === 100)
          return ["documentation", "198.51.100.0/24: examples only"];
        if (x === 203 && y === 0 && z === 113)
          return ["documentation", "203.0.113.0/24: examples only"];
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
          body =
            tail[1] + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
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
        if ((g[0] & 0xffc0) === 0xfe80)
          return ["link-local", "fe80::/10: this network segment only"];
        if ((g[0] & 0xfe00) === 0xfc00) return ["private", "fc00::/7: unique local address, a LAN"];
        if ((g[0] & 0xff00) === 0xff00) return ["multicast", "ff00::/8: group delivery"];
        if (g[0] === 0x2001 && g[1] === 0x0db8)
          return ["documentation", "2001:db8::/32: examples only"];
        if ((g[0] & 0xe000) === 0x2000)
          return ["public", "Global unicast: routable on the internet"];
        return ["reserved", "Not in a normally used range"];
      }

      async function run(input = {}) {
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
        return {
          ok: true,
          items,
          answer: items.map((i) => `${i.ip}: ${i.kind} (${i.note})`).join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-cidr-calc",
    gate: null,
    run: (() => {
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

      async function run(input = {}) {
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
          if (!/^1*0*$/.test(bin))
            return { ok: false, error: "That subnet mask is not contiguous." };
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
        const tests = [...text.replace(m[0], " ").matchAll(/\d{1,3}(?:\.\d{1,3}){3}/g)].map(
          (x) => x[0],
        );
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

      return run;
    })(),
  },
  {
    id: "web-http-status",
    gate: /http|status|error|gateway|not found|timed? ?out|ssl|tls|dns|connection|refused|reset|forbidden|unauthori[sz]ed|\bcode\b/,
    run: (() => {
      // FRIDAY · skill: web-http-status
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Explains HTTP status codes and the network and file error names that appear in logs, with what to try.

      const HTTP = {
        100: ["Continue", "The server got the request headers; the client may send the body."],
        101: ["Switching Protocols", "The connection is being upgraded (WebSocket)."],
        200: ["OK", "The request worked."],
        201: ["Created", "The request worked and made a new resource."],
        202: ["Accepted", "Received and queued; the work is not finished yet."],
        204: ["No Content", "It worked and there is nothing to return."],
        206: [
          "Partial Content",
          "Only a range of the file was returned (resumed or chunked download).",
        ],
        301: ["Moved Permanently", "The address changed for good: use the new Location."],
        302: ["Found", "Temporary redirect: follow Location, keep the old address."],
        303: ["See Other", "Fetch the Location with GET."],
        304: ["Not Modified", "Your cached copy is still current."],
        307: ["Temporary Redirect", "Repeat the same request at Location."],
        308: ["Permanent Redirect", "Repeat the same request at the new Location, for good."],
        400: [
          "Bad Request",
          "The server could not understand the request: check the URL, headers and body.",
        ],
        401: [
          "Unauthorized",
          "Credentials are missing or wrong: sign in or send a valid key or token.",
        ],
        403: [
          "Forbidden",
          "Understood but refused: no permission, a blocked region, or a firewall.",
        ],
        404: [
          "Not Found",
          "No such address: check the spelling or whether the link was removed or moved.",
        ],
        405: ["Method Not Allowed", "This address does not accept that method (GET, POST...)."],
        406: ["Not Acceptable", "The server cannot give what the Accept headers ask for."],
        408: ["Request Timeout", "The server gave up waiting for the request."],
        409: [
          "Conflict",
          "The request clashes with the current state (a duplicate or an edit conflict).",
        ],
        410: ["Gone", "Removed on purpose and not coming back."],
        413: ["Content Too Large", "The body is bigger than the server allows."],
        414: ["URI Too Long", "The address is too long."],
        415: ["Unsupported Media Type", "The server does not accept this content type."],
        418: ["I'm a teapot", "A joke status; some servers use it to refuse bots."],
        422: ["Unprocessable Content", "Well-formed but the values are invalid."],
        429: ["Too Many Requests", "Rate limit: slow down and retry after the Retry-After time."],
        431: ["Request Header Fields Too Large", "Headers or cookies are too big."],
        451: ["Unavailable For Legal Reasons", "Blocked for a legal reason."],
        500: [
          "Internal Server Error",
          "The server failed on its side: retry later or tell the site owner.",
        ],
        501: ["Not Implemented", "The server does not support this request."],
        502: ["Bad Gateway", "A proxy or gateway got a bad answer from the server behind it."],
        503: ["Service Unavailable", "Overloaded or down for maintenance: retry later."],
        504: ["Gateway Timeout", "A proxy waited too long for the server behind it."],
        505: ["HTTP Version Not Supported", "The server does not speak this HTTP version."],
        507: ["Insufficient Storage", "The server is out of storage."],
        511: ["Network Authentication Required", "A captive portal (Wi-Fi login) is in the way."],
        520: [
          "Web Server Returned an Unknown Error (Cloudflare)",
          "Cloudflare got an empty or unexpected answer from the origin.",
        ],
        521: ["Web Server Is Down (Cloudflare)", "Cloudflare could not connect to the origin."],
        522: [
          "Connection Timed Out (Cloudflare)",
          "Cloudflare reached the origin but it did not answer in time.",
        ],
        523: ["Origin Is Unreachable (Cloudflare)", "Cloudflare cannot route to the origin."],
        524: [
          "A Timeout Occurred (Cloudflare)",
          "The origin answered the connection but was too slow to reply.",
        ],
        525: [
          "SSL Handshake Failed (Cloudflare)",
          "Cloudflare could not complete TLS with the origin.",
        ],
        526: ["Invalid SSL Certificate (Cloudflare)", "The origin's certificate is not valid."],
      };

      const ERRORS = {
        ENOTFOUND: [
          "DNS lookup failed: the host name does not exist or cannot be resolved.",
          "Check the spelling, the connection and the DNS or VPN settings.",
        ],
        EAI_AGAIN: ["A temporary DNS failure.", "Retry; check the connection or the DNS server."],
        ECONNREFUSED: [
          "The host answered but nothing is listening on that port.",
          "The service is not running, or the port or address is wrong.",
        ],
        ECONNRESET: [
          "The other side closed the connection abruptly.",
          "Retry; a proxy, firewall or flaky network may be cutting it.",
        ],
        ETIMEDOUT: [
          "The connection or the answer took too long.",
          "Check the network, proxy and firewall; retry with a longer timeout.",
        ],
        EPIPE: [
          "Writing to a connection that was already closed.",
          "The other side hung up first; retry.",
        ],
        EADDRINUSE: [
          "The port is already used by another program.",
          "Stop that program or choose another port.",
        ],
        EACCES: ["Permission denied.", "Run with the right permission or pick a folder you own."],
        EPERM: [
          "The operation is not permitted (a locked file, antivirus or policy).",
          "Close the program using it or run as administrator.",
        ],
        ENOENT: ["No such file or directory.", "Check the path and spelling."],
        ENOSPC: ["No space left on the device.", "Free disk space."],
        EMFILE: ["Too many open files in this process.", "Close files or raise the limit."],
        CERT_HAS_EXPIRED: [
          "The server's TLS certificate has expired.",
          "The site owner must renew it; check your PC clock is correct.",
        ],
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: [
          "The certificate chain cannot be verified.",
          "A proxy or antivirus may be re-signing traffic: trust its root certificate or fix the chain.",
        ],
        DEPTH_ZERO_SELF_SIGNED_CERT: [
          "The server uses a self-signed certificate.",
          "Trust it deliberately, or use a properly signed one.",
        ],
        SELF_SIGNED_CERT_IN_CHAIN: [
          "A certificate in the chain is self-signed (often a corporate proxy).",
          "Add the proxy's root certificate to the trust store.",
        ],
        ERR_TLS_CERT_ALTNAME_INVALID: [
          "The certificate is for a different host name.",
          "Use the host name the certificate was issued for.",
        ],
      };

      async function run(input = {}) {
        const text = String(input?.code ?? input?.text ?? input?.prompt ?? "");
        const results = [];
        for (const m of text.matchAll(/(?<![\d.])([1-5]\d{2})(?![\d.])/g)) {
          const row = HTTP[m[1]];
          if (row && !results.some((r) => r.code === m[1]))
            results.push({
              kind: "HTTP status",
              code: m[1],
              name: row[0],
              meaning: row[1],
              class: ["informational", "success", "redirect", "client error", "server error"][
                Number(m[1][0]) - 1
              ],
            });
        }
        const upper = text.toUpperCase();
        for (const [name, [meaning, tryThis]] of Object.entries(ERRORS)) {
          if (upper.includes(name))
            results.push({ kind: "error name", code: name, meaning, tryThis });
        }
        if (!results.length) {
          const unknownHttp = (text.match(/(?<![\d.])[1-5]\d{2}(?![\d.])/) ?? [])[0];
          return {
            ok: false,
            error: unknownHttp
              ? `${unknownHttp} is not in the list of common status codes here. Check the server's own documentation.`
              : "Give an HTTP status (404, 502) or an error name (ECONNRESET, ENOTFOUND, CERT_HAS_EXPIRED).",
          };
        }
        return {
          ok: true,
          answer: results
            .map((r) =>
              r.kind === "HTTP status"
                ? `${r.code} ${r.name}: ${r.meaning}`
                : `${r.code}: ${r.meaning} ${r.tryThis}`,
            )
            .join("\n"),
          results,
          tip: "4xx means the request or your access is the problem; 5xx means the server is. A 429 or 503 usually clears if you wait and retry.",
        };
      }

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
