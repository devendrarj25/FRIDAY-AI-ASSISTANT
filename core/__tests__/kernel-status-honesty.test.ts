import { describe, expect, it } from "vitest";
import { presentDesktopKernelStatus } from "../../src/lib/friday/use-kernel-status";
import { kernelStatus as previewStatus } from "../../src/lib/friday/mock";

describe("desktop kernel status is never sample data", () => {
  it("reports not connected instead of a live-looking default host", () => {
    const view = presentDesktopKernelStatus(null, null, null, null);
    expect(view.connected).toBe(false);
    expect(view.host).toBe("not connected");
    expect(view.version).toBe("not connected");
    expect(view.gpu).toBe("not connected");
    expect(view.host).not.toBe(previewStatus.host);
    expect(view.gpu).not.toContain("RTX");
  });

  it("uses the kernel payload only when connected is true", () => {
    const view = presentDesktopKernelStatus(
      {
        connected: true,
        host: "127.0.0.1:8765",
        version: "0.9.1",
        dataDir: "C:\\FRIDAY",
        gpu: "NVIDIA RTX 2000",
      },
      null,
      "C:\\FRIDAY",
      1_000,
      4_000,
    );
    expect(view.connected).toBe(true);
    expect(view.host).toBe("127.0.0.1:8765");
    expect(view.version).toBe("0.9.1");
    expect(view.uptime).toBe("00:00:03");
    expect(view.dataDir).toBe("C:\\FRIDAY");
  });

  it("ignores a payload that does not claim a live connection", () => {
    const view = presentDesktopKernelStatus(
      { host: "127.0.0.1:8765", version: "0.9.1" },
      null,
      null,
      1_000,
    );
    expect(view.connected).toBe(false);
    expect(view.host).toBe("not connected");
    expect(view.version).toBe("not connected");
  });
});
