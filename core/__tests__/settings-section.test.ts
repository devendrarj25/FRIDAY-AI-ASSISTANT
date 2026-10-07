import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("Settings section upgrade", () => {
  it("keeps Companion and Updates and does not edit the navigation registry", () => {
    const page = read("src/routes/settings.tsx");
    expect(page).toContain('key: "companion"');
    expect(page).toContain('key: "updates"');
    expect(page).toContain('key: "general"');
    expect(page).toContain('key: "appearance"');
    expect(page).toContain('key: "ai"');
    expect(page).toContain('key: "autonomy"');
    expect(page).toContain('key: "voice"');
    expect(page).toContain('key: "memory"');
    expect(page).toContain('key: "permissions"');
    expect(page).toContain('key: "security"');
    expect(page).toContain('key: "performance"');
    expect(page).toContain('key: "notifications"');
    expect(page).toContain('key: "backup"');
    expect(page).toContain('key: "advanced"');
    expect(page).not.toContain('from "@/lib/friday/navigation"');
  });

  it("does not ship fake AI temperature or context bars", () => {
    const ai = read("src/components/friday/settings/AISettings.tsx");
    expect(ai).not.toContain("0.35 · deterministic");
    expect(ai).not.toContain("32k of 64k tokens");
    expect(ai).toContain("ctxK");
    expect(ai).toContain("rememberChats");
  });

  it("wires General startup to the Electron login-item bridge", () => {
    const general = read("src/components/friday/settings/GeneralSettings.tsx");
    expect(general).toContain("getStartWithWindows");
    expect(general).toContain("setStartWithWindows");
    expect(general).toContain("githubSetConfig");
    expect(general).not.toContain('setField("githubToken")');
  });

  it("applies appearance, tray, and permission overlays from the real stores", () => {
    const appearance = read("src/lib/friday/appearance.ts");
    expect(appearance).toContain('classList.toggle("no-circuit"');
    expect(appearance).toContain('classList.toggle("no-gpu"');
    const main = read("electron/main.cjs");
    expect(main).toContain("function ownerPrefToggle");
    expect(main).toContain("applyOwnerPermissionOverlay");
    expect(main).toContain("blockUnknownHosts");
    expect(main).toContain("security:encryption");
    expect(main).toContain("window:open-devtools");
    const preload = read("electron/preload.cjs");
    expect(preload).toContain("encryptionStatus");
    expect(preload).toContain("reportBusy");
    expect(main).toContain("setSampleMs");
    expect(main).toContain("launchMinimized");
    expect(main).not.toContain("if (true)");
  });

  it("keeps the GitHub token on the credential store", () => {
    const general = read("src/components/friday/settings/GeneralSettings.tsx");
    const updates = read("src/components/friday/settings/GithubUpdates.tsx");
    expect(general).toContain("githubSetConfig");
    expect(updates).toContain("githubSetConfig");
  });

  it("wires new Settings controls to real engines", () => {
    const appearance = read("src/lib/friday/appearance.ts");
    const chat = read("src/components/friday/ChatDock.tsx");
    const notes = read("src/components/friday/settings/NotificationSettings.tsx");
    const backup = read("src/components/friday/settings/BackupSettings.tsx");
    const creds = read("electron/credentials.cjs");
    const monitor = read("electron/system-monitor.cjs");
    expect(appearance).toContain("followSystem");
    expect(chat).toContain("chatTimestamps");
    expect(notes).toContain("doNotDisturb");
    expect(notes).toContain("quietHours");
    expect(backup).toContain("SETTINGS_BACKUP_KIND");
    expect(creds).toContain("ownerRefusesUnencrypted");
    expect(monitor).toContain("function setSampleMs");
  });

  it("keeps color mode and accent independent and loads the offered webfonts", () => {
    const appearance = read("src/lib/friday/appearance.ts");
    const panel = read("src/components/friday/settings/AppearanceSettings.tsx");
    const css = read("src/styles.css");
    const html = read("src/renderer/index.html");
    const root = read("src/routes/__root.tsx");
    expect(appearance).toContain("persistAccent");
    expect(appearance).toContain("persistColorMode");
    expect(appearance).toContain("bodyFont");
    expect(appearance).toContain("Atkinson Hyperlegible");
    expect(panel).toContain("Color combinations");
    expect(panel).toContain("persistAccent");
    expect(panel).not.toContain("preferences.setTheme(a)");
    expect(css).toContain("--friday-panel-opacity");
    expect(css).toContain("--friday-density-scale");
    expect(css).toContain('html[data-text-size="Small"]');
    expect(css).toContain(".theme-daylight.theme-green");
    expect(html).toContain("Inter+Tight");
    expect(html).toContain("Atkinson+Hyperlegible");
    expect(root).toContain("Inter+Tight");
    expect(root).toContain("Lexend");
  });

  it("does not leave Voice save or session-lock copy stuck", () => {
    const voice = read("src/components/friday/settings/VoiceSettings.tsx");
    const lock = read("src/components/friday/settings/SessionLock.tsx");
    const permissions = read("src/components/friday/settings/PermissionSettings.tsx");
    expect(voice).toContain(".finally(() => setBusy(false))");
    expect(lock).toContain('lockedBy === "now"');
    expect(permissions).toContain('toast.error("Could not update tool policy")');
  });
});
