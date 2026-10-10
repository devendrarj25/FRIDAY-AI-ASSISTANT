#!/usr/bin/env node
/**
 * FRIDAY — MCP desktop bundle.
 *
 * Packs the existing stdio launcher into a .mcpb zip (manifest 0.3).
 * The bundle does not start a second server. A client that cannot read
 * .mcpb still uses the Connectors snippets.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const identity = require("./identity.cjs");
const engine = require("./release-engine.cjs");

const ROOT = path.resolve(__dirname, "..");
const FILES = ["friday-mcp.cjs", "mcp-protocol.cjs", "mcp-launch.cjs"];

function dosStamp() {
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day =
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value & 0xffff, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function storeZip(entries) {
  const stamp = dosStamp();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(stamp.time),
      u16(stamp.day),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(stamp.time),
      u16(stamp.day),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}

function bundleManifest(root = ROOT) {
  const version = engine.readCanonicalIdentity({ root }).releaseVersion;
  return {
    manifest_version: "0.3",
    name: "friday",
    display_name: identity.PRODUCT,
    version,
    description:
      "Local FRIDAY assistant. The desktop app must already be running with the MCP server on.",
    author: { name: identity.OWNER },
    server: {
      type: "node",
      entry_point: "server/friday-mcp.cjs",
      mcp_config: {
        command: "node",
        args: ["${dirname}/server/friday-mcp.cjs"],
      },
    },
    compatibility: {
      platforms: ["win32"],
      runtimes: { node: ">=22.19.0" },
    },
  };
}

function buildBundle(root = ROOT, outFile) {
  const manifest = bundleManifest(root);
  const entries = [
    {
      name: "manifest.json",
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    },
  ];
  for (const file of FILES) {
    const source = path.join(root, "electron", file);
    entries.push({
      name: `server/${file}`,
      data: fs.readFileSync(source),
    });
  }
  const dest = outFile || path.join(root, "release", "friday.mcpb");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, storeZip(entries));
  return { ok: true, file: dest, manifest, files: entries.map((entry) => entry.name) };
}

function main() {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const built = buildBundle(ROOT, out);
  console.log(built.file);
}

module.exports = { FILES, bundleManifest, buildBundle, storeZip };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  }
}
