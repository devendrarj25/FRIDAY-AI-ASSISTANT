/**
 * Connectors page: real auth-type controls, search/categories, no pack-import
 * chrome (connectors are not folder-importable packs).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("connectors page is wired to real auth, not a marketplace copy", () => {
  const page = read("src/routes/connectors.tsx");
  const renderer = read("src/lib/friday/connectors.ts");
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");

  it("has no CapabilityImport / Marketplace pack buttons", () => {
    expect(page).not.toContain("CapabilityImport");
    expect(page).not.toContain("Marketplace");
    expect(page).not.toContain("installFromGithub");
    expect(page).not.toContain("Forge");
  });

  it("keeps the real Save / Recheck / Disconnect / Refresh controls", () => {
    expect(page).toContain("Connect & verify");
    expect(page).toContain("Re-check");
    expect(page).toContain("Disconnect");
    expect(page).toContain("Refresh");
    expect(page).toContain("FilterTabs");
    expect(page).toContain("Search name, category, or summary");
    expect(page).toContain(
      "connector.connected || connector.configured || Boolean(connector.lastError)",
    );
  });

  it("renders OAuth, phone, and MCP login controls from authType", () => {
    expect(page).toContain("Connect with {connector.name}");
    expect(page).toContain("Send SMS code");
    expect(page).toContain("Confirm code");
    expect(page).toContain('authType === "oauth"');
    expect(page).toContain('authType === "phone"');
    expect(renderer).toContain("authType?: ConnectorAuthType");
    expect(renderer).toContain("startOAuthConnector");
    expect(renderer).toContain("sendConnectorPhoneCode");
    expect(renderer).toContain("confirmConnectorPhoneCode");
    expect(main).toContain('ipcMain.handle("connectors:oauth-start"');
    expect(main).toContain('ipcMain.handle("connectors:phone-send"');
    expect(main).toContain('ipcMain.handle("connectors:phone-confirm"');
    expect(preload).toContain("connectors:oauth-start");
    expect(preload).toContain("connectors:phone-send");
    expect(preload).toContain("connectors:phone-confirm");
  });
});
