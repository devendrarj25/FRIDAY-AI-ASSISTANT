/**
 * Phone companion PWA upgrade contracts: registry parity, What's New source,
 * honest permission states, service worker, no parallel remote-access path.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_NAV_ITEMS, SETTINGS_NAV, companionFeatures } from "../../src/lib/friday/navigation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const companion = read("kernel/companion.py");
const changelog = read("CHANGELOG.md");
const version = JSON.parse(read("config/friday-version.json")) as {
  major: number;
  minor: number;
  patch: number;
  revision: number;
};
const publicVersion = `${version.major}.${version.minor}.${version.patch}.${version.revision}`;

describe("companion registry parity", () => {
  it("lists every desktop nav destination plus Settings, including Main Window", () => {
    const features = companionFeatures();
    const ids = new Set(features.map((f) => f.id));
    for (const item of ALL_NAV_ITEMS) {
      expect(ids.has(item.to), item.to).toBe(true);
    }
    expect(ids.has(SETTINGS_NAV.to)).toBe(true);
    expect(ids.has("/")).toBe(true);
    expect(features).toHaveLength(ALL_NAV_ITEMS.length + 1);
    expect(companion).toContain("if(f.id==='/')");
  });
});

describe("companion What's New", () => {
  it("reads CHANGELOG.md for the current public version, never invented notes", () => {
    expect(companion).toContain("def companion_whats_new");
    expect(companion).toContain('source = "CHANGELOG.md"');
    expect(companion).not.toContain("FRIDAY 1.0.0.3 includes");
    expect(changelog).toContain(`## v${publicVersion}`);
    expect(read("electron-builder.yml")).toContain("from: CHANGELOG.md");
  });
});

describe("companion permissions honesty", () => {
  it("requests the camera only when the owner taps 📷 or Ask, and never fakes granted", () => {
    expect(companion).toContain("getUserMedia({video:true");
    expect(companion).toContain('id="cam"');
    expect(companion).toContain("type:'camera'");
    expect(companion).toContain("not requested — tap 📷 or Ask to use the camera");
    expect(companion).toContain("unsupported by this browser");
    expect(companion).toContain("Notification.requestPermission");
    expect(companion).toContain("periodicSync");
    expect(companion).toContain("blocked until you tap (autoplay)");
    expect(companion).not.toMatch(/\.play\(\)\.catch\(\(\)=>\{\}\)/);
    expect(companion).toContain("This browser blocked autoplay");
    expect(companion).toContain("window.isSecureContext");
    expect(companion).toContain("getRegistration('/companion')");
    expect(companion).not.toContain("navigator.serviceWorker.ready");
    expect(companion).toContain("unsupported on this http page (needs https or localhost)");
  });

  it("registers a same-origin service worker under /companion", () => {
    expect(companion).toContain("COMPANION_SW");
    expect(companion).toContain("navigator.serviceWorker.register('/companion/sw.js'");
    expect(companion).toContain('"/companion/sw.js"');
    expect(companion).toContain('@router.get("/sw.js")');
    expect(companion).toContain("window.isSecureContext && 'serviceWorker' in navigator");
  });
});

describe("off-LAN control on the Devices Phone companion panel", () => {
  it("calls the existing companionRemote IPC and keeps pairing/revoke", () => {
    const devices = read("src/routes/devices.tsx");
    expect(devices).toContain("companionRemote");
    expect(devices).toContain("setCompanionRemote");
    expect(devices).toContain('from "@/lib/friday/desktop"');
    expect(devices).toContain("Off-LAN is off (LAN pairing only).");
    expect(devices).toContain("Off-LAN is on, but Tailscale is not ready — no URL.");
    expect(devices).toContain("Tailscale URL:");
    expect(devices).toContain("New pairing code");
    expect(devices).toContain("store.revoke");
    expect(devices).toContain("No phone paired yet.");
    expect(companion).toContain("Off-LAN is off (LAN pairing only).");
    expect(companion).toContain("Tailscale URL:");
  });
});

describe("iOS PWA standalone meta", () => {
  it("adds apple-mobile-web-app tags beside the existing mobile-web-app-capable tag", () => {
    expect(companion).toContain('name="mobile-web-app-capable" content="yes"');
    expect(companion).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(companion).toContain(
      'name="apple-mobile-web-app-status-bar-style" content="black-translucent"',
    );
    expect(companion).toContain('name="apple-mobile-web-app-title" content="FRIDAY"');
  });
});
