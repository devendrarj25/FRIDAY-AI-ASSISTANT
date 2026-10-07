import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { HudPanel, MetricBar, Ring, Sparkline, StatusPill } from "@/components/friday/ui";
import { useHardware, useSystemSensors, useWindowsSecurity } from "@/lib/friday/desktop";
import { useLiveMetrics, useSystemSample } from "@/lib/friday/use-live-metrics";
import { useNetwork } from "@/lib/friday/use-network";

const UNKNOWN_MACHINE = [
  { label: "Motherboard", value: null, reason: "unknown" },
  { label: "System", value: null, reason: "unknown" },
  { label: "Uptime", value: null, reason: "unknown" },
  { label: "Temperature", value: null, reason: "unknown" },
  { label: "Battery", value: null, reason: "unknown" },
  { label: "Storage free", value: null, reason: "unknown" },
];

export const Route = createFileRoute("/system")({
  head: () => ({
    meta: [
      { title: "Hardware — FRIDAY Console" },
      {
        name: "description",
        content:
          "Hardware overview for the machine FRIDAY runs on: CPU, GPU, memory, storage, temperatures and network throughput.",
      },
      { property: "og:title", content: "Hardware — FRIDAY Console" },
      { property: "og:description", content: "Live hardware and network telemetry for your PC." },
    ],
  }),
  component: SystemPage,
});

const SECURITY_LABELS = {
  on: "Enabled",
  off: "Disabled",
  partial: "Partial",
  unknown: "Unknown",
} as const;

const SECURITY_TONES = {
  on: "accent",
  off: "warning",
  partial: "warning",
  unknown: "muted",
} as const;

function SystemPage() {
  const detected = useHardware();
  const sensors = useSystemSensors();
  const live = useLiveMetrics();
  const sample = useSystemSample();
  const net = useNetwork();
  const { security, open: openSecurity } = useWindowsSecurity();

  const memTotalGb = sample?.ram.totalGb ?? detected?.memory.totalGb ?? null;
  const memFreeGb = sample?.ram.freeGb ?? detected?.memory.freeGb ?? null;
  const memUsedGb =
    sample?.ram.usedGb ??
    (memTotalGb !== null && memFreeGb !== null
      ? Math.round((memTotalGb - memFreeGb) * 10) / 10
      : null);
  const memPercent = sample?.ram.percent ?? live.ram.value;
  const gpu = detected?.gpus[0] ?? null;
  const vramPercent =
    gpu?.vramTotalMb && gpu.vramUsedMb
      ? Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100)
      : live.vram.value;

  return (
    <AppShell
      title="Hardware"
      subtitle="Machine overview · everything measured locally"
      actions={
        <Button size="sm" variant="outline" onClick={openSecurity}>
          <ShieldCheck className="size-4" /> Open Windows Security
        </Button>
      }
    >
      <div className="space-y-4">
        <HudPanel title="Hardware Overview" hint={live.live ? "live telemetry" : "sampling…"}>
          <div className="flex flex-wrap justify-around gap-4">
            <Ring
              value={live.cpu.value}
              label="CPU"
              sub={detected ? `${detected.cpu.cores} cores` : live.cpu.detail}
            />
            <Ring
              value={live.gpu.value}
              label="GPU"
              sub={gpu?.name ?? live.gpu.detail}
              tone="accent"
            />
            <Ring
              value={memPercent}
              label="RAM"
              sub={memTotalGb !== null ? `${memUsedGb} / ${memTotalGb} GB` : live.ram.detail}
              tone="magenta"
            />
            <Ring
              value={vramPercent}
              label="VRAM"
              sub={
                gpu?.vramTotalMb
                  ? `${Math.round(gpu.vramTotalMb / 1024)} GB total`
                  : live.vram.detail
              }
              tone="warning"
            />
            <Ring
              value={
                detected?.plan.threads
                  ? Math.round((detected.plan.threads / detected.cpu.cores) * 100)
                  : 0
              }
              label="Workers"
              sub={detected ? `${detected.plan.threads} threads` : "detecting"}
              tone="accent"
            />
            <Ring
              value={(detected?.cuda.toolkitAvailable ?? detected?.cuda.available) ? 100 : 0}
              label="CUDA"
              sub={
                detected?.cuda.version ??
                ((detected?.cuda.toolkitAvailable ?? detected?.cuda.available)
                  ? "toolkit available"
                  : detected?.cuda.driverAvailable
                    ? "driver only"
                    : "not available")
              }
              tone="warning"
            />
          </div>
        </HudPanel>

        {detected && (
          <HudPanel
            title="Acceleration"
            hint={`${detected.plan.backend.toUpperCase()} · detected on this PC`}
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {(
                [
                  ["CPU", `${detected.cpu.model} · ${detected.cpu.cores} cores`],
                  [
                    "GPU",
                    detected.gpus[0]
                      ? `${detected.gpus[0].name}${
                          detected.gpus[0].vramTotalMb
                            ? ` · ${Math.round(detected.gpus[0].vramTotalMb / 1024)} GB VRAM`
                            : ""
                        }`
                      : "none detected",
                  ],
                  [
                    "CUDA",
                    (detected.cuda.toolkitAvailable ?? detected.cuda.available)
                      ? `toolkit available${detected.cuda.version ? ` ${detected.cuda.version}` : ""}`
                      : detected.cuda.driverAvailable
                        ? "driver acceleration available · toolkit not installed"
                        : "not available",
                  ],
                  ["Memory", `${memFreeGb} GB free / ${memTotalGb} GB`],
                  ["Backend", detected.plan.reason],
                  ["Worker threads", `${detected.plan.threads} (UI core kept free)`],
                  ["RAM budget", `${detected.plan.maxRamGb} GB (70% cap)`],
                  [
                    "VRAM budget",
                    detected.plan.maxVramGb ? `${detected.plan.maxVramGb} GB (80% cap)` : "unused",
                  ],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label} className="rounded-sm border border-border bg-surface px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-foreground">{value}</p>
                </div>
              ))}
            </div>
          </HudPanel>
        )}

        <div className="grid gap-4 xl:grid-cols-2">
          <HudPanel title="Detailed Information">
            <div className="space-y-3">
              {(
                [
                  { label: "CPU", value: live.cpu.value, detail: live.cpu.detail, tone: "primary" },
                  { label: "GPU", value: live.gpu.value, detail: live.gpu.detail, tone: "accent" },
                  {
                    label: "RAM",
                    value: memPercent,
                    detail: detected ? `${memUsedGb} / ${memTotalGb} GB` : live.ram.detail,
                    tone: "magenta",
                  },
                  {
                    label: "VRAM",
                    value: vramPercent,
                    detail: gpu?.vramTotalMb
                      ? `${Math.round((gpu.vramUsedMb ?? 0) / 1024)} / ${Math.round(gpu.vramTotalMb / 1024)} GB`
                      : live.vram.detail,
                    tone: "warning",
                  },
                ] as const
              ).map((h) => (
                <MetricBar
                  key={h.label}
                  label={h.label}
                  value={h.value}
                  detail={h.detail}
                  tone={h.tone}
                />
              ))}
            </div>
            <dl className="mt-4 space-y-1.5 border-t border-border pt-3">
              {(detected
                ? [
                    { label: "System", value: detected.platform },
                    { label: "Architecture", value: detected.arch },
                    { label: "Processor", value: detected.cpu.model },
                    { label: "Uptime", value: sensors?.uptime.value ?? live.uptime },
                    { label: "Backend", value: detected.plan.reason },
                    {
                      label: "Memory free",
                      value: `${memFreeGb} GB of ${memTotalGb} GB`,
                    },
                    // WMI-only sensors: a reading that cannot be taken renders
                    // as a greyed-out dash, never as a fake number or an error.
                    {
                      label: "Motherboard",
                      value: sensors?.motherboard.value ?? null,
                      reason: sensors?.motherboard.reason ?? "reading…",
                    },
                    {
                      label: "Temperature",
                      value: sensors?.temperature.value ?? null,
                      reason: sensors?.temperature.reason ?? "reading…",
                    },
                    {
                      label: "Battery",
                      value: sensors?.battery.value ?? null,
                      reason: sensors?.battery.reason ?? "reading…",
                    },
                  ]
                : UNKNOWN_MACHINE
              ).map((d) => {
                const detail = d as { label: string; value: string | null; reason?: string };
                return (
                  <div
                    key={detail.label}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs"
                  >
                    <dt className="text-muted-foreground">{detail.label}</dt>
                    {detail.value ? (
                      <dd className="truncate font-mono text-foreground">{detail.value}</dd>
                    ) : (
                      <dd
                        className="truncate font-mono text-muted-foreground/60"
                        title={detail.reason ?? "unavailable"}
                      >
                        — unavailable
                      </dd>
                    )}
                  </div>
                );
              })}
            </dl>
          </HudPanel>

          <div className="space-y-4">
            <HudPanel title="Network" hint={net.online ? net.source : "offline"}>
              <div className="flex items-center gap-4">
                <div className="space-y-1 font-mono text-xs">
                  <p className="flex items-center gap-1.5 text-accent">
                    <ArrowUp className="size-3.5" />{" "}
                    {net.latencyMs >= 0 ? `${Math.round(net.latencyMs)} ms` : "—"}
                  </p>
                  <p className="flex items-center gap-1.5 text-primary">
                    <ArrowDown className="size-3.5" />{" "}
                    {net.downMbps >= 0 ? `${net.downMbps.toFixed(1)} Mbps` : "—"}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <Sparkline series={live.net.series} />
                </div>
              </div>
            </HudPanel>

            <HudPanel
              title="Windows Security Integration"
              hint={
                security
                  ? security.supported
                    ? `read ${new Date(security.detectedAt).toLocaleTimeString([], { hour12: false })}`
                    : "desktop app only"
                  : "reading…"
              }
            >
              <ul className="space-y-2 text-sm">
                {(security?.items ?? []).map((item) => (
                  <li
                    key={item.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 pb-2 last:border-0"
                    title={item.detail ?? undefined}
                  >
                    <span className="truncate text-muted-foreground">{item.label}</span>
                    <StatusPill
                      label={SECURITY_LABELS[item.state]}
                      tone={SECURITY_TONES[item.state]}
                    />
                  </li>
                ))}
                {!security && (
                  <li className="py-2 text-xs text-muted-foreground">
                    Reading security posture from Windows…
                  </li>
                )}
              </ul>
            </HudPanel>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
