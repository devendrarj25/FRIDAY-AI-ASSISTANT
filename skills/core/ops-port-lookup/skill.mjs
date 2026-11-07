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
for (const [port, [name]] of Object.entries(PORTS)) NAMES.push([name.toLowerCase(), Number(port)]);

export async function run(input = {}) {
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

export default run;
