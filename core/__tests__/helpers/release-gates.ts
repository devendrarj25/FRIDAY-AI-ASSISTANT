/**
 * One release-gate report across the three places the gates live: the renderer (`runGateSuite`), the main
 * process (privacy firewall, billing firewall, tool authority) and the kernel (its own tests, run as a child
 * process when Python and the kernel's packages are present). Every gate is exact, none is averaged, and a
 * gate that could not be run is listed as not checked, never as passed.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runGateSuite } from "../../../src/lib/friday/self/eval-suites";

const require_ = createRequire(import.meta.url);
const ROOT = resolve(__dirname, "../../..");

export type Gate = {
  id: string;
  where: "renderer" | "main" | "kernel";
  ok: boolean;
  detail: string;
};
export type GateReport = { gates: Gate[]; notChecked: string[]; failed: Gate[] };

const cloud = { id: "cloud-x", type: "cloud", label: "Some cloud model", provider: "openai" };
const local = { id: "local-x", type: "ollama", label: "Local model" };

function mainGates(): Gate[] {
  const firewall = require_("../../../electron/privacy-firewall.cjs");
  const billing = require_("../../../electron/billing-firewall.cjs");
  const authority = require_("../../../electron/tool-authority.cjs");
  const out: Gate[] = [];
  const add = (id: string, ok: boolean, detail: string) =>
    out.push({ id, where: "main", ok, detail });

  const secrets = [
    "my password: hunter2hunter2",
    "api_key=sk-live-abcdefghijklmnopqrstuvwxyz123456",
    "card 4111 1111 1111 1111 expires 12/30",
  ];
  for (const text of secrets) {
    const d = firewall.guardEgress({ model: cloud, content: text, connected: true });
    add(
      `sensitive-never-auto-to-cloud:${text.slice(0, 12)}`,
      d.external === true && d.autoAllowed === false && d.requiresConfirmation === true,
      d.reason,
    );
  }
  const onPc = firewall.guardEgress({ model: local, content: secrets[0], connected: true });
  add("local-model-keeps-data-on-pc", onPc.external === false, onPc.reason);

  const unknownPaid = billing.guardProviderRequest({
    model: { id: "p", type: "cloud", access: "paid" },
    billing: null,
    explicitPaid: false,
  });
  add("paid-model-blocked-until-allowed", unknownPaid.allowed === false, unknownPaid.reason);
  const unknownCost = billing.guardProviderRequest({
    model: { id: "u", type: "cloud", access: "unknown" },
    billing: null,
    explicitPaid: false,
  });
  add(
    "unknown-cost-model-blocked-until-allowed",
    unknownCost.allowed === false,
    unknownCost.reason,
  );

  add(
    "stored-allow-cannot-weaken-exec",
    authority.decide("shell.run", "exec", { "shell.run": "allow" }) === "ask",
    "a remembered allow still asks for exec",
  );
  add(
    "stored-allow-cannot-weaken-write",
    authority.decide("fs.delete", "write", { "fs.delete": "allow" }) === "ask",
    "a remembered allow still asks for write",
  );
  add(
    "stored-deny-wins",
    authority.decide("fs.read", "safe", { "fs.read": "deny" }) === "deny",
    "a deny beats the default",
  );
  add(
    "unknown-risk-asks",
    authority.decide("odd.tool", "weird", {}) === "ask",
    "an unknown tier is not allowed silently",
  );
  const a = authority.issue("secret", { tool: "fs.read", args: { path: "a" } });
  const b = authority.issue("secret", { tool: "fs.read", args: { path: "a" } });
  add("authorization-single-use-nonce", a !== b, "two tokens for the same call differ");
  add(
    "authorization-bound-to-arguments",
    authority.hashArgs({ path: "a" }) !== authority.hashArgs({ path: "b" }),
    "different arguments hash differently",
  );
  return out;
}

function kernelGates(): { gates: Gate[]; notChecked: string[] } {
  const python = process.env["PYTHON"] ?? "python";
  const probe = spawnSync(python, ["-c", "import httpx, fastapi, pytest"], { cwd: ROOT });
  if (probe.status !== 0) {
    return {
      gates: [],
      notChecked: ["kernel-authority-privacy-billing (python or kernel packages missing)"],
    };
  }
  const files = ["test_authority.py", "test_kernel_privacy.py", "test_kernel_billing.py"].map(
    (name) => `kernel/tests/${name}`,
  );
  const run = spawnSync(python, ["-m", "pytest", "-q", "-p", "no:cacheprovider", ...files], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    gates: [
      {
        id: "kernel-authority-privacy-billing",
        where: "kernel",
        ok: run.status === 0,
        detail: (run.stdout || run.stderr || "").trim().split("\n").slice(-1)[0] ?? "",
      },
    ],
    notChecked: [],
  };
}

export function buildGateReport(options: { withKernel?: boolean } = {}): GateReport {
  const yaml = readFileSync(resolve(ROOT, "config/kernel.yaml"), "utf8");
  const renderer = runGateSuite({ kernelYaml: yaml });
  const gates: Gate[] = renderer.gates.map((gate) => ({ ...gate, where: "renderer" as const }));
  const notChecked = [...renderer.notChecked];
  gates.push(...mainGates());
  if (options.withKernel !== false) {
    const kernel = kernelGates();
    gates.push(...kernel.gates);
    notChecked.push(...kernel.notChecked);
  }
  return { gates, notChecked, failed: gates.filter((gate) => !gate.ok) };
}
