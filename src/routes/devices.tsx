import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Bluetooth,
  Cable,
  MonitorSmartphone,
  QrCode,
  RefreshCw,
  Smartphone,
  Wifi,
} from "lucide-react";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { ToggleRow } from "@/components/friday/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopApi, type CompanionRemoteState } from "@/lib/friday/desktop";
import { devices as store } from "@/lib/friday/devices";
import { useDevices } from "@/lib/friday/use-devices";
import { toast } from "sonner";

/** Same off-LAN sentences the phone companion already shows in renderNet(). */
function offLanStatusLine(remote: CompanionRemoteState | null): string {
  if (!remote) return "Off-LAN: desktop has not published a Tailscale probe yet.";
  const bits = [remote.detail || ""];
  if (remote.url) bits.push("Tailscale URL: " + remote.url);
  else if (remote.enabled) bits.push("Off-LAN is on, but Tailscale is not ready — no URL.");
  else bits.push("Off-LAN is off (LAN pairing only).");
  return bits.filter(Boolean).join(" ");
}

export const Route = createFileRoute("/devices")({
  head: () => ({
    meta: [
      { title: "Devices & Phone Companion — FRIDAY" },
      {
        name: "description",
        content:
          "Control your phone over a cable, your paired Bluetooth devices and anything on this WiFi network, and pair a phone as a FRIDAY companion on your local network.",
      },
      { property: "og:title", content: "Devices & Phone Companion — FRIDAY" },
      {
        property: "og:description",
        content: "Cable, Bluetooth and WiFi device control plus a local-network phone companion.",
      },
    ],
  }),
  component: DevicesPage,
});

function DevicesPage() {
  const state = useDevices();
  const [app, setApp] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [remote, setRemote] = useState<CompanionRemoteState | null | undefined>(() =>
    desktopApi()?.companionRemote ? undefined : null,
  );

  useEffect(() => {
    const api = desktopApi();
    if (!api?.companionRemote) return;
    let alive = true;
    void api
      .companionRemote()
      .then((probe) => {
        if (alive) setRemote(probe ?? null);
      })
      .catch(() => {
        if (alive) setRemote(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const guard = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      toast.success(`${label} done`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <AppShell
      title="Devices"
      subtitle="Your phone by cable, Bluetooth and WiFi — plus FRIDAY on your phone"
      actions={
        <Button size="sm" variant="outline" disabled={state.busy} onClick={() => store.refresh()}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      }
    >
      {!state.supported && (
        <p className="mb-4 text-xs text-muted-foreground">
          Device control runs in the FRIDAY desktop app. In this preview nothing is connected, and
          FRIDAY will not invent devices that are not there.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Phone by cable" hint="USB debugging">
          <p className="mb-3 text-xs text-muted-foreground">
            FRIDAY never asks for your phone&apos;s PIN or pattern. Unlock the phone yourself and
            approve “Allow USB debugging from this computer” — that trust is what grants access, and
            you can revoke it on the phone at any time.
          </p>
          {state.androidNote && <p className="mb-3 text-xs text-warning">{state.androidNote}</p>}
          <ul className="space-y-3">
            {state.android.map((device) => (
              <li key={device.serial} className="rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Smartphone className="size-4" />
                  {device.model}
                  <Badge variant="outline" className="label-xs">
                    {device.state}
                  </Badge>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">{device.serial}</p>
                {device.hint && <p className="mt-1 text-xs text-warning">{device.hint}</p>}
                {device.authorized && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Input
                      value={app}
                      onChange={(event) => setApp(event.target.value)}
                      placeholder="App name or package"
                      className="h-8 w-52"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => guard("Open app", () => store.openApp(app, device.serial))}
                    >
                      <Cable className="size-4" />
                      Open
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => guard("Mirror", () => store.mirror(device.serial))}
                    >
                      <MonitorSmartphone className="size-4" />
                      Mirror screen
                    </Button>
                  </div>
                )}
              </li>
            ))}
            {!state.android.length && (
              <li className="text-xs text-muted-foreground">No phone connected by cable.</li>
            )}
          </ul>
        </Panel>

        <Panel title="Bluetooth" hint="paired by Windows">
          <div className="mb-3 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy}
              onClick={() => store.scanBluetooth()}
            >
              <Bluetooth className="size-4" />
              Scan nearby
            </Button>
            {["play", "pause", "next", "previous"].map((command) => (
              <Button
                key={command}
                size="sm"
                variant="ghost"
                onClick={() => guard(command, () => store.media(command))}
              >
                {command}
              </Button>
            ))}
          </div>
          {state.bluetoothNote && (
            <p className="mb-3 text-xs text-warning">{state.bluetoothNote}</p>
          )}
          <ul className="space-y-2">
            {state.bluetooth.map((device) => (
              <li key={device.address} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{device.name || device.address}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {device.address} · {device.kind}
                  </p>
                </div>
                <Badge variant="outline" className="label-xs">
                  {device.connected ? "connected" : "paired"}
                </Badge>
              </li>
            ))}
            {!state.bluetooth.length && (
              <li className="text-xs text-muted-foreground">No Bluetooth devices found yet.</li>
            )}
          </ul>
        </Panel>

        <Panel title="On this WiFi network" hint="discovery only">
          <div className="mb-3 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy}
              onClick={() => store.discoverNetwork()}
            >
              <Wifi className="size-4" />
              Discover devices
            </Button>
            <Input
              value={mediaUrl}
              onChange={(event) => setMediaUrl(event.target.value)}
              placeholder="Media URL to cast"
              className="h-8 flex-1"
            />
          </div>
          {state.networkNote && <p className="mb-3 text-xs text-warning">{state.networkNote}</p>}
          <ul className="space-y-2">
            {state.network.map((device) => (
              <li
                key={`${device.kind}-${device.address}-${device.name}`}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{device.name}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {device.address} · {device.kind}
                  </p>
                </div>
                {device.controlUrl && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      guard("Cast", () => store.cast(device.controlUrl as string, mediaUrl))
                    }
                  >
                    Cast
                  </Button>
                )}
              </li>
            ))}
            {!state.network.length && (
              <li className="text-xs text-muted-foreground">
                Nothing discovered yet. FRIDAY only lists devices that advertise themselves.
              </li>
            )}
          </ul>
        </Panel>

        <Panel title="Phone companion" hint="local network only">
          <p className="mb-3 text-xs text-muted-foreground">
            Open the address below on a phone that is on the same WiFi, enter the one-time code, and
            that phone can chat with FRIDAY and hear her reply. Nothing leaves your network — there
            is no internet relay.
          </p>
          {state.companion?.url ? (
            <p className="mb-3 font-mono text-sm">{state.companion.url}</p>
          ) : (
            <p className="mb-3 text-xs text-warning">
              {state.companion
                ? "Companion access is off. Enable it in Settings, then restart FRIDAY."
                : "Companion status is unavailable until the local service is running."}
            </p>
          )}
          {remote !== undefined ? (
            <div className="mb-3">
              <ToggleRow
                label="Also reach FRIDAY off this network (private device network)"
                on={Boolean(remote?.enabled)}
                onToggle={() => {
                  void guard("Off-network access", async () => {
                    const api = desktopApi();
                    if (!api?.setCompanionRemote) {
                      throw new Error(
                        "Off-LAN access is only available in the FRIDAY desktop app.",
                      );
                    }
                    const next = await api.setCompanionRemote(!remote?.enabled);
                    if (!next) {
                      throw new Error("FRIDAY did not return an off-LAN probe.");
                    }
                    setRemote(next);
                  });
                }}
              />
              <p className="mt-2 text-xs text-muted-foreground">{offLanStatusLine(remote)}</p>
            </div>
          ) : null}
          <div className="mb-3 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => guard("Pairing code", () => store.pair())}
            >
              <QrCode className="size-4" />
              New pairing code
            </Button>
            {state.pairing && (
              <span className="font-mono text-lg tracking-[0.3em]">{state.pairing.code}</span>
            )}
          </div>
          <ul className="space-y-2">
            {(state.companion?.phones || []).map((phone) => (
              <li key={phone.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{phone.name}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    paired {new Date(phone.pairedAt).toLocaleString()}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => store.revoke(phone.id)}>
                  Revoke
                </Button>
              </li>
            ))}
            {!state.companion?.phones?.length && (
              <li className="text-xs text-muted-foreground">No phone paired yet.</li>
            )}
          </ul>
        </Panel>
      </div>
    </AppShell>
  );
}
