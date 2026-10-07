import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderOpen, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { EditField, Field } from "@/components/friday/settings/fields";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { desktopApi, revealWorkspaceFolder, useWorkspaceRootState } from "@/lib/friday/desktop";
import { useKernelStatus } from "@/lib/friday/use-kernel-status";
import { doctor } from "@/lib/friday/doctor-engine";
type EncryptionBridge = {
  encryptionStatus?: () => Promise<{ available: boolean } | null>;
};

export function SecuritySettings() {
  const prefs = usePreferences();
  const kernelStatus = useKernelStatus();
  const workspaceRoot = useWorkspaceRootState();
  const [busy, setBusy] = useState(false);
  const [encryption, setEncryption] = useState<{ available: boolean } | null>(null);
  const isOn = (k: string) => prefs.toggles[k] === true;
  const flip = (k: string) => preferences.setToggle(k, !isOn(k));
  const field = (k: string) => prefs.fields[k] ?? "";

  useEffect(() => {
    const api = desktopApi() as EncryptionBridge | null;
    if (!api?.encryptionStatus) return;
    void api.encryptionStatus().then((state) => setEncryption(state ?? { available: false }));
  }, []);

  return (
    <HudPanel title="Friday Security">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill
          label={
            encryption == null
              ? "encryption: desktop app"
              : encryption.available
                ? "OS encryption available"
                : "OS encryption unavailable"
          }
          tone={encryption?.available ? "accent" : "warning"}
        />
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Secrets are always stored with Electron safeStorage when this PC provides it. The toggle
        below does not turn OS encryption off — it refuses to keep new secrets if encryption is
        missing.
      </p>
      <ToggleRow
        label="Refuse new secrets when OS encryption is unavailable"
        on={isOn("encryption")}
        onToggle={() => flip("encryption")}
      />
      <p className="mb-2 text-[11px] text-muted-foreground">
        Outbound calls always use TLS. FRIDAY will not send secrets over plain HTTP.
      </p>
      <ToggleRow
        label="Windows Hello / biometric unlock"
        on={isOn("biometric")}
        onToggle={() => {
          toast.info(
            "Windows Hello is not wired on this build. Use session lock below to cover the console when idle.",
          );
          flip("biometric");
        }}
      />
      <ToggleRow
        label="Lock FRIDAY after the session timeout"
        on={isOn("autoLock")}
        onToggle={() => flip("autoLock")}
      />
      <ToggleRow
        label="Mask API keys and tokens in the UI"
        on={isOn("maskSecrets")}
        onToggle={() => flip("maskSecrets")}
      />
      <ToggleRow
        label="Block outbound requests to unapproved hosts"
        on={isOn("blockUnknownHosts")}
        onToggle={() => flip("blockUnknownHosts")}
      />
      <p className="mt-1 text-[11px] text-muted-foreground">
        Off keeps the two-tier privacy firewall (sensitive always stops; connected providers send
        ordinary chat). On, destinations that are not already connected are denied instead of asked.
      </p>
      <ToggleRow
        label="Keep an audit log of every tool call"
        on={isOn("auditLog")}
        onToggle={() => flip("auditLog")}
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <EditField
          label="Session timeout (minutes)"
          value={field("sessionTimeout") || "30"}
          onChange={(value) => preferences.setField("sessionTimeout", value.replace(/[^\d]/g, ""))}
        />
        <Field label="Kernel bridge" value={kernelStatus.host} />
        <Field label="Workspace root" value={workspaceRoot || "unknown"} />
        <Field label="Data directory" value={kernelStatus.dataDir} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.dispatchEvent(new Event("friday.session-lock"))}
        >
          Lock now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void doctor
              .scan({ deep: true })
              .then(() => {
                const checks = doctor.getSnapshot().checks ?? [];
                const bad = checks.filter(
                  (c) => c.status !== "Ready" && c.status !== "Running",
                ).length;
                toast.success(bad ? `${bad} check(s) need attention` : "All checks passed");
              })
              .catch((error) =>
                toast.error(`Security check failed — ${String((error as Error).message ?? error)}`),
              )
              .finally(() => setBusy(false));
          }}
        >
          <ShieldCheck className="size-4" /> Run security check
        </Button>
        <Button size="sm" variant="outline" onClick={() => revealWorkspaceFolder("logs")}>
          <FolderOpen className="size-4" /> Open audit logs
        </Button>
      </div>
    </HudPanel>
  );
}
