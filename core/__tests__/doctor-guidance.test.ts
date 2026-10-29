import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  enrichCheck,
  formatGuidance,
  guidanceFor,
  stepsFor,
  type DoctorCheck,
} from "../../src/lib/friday/doctor-engine";
import { describeSelfReport, type SelfReport } from "../../src/lib/friday/brain/self-diagnosis";

const require_ = createRequire(import.meta.url);
const diagnostics = require_("../../electron/diagnostics.cjs") as {
  keyRejected: (error: string) => boolean;
  kernelOwnerSteps: () => string[];
};

const gpuCheck = (): DoctorCheck => ({
  id: "gpu",
  label: "GPU / VRAM",
  group: "Hardware",
  status: "Missing",
  detail: "no discrete GPU detected — CPU inference",
  cause: "No NVIDIA GPU / driver visible to nvidia-smi.",
  fix: "Install the latest GPU driver and the CUDA Toolkit, then rescan.",
  command: "nvidia-smi",
  fixable: false,
  steps: [
    "FRIDAY cannot install a GPU driver or grant herself hardware access — that is a Windows / vendor step.",
    "If this PC has an NVIDIA GPU: download the current Game Ready or Studio driver from NVIDIA, install it, then reboot Windows.",
    "For CUDA local models, install the CUDA Toolkit that matches that driver from developer.nvidia.com/cuda-downloads, then reboot again.",
    "Open a new terminal and run nvidia-smi — it must print the driver version, CUDA version and VRAM. If it is not recognised, the driver is not actually installed.",
    "Open Setup & Doctor and run a scan. FRIDAY re-reads nvidia-smi; she will never claim a GPU she cannot see.",
  ],
});

describe("doctor owner guidance", () => {
  it("does not treat a healthy check as needs-owner", () => {
    const check: DoctorCheck = {
      id: "kernel",
      label: "Python kernel bridge",
      group: "Services",
      status: "Running",
      detail: "accepting connections",
    };
    expect(guidanceFor(check)).toBeNull();
    expect(enrichCheck(check).repairKind).toBe("none-needed");
  });

  it("leaves a still-auto-fixable check to Repair instead of owner steps", () => {
    const check: DoctorCheck = {
      id: "kernel",
      label: "Python kernel bridge",
      group: "Services",
      status: "Missing",
      detail: "closed",
      fixable: true,
      fix: "restart the kernel",
    };
    expect(guidanceFor(check)).toBeNull();
    expect(enrichCheck(check).repairKind).toBeUndefined();
  });

  it("turns a GPU/driver miss into numbered owner steps, not a generic issue found", () => {
    const guidance = guidanceFor(gpuCheck());
    expect(guidance?.kind).toBe("needs-owner");
    const text = formatGuidance(guidance!);
    expect(text).toContain("What you need to do:");
    expect(text).toContain("1. FRIDAY cannot install a GPU driver");
    expect(text).toContain("nvidia-smi");
    expect(text).not.toMatch(/^issue found$/i);
  });

  it("after a failed auto-fix, a previously fixable check becomes needs-owner", () => {
    const check: DoctorCheck = {
      id: "cloud-providers",
      label: "Cloud AI providers",
      group: "AI",
      status: "Error",
      detail: "OpenAI (401)",
      cause: "The provider rejected the stored API key.",
      fixable: true,
      tried: true,
      steps: [
        "OpenAI rejected the stored API key (401). Open Models → Providers, paste a current OpenAI key from that provider's billing/API dashboard (not an expired or project-restricted key), and save. FRIDAY marks it connected only when the provider actually answers.",
      ],
    };
    const text = formatGuidance(guidanceFor(check)!);
    expect(text).toContain("Models → Providers");
    expect(text).toContain("paste a current OpenAI key");
  });

  it("chat/voice self-diagnosis prints the same numbered steps", () => {
    const report: SelfReport = {
      at: 1,
      healthy: false,
      inspected: true,
      problems: [
        {
          id: "doctor:gpu",
          severity: "critical",
          area: "Hardware",
          title: "GPU / VRAM — Missing",
          detail: "no discrete GPU detected — CPU inference",
          steps: stepsFor(gpuCheck()),
        },
      ],
      facts: [],
    };
    const spoken = describeSelfReport(report);
    expect(spoken).toContain("What you need to do:");
    expect(spoken).toContain("1. FRIDAY cannot install a GPU driver");
  });

  it("treats a rejected paid key as not safely auto-fixable", () => {
    expect(diagnostics.keyRejected("the provider rejected the stored API key")).toBe(true);
    expect(diagnostics.keyRejected("401 Unauthorized")).toBe(true);
    expect(diagnostics.keyRejected("timeout connecting to api")).toBe(false);
    const source = readFileSync(join(__dirname, "../../electron/diagnostics.cjs"), "utf8");
    expect(source).toContain("fixable: retryableBroken.length > 0");
    expect(source).toContain("FRIDAY cannot install a GPU driver");
  });

  it("hands numbered owner steps after kernel auto-restart gives up", () => {
    const steps = diagnostics.kernelOwnerSteps();
    expect(steps.length).toBeGreaterThanOrEqual(4);
    const check: DoctorCheck = {
      id: "kernel",
      label: "Python kernel bridge",
      group: "Services",
      status: "Missing",
      detail: "The local AI service stopped (exit 1).",
      cause: "The local AI service stopped (exit 1).",
      fixable: true,
      tried: true,
      steps,
    };
    const text = formatGuidance(guidanceFor(check)!);
    expect(text).toContain("What you need to do:");
    expect(text).toContain("1. FRIDAY already tried to restart");
    expect(text).toContain("Setup & Doctor");
    expect(text).not.toMatch(/^issue found$/i);
    const source = readFileSync(join(__dirname, "../../electron/diagnostics.cjs"), "utf8");
    expect(source).toContain("steps: kernelPortOpen ? undefined : kernelOwnerSteps()");
  });
});
