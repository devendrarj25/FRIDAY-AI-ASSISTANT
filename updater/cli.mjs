#!/usr/bin/env node
/**
 * FRIDAY · update CLI (check → download → verify → backup → apply → rollback).
 * Read-only by default: `apply` refuses to run without --confirm.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const engine = require_("../scripts/release-engine.cjs");
const identity = engine.readCanonicalIdentity({ root });
const currentVersion = identity?.releaseVersion || null;
const feed = process.env.FRIDAY_UPDATE_FEED ?? "";

async function check() {
  if (!currentVersion) {
    return { currentVersion: null, available: false, reason: "canonical version unresolved" };
  }
  if (!feed) return { currentVersion, available: false, reason: "no feed configured" };
  const res = await fetch(feed);
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const latest = await res.json();
  return {
    currentVersion,
    latestVersion: latest.version,
    available: engine.compareBuilds(String(latest.version || ""), currentVersion) > 0,
    url: latest.url,
    sha256: latest.sha256,
  };
}

const cmd = process.argv[2] ?? "check";
if (cmd === "check") console.log(JSON.stringify(await check(), null, 2));
else if (cmd === "apply" && !process.argv.includes("--confirm"))
  console.error("refusing to apply an update without --confirm");
else console.log(`updater: ${cmd} is wired to updater/${cmd}/ and requires the desktop app`);
