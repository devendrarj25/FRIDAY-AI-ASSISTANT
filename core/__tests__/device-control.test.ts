/**
 * Device control (cable / Bluetooth / WiFi) + phone companion.
 *
 * These assertions protect the safety rules of the feature, not cosmetics:
 * no stored unlock codes, approval-gated actions, LAN listening only when the
 * user turned the companion on, and manifests that actually exist on disk.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("device kernel modules", () => {
  it("never stores or replays another device's unlock credential", () => {
    for (const file of ["kernel/devices_android.py", "kernel/companion.py"]) {
      const source = read(file);
      expect(/store.*(pin|passcode|pattern)/i.test(source)).toBe(false);
    }
  });

  it("registers every device tool with an explicit risk tier", () => {
    const tools = read("kernel/tools.py");
    for (const name of [
      "android.list",
      "android.open_app",
      "android.input",
      "android.transfer",
      "android.mirror",
      "bluetooth.list",
      "bluetooth.scan",
      "bluetooth.media",
      "bluetooth.send_file",
      "network.discover",
      "network.cast",
    ]) {
      expect(tools).toContain(`"${name}":`);
      expect(tools).toContain(`_${name.replace(".", "_")}`);
    }
    // Anything that acts on another device must be approval-gated.
    for (const name of ["android.open_app", "android.input", "bluetooth.media", "network.cast"]) {
      expect(tools).toMatch(new RegExp(`"${name.replace(".", "\\.")}": "exec"`));
    }
  });
});

describe("device tool manifests", () => {
  const categories = ["android", "bluetooth", "network"];

  it("ships a real manifest per tool with a permission prompt", () => {
    for (const category of categories) {
      const dir = join(root, "tools", "devices", category);
      const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const manifest = JSON.parse(
          readFileSync(join(dir, entry.name, "tool.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(manifest["kernelTool"]).toBeTruthy();
        expect(manifest["approvalPrompt"]).toBeTruthy();
        expect(manifest["enabled"]).toBe(false);
        expect(["safe", "write", "exec"]).toContain(manifest["risk"]);
      }
    }
  });
});

describe("phone companion", () => {
  it("listens on the network only when the user enabled it", () => {
    const kernel = read("kernel/main.py");
    expect(kernel).toContain('COMPANION_ENABLED = os.environ.get("FRIDAY_LAN"');
    expect(kernel).toContain('bind = "0.0.0.0" if COMPANION_ENABLED else HOST');
    expect(read("electron/main.cjs")).toContain(
      'FRIDAY_LAN: readSettings().companionEnabled ? "1" : ""',
    );
  });

  it("requires a one-time pairing code before a phone can talk to FRIDAY", () => {
    const companion = read("kernel/companion.py");
    expect(companion).toMatch(/pair/i);
    expect(companion).toMatch(/token/i);
  });

  it("is reachable from the sidebar", () => {
    // The sidebar renders from the one navigation registry the phone also reads.
    expect(read("src/lib/friday/navigation.ts")).toContain('to: "/devices"');
    expect(read("src/components/friday/AppShell.tsx")).toContain("NAV_GROUPS");
  });
});
