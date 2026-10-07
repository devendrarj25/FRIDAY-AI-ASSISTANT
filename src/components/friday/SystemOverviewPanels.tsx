/**
 * FRIDAY · System & Status overview panels.
 *
 * Everything rendered here is a live reading that some existing engine already
 * owns — the raw system sampler (CPU/RAM/GPU/disks/interfaces), the WMI sensor
 * probe, the Windows security probe, the unified system map and the doctor
 * registry. Nothing is probed twice and nothing is invented: a value this
 * machine cannot report is shown as unavailable.
 *
 * The subsystem panel is driven by the system map, so any capability, service
 * or component added to FRIDAY later appears here automatically.
 */
import { useMemo } from "react";
import { Cpu, HardDrive, Network, ShieldCheck, Thermometer } from "lucide-react";
import { HudPanel, MetricBar, StatTile, StatusPill, toneForStatus } from "@/components/friday/ui";
import { useSystemSample } from "@/lib/friday/use-live-metrics";
import { useHardware, useSystemSensors, useWindowsSecurity } from "@/lib/friday/desktop";
import { useSystemMap } from "@/lib/friday/use-system-map";
import { useDoctor } from "@/lib/friday/use-doctor";
import type { MapEntry, MapStatus } from "@/lib/friday/system-map";

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-6 text-center text-xs text-muted-foreground">{children}</p>
);

const barTone = (percent: number) =>
  percent >= 90 ? "warning" : percent >= 70 ? "magenta" : "accent";

/* ------------------------------------------------------------ machine ---- */

export function MachinePanel() {
  const hardware = useHardware();
  const sensors = useSystemSensors();
  const sample = useSystemSample();

  const rows: { label: string; value: string }[] = [];
  if (hardware) {
    rows.push({ label: "Platform", value: `${hardware.platform} · ${hardware.arch}` });
    rows.push({
      label: "Processor",
      value: `${hardware.cpu.model} · ${hardware.cpu.cores} cores${
        hardware.cpu.speedMhz ? ` · ${(hardware.cpu.speedMhz / 1000).toFixed(1)} GHz` : ""
      }`,
    });
    rows.push({
      label: "Memory",
      value: `${sample?.ram.totalGb ?? hardware.memory.totalGb} GB total · ${sample?.ram.freeGb ?? hardware.memory.freeGb} GB free`,
    });
    rows.push({
      label: "Graphics",
      value: hardware.gpus.length
        ? hardware.gpus
            .map(
              (g) => `${g.name}${g.vramTotalMb ? ` (${Math.round(g.vramTotalMb / 1024)} GB)` : ""}`,
            )
            .join(" · ")
        : "no discrete GPU detected",
    });
    rows.push({
      label: "Acceleration",
      value: `${hardware.plan.backend.toUpperCase()} · ${hardware.plan.threads} threads · ${hardware.plan.reason}`,
    });
    rows.push({
      label: "CUDA",
      value:
        (hardware.cuda.toolkitAvailable ?? hardware.cuda.available)
          ? `toolkit ${hardware.cuda.version ?? "available"}`
          : hardware.cuda.driverAvailable
            ? "driver acceleration available · toolkit not installed"
            : "not available",
    });
  }
  if (sensors) {
    const read = (r: { available: boolean; value: string | null; reason: string | null }) =>
      r.available && r.value ? r.value : (r.reason ?? "unavailable");
    rows.push({ label: "Motherboard", value: read(sensors.motherboard) });
    rows.push({ label: "BIOS", value: read(sensors.bios) });
    rows.push({ label: "Battery", value: read(sensors.battery) });
    rows.push({ label: "Temperature", value: read(sensors.temperature) });
    rows.push({ label: "OS uptime", value: read(sensors.uptime) });
  } else if (sample) {
    rows.push({ label: "OS uptime", value: sample.uptime });
  }

  return (
    <HudPanel
      title="Machine"
      hint={
        hardware
          ? `detected ${new Date(hardware.detectedAt).toLocaleTimeString([], { hour12: false })}`
          : "desktop app only"
      }
    >
      {rows.length ? (
        <dl className="grid gap-1.5">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 text-xs">
              <dt className="label-xs text-muted-foreground">{row.label}</dt>
              <dd className="truncate text-foreground" title={row.value}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <Empty>Hardware probes run in the FRIDAY desktop app.</Empty>
      )}
    </HudPanel>
  );
}

/* ------------------------------------------------------------- storage --- */

export function StoragePanel() {
  const sample = useSystemSample();
  const disks = sample?.disks ?? [];

  return (
    <HudPanel
      title="Storage"
      hint={
        disks.length ? `${disks.length} volume${disks.length === 1 ? "" : "s"}` : "desktop app only"
      }
    >
      {disks.length ? (
        <div className="space-y-2.5">
          {disks.map((disk) => (
            <MetricBar
              key={disk.id}
              label={disk.id}
              value={Math.round(disk.percent)}
              detail={`${Math.round(disk.totalGb - disk.freeGb)} / ${Math.round(disk.totalGb)} GB used · ${Math.round(disk.freeGb)} GB free`}
              tone={barTone(disk.percent)}
            />
          ))}
        </div>
      ) : (
        <Empty>Disk usage is measured in the FRIDAY desktop app.</Empty>
      )}
    </HudPanel>
  );
}

/* ------------------------------------------------------------- network --- */

export function NetworkPanel() {
  const sample = useSystemSample();
  const net = sample?.network;
  const addresses = net?.addresses ?? [];

  return (
    <HudPanel
      title="Network Interfaces"
      hint={
        net?.available
          ? `${net.downMbps !== null ? `${net.downMbps.toFixed(1)} Mbps down` : "measuring…"}${
              net.upMbps !== null ? ` · ${net.upMbps.toFixed(1)} up` : ""
            }`
          : (net?.reason ?? "desktop app only")
      }
    >
      {addresses.length ? (
        <ul className="space-y-2">
          {addresses.map((entry) => (
            <li
              key={`${entry.name}-${entry.address}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-foreground">
                  <Network className="size-3.5 text-accent" />
                  {entry.name}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {entry.mac ?? "—"}
                </span>
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">{entry.address}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Interface details are read in the FRIDAY desktop app.</Empty>
      )}
    </HudPanel>
  );
}

/* ------------------------------------------------------------ security --- */

export function SecurityPanel() {
  const { security, supported } = useWindowsSecurity();
  const items = security?.items ?? [];

  return (
    <HudPanel
      title="Windows Security"
      hint={
        security?.supported
          ? `${items.filter((i) => i.state === "on").length}/${items.length} protected`
          : supported
            ? "unsupported OS"
            : "desktop app only"
      }
    >
      {items.length ? (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-foreground">
                  <ShieldCheck className="size-3.5 text-accent" />
                  {item.label}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {item.detail ?? "—"}
                </span>
              </span>
              <StatusPill
                label={
                  item.state === "on"
                    ? "Online"
                    : item.state === "off"
                      ? "Offline"
                      : item.state === "partial"
                        ? "Degraded"
                        : "Unknown"
                }
                tone={toneForStatus(
                  item.state === "on" ? "Online" : item.state === "off" ? "Offline" : "Unknown",
                )}
              />
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Security posture is read in the FRIDAY desktop app.</Empty>
      )}
    </HudPanel>
  );
}

/* ---------------------------------------------------------- subsystems --- */

const statusLabel = (status: MapStatus) =>
  status === "ready"
    ? "Ready"
    : status === "running"
      ? "Running"
      : status === "degraded"
        ? "Degraded"
        : status === "idle"
          ? "Idle"
          : status === "stopped"
            ? "Offline"
            : status === "missing"
              ? "Missing"
              : "Unknown";

/**
 * Every FRIDAY subsystem the unified map knows about, grouped. New components
 * registered later show up here on the next refresh with no code change.
 */
export function SubsystemPanel() {
  const map = useSystemMap();

  const grouped = useMemo(() => {
    const byGroup = new Map<string, MapEntry[]>();
    for (const entry of map.entries) {
      const list = byGroup.get(entry.group) ?? [];
      list.push(entry);
      byGroup.set(entry.group, list);
    }
    return map.groups
      .filter((g) => byGroup.has(g.group))
      .map((g) => ({ ...g, entries: byGroup.get(g.group) ?? [] }));
  }, [map]);

  const problems = map.groups.reduce((n, g) => n + g.problems, 0);

  return (
    <HudPanel
      title="FRIDAY Subsystems"
      hint={
        map.entries.length
          ? `${map.entries.length} components · ${problems ? `${problems} need attention` : "all healthy"}`
          : "mapping…"
      }
    >
      {grouped.length ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {map.groups.map((g) => (
              <StatTile
                key={g.group}
                label={g.group}
                value={`${g.ready}/${g.total}`}
                state={
                  g.problems
                    ? `${g.problems} issue${g.problems === 1 ? "" : "s"}`
                    : `${g.idle} idle`
                }
                tone={g.problems ? "warning" : g.ready ? "accent" : "muted"}
              />
            ))}
          </div>
          <div className="space-y-3">
            {grouped.map((group) => (
              <div key={group.group}>
                <p className="label-xs mb-1 text-muted-foreground">{group.group}</p>
                <ul className="space-y-1.5">
                  {group.entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs"
                    >
                      <span className="min-w-0">
                        <span className="text-foreground">{entry.label}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {entry.detail || "—"}
                          {entry.version ? ` · ${entry.version}` : ""}
                        </span>
                      </span>
                      <StatusPill
                        label={statusLabel(entry.status)}
                        tone={toneForStatus(statusLabel(entry.status))}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Empty>No components mapped yet.</Empty>
      )}
    </HudPanel>
  );
}

/* --------------------------------------------------------- environment --- */

/** Runtime/toolchain readiness, straight from the doctor registry. */
export function RuntimePanel() {
  const doc = useDoctor();

  const groups = (() => {
    const byGroup = new Map<string, typeof doc.checks>();
    for (const check of doc.checks) {
      const list = byGroup.get(check.group) ?? [];
      list.push(check);
      byGroup.set(check.group, list);
    }
    return [...byGroup.entries()];
  })();

  const ready = doc.checks.filter((c) => c.status === "Ready").length;

  return (
    <HudPanel
      title="Runtimes & Environment"
      hint={
        doc.checks.length
          ? `${ready}/${doc.checks.length} ready${doc.scanning ? " · scanning" : ""}`
          : doc.desktop
            ? "scanning…"
            : "desktop app only"
      }
    >
      {groups.length ? (
        <div className="space-y-3">
          {groups.map(([group, checks]) => (
            <div key={group}>
              <p className="label-xs mb-1 text-muted-foreground">{group}</p>
              <ul className="space-y-1.5">
                {checks.map((check) => (
                  <li
                    key={check.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="text-foreground">{check.label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {check.detail || "—"}
                      </span>
                    </span>
                    <StatusPill label={check.status} tone={toneForStatus(check.status)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <Empty>Environment checks run in the FRIDAY desktop app.</Empty>
      )}
    </HudPanel>
  );
}

/* ----------------------------------------------------------- headline ---- */

/** Compact machine headline tiles shown above the detailed panels. */
export function MachineTiles() {
  const sample = useSystemSample();
  const hardware = useHardware();
  const sensors = useSystemSensors();

  const disks = sample?.disks ?? [];
  const diskUsed = disks.length
    ? Math.round(disks.reduce((n, d) => n + d.percent, 0) / disks.length)
    : 0;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatTile
        icon={<Cpu className="size-4" />}
        label="Cores"
        value={sample?.cpu.cores ?? hardware?.cpu.cores ?? 0}
        state={hardware?.plan.backend === "gpu" ? "GPU accelerated" : "CPU"}
        tone="accent"
      />
      <StatTile
        icon={<HardDrive className="size-4" />}
        label="Disk used"
        value={`${diskUsed}%`}
        state={disks.length ? `${disks.length} volumes` : "not measured"}
        tone={disks.length ? barTone(diskUsed) : "muted"}
      />
      <StatTile
        icon={<Network className="size-4" />}
        label="Interfaces"
        value={sample?.network?.addresses.length ?? 0}
        state={sample?.network?.available ? "measuring" : "not measured"}
        tone={sample?.network?.available ? "primary" : "muted"}
      />
      <StatTile
        icon={<Thermometer className="size-4" />}
        label="Uptime"
        value={sample?.uptime ?? "—"}
        state={
          sensors?.temperature.available && sensors.temperature.value
            ? sensors.temperature.value
            : "OS uptime"
        }
        tone="magenta"
      />
    </div>
  );
}
