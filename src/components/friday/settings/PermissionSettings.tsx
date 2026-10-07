import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { desktopApi } from "@/lib/friday/desktop";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { useWindowsSecurity } from "@/lib/friday/desktop";

type Decision = "allow" | "ask" | "deny";

type PolicyBridge = {
  toolPolicy?: () => Promise<{
    policy: Record<string, Decision>;
    defaults?: Record<string, Decision>;
  }>;
  setToolPolicy?: (
    name: string,
    decision: Decision | "default",
  ) => Promise<{
    policy: Record<string, Decision>;
  }>;
};

const NEXT: Record<Decision, Decision> = { allow: "ask", ask: "deny", deny: "allow" };

const TONE: Record<Decision, "accent" | "warning" | "destructive"> = {
  allow: "accent",
  ask: "warning",
  deny: "destructive",
};

/**
 * Owner permission policy. The table is the real per-tool policy stored by the
 * main process (`permissions:tool-policy`) and enforced by the tool authority
 * before any tool call reaches the kernel.
 */
export function PermissionSettings() {
  const prefs = usePreferences();
  const navigate = useNavigate();
  const { security, open: openSecurity, supported } = useWindowsSecurity();
  const [policy, setPolicy] = useState<Record<string, Decision>>({});
  const [defaults, setDefaults] = useState<Record<string, Decision>>({});
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const bridge = () => desktopApi() as unknown as PolicyBridge | null;

  const load = useCallback(async () => {
    const api = bridge();
    if (!api?.toolPolicy) return;
    setLoading(true);
    try {
      const result = await api.toolPolicy();
      setPolicy(result?.policy ?? {});
      setDefaults(result?.defaults ?? {});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = async (tool: string, decision: Decision | "default") => {
    const api = bridge();
    if (!api?.setToolPolicy) {
      toast.error("Tool permissions are enforced by the FRIDAY desktop app");
      return;
    }
    const result = await api.setToolPolicy(tool, decision);
    if (!result?.policy) {
      toast.error("Could not update tool policy");
      return;
    }
    setPolicy(result.policy);
    toast.success(`${tool} → ${decision}`);
  };

  const isOn = (k: string) => prefs.toggles[k] === true;
  const flip = (k: string) => preferences.setToggle(k, !isOn(k));
  const entries = Object.entries(policy);

  return (
    <div className="space-y-4">
      <HudPanel
        title="Tool Permissions"
        hint={desktopApi() ? "enforced by the tool authority" : "desktop app only"}
        actions={
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      >
        {entries.length ? (
          <ul className="space-y-2">
            {entries.map(([tool, decision]) => (
              <li
                key={tool}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border/60 pb-2 text-sm last:border-0"
              >
                <span className="truncate font-mono text-xs text-foreground">{tool}</span>
                <button type="button" onClick={() => void set(tool, NEXT[decision])}>
                  <StatusPill label={decision} tone={TONE[decision]} />
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => void set(tool, "default")}
                >
                  reset
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No per-tool overrides yet — every tool follows its risk default below.
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <Input
            value={name}
            placeholder="tool name, e.g. shell.run"
            onChange={(e) => setName(e.target.value)}
            className="h-8 border-primary/25 bg-surface font-mono text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!name.trim()}
            onClick={() => {
              void set(name.trim(), "ask").then(() => setName(""));
            }}
          >
            Add rule
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!entries.length}
            onClick={() => {
              void (async () => {
                const api = bridge();
                if (!api?.setToolPolicy) {
                  toast.error("Tool permissions are enforced by the FRIDAY desktop app");
                  return;
                }
                try {
                  for (const [tool] of entries) {
                    await api.setToolPolicy(tool, "default");
                  }
                  await load();
                  toast.success("Per-tool overrides reset to risk defaults");
                } catch (error) {
                  await load();
                  toast.error(
                    `Could not reset overrides — ${String((error as Error).message ?? error)}`,
                  );
                }
              })();
            }}
          >
            Reset all overrides
          </Button>
        </div>

        {Object.keys(defaults).length ? (
          <div className="mt-4">
            <p className="label-xs text-muted-foreground">Risk defaults</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(defaults).map(([risk, decision]) => (
                <span key={risk} className="font-mono text-[11px] text-muted-foreground">
                  {risk} → <span className="text-primary">{decision}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </HudPanel>

      <HudPanel title="Approval Behaviour">
        <ToggleRow
          label="Auto-approve safe (read-only) tools"
          on={isOn("safeTools")}
          onToggle={() => flip("safeTools")}
        />
        <ToggleRow
          label="Auto-approve file writes inside the workspace"
          on={isOn("workspaceWrites")}
          onToggle={() => flip("workspaceWrites")}
        />
        <ToggleRow
          label="Always ask before shell execution"
          on={isOn("execApproval")}
          onToggle={() => flip("execApproval")}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Write and exec tools always ask — owner rules cannot auto-approve them. Turning safe tools
          off makes even read-only tools ask.
        </p>
        <ToggleRow
          label="Always ask before network installs and downloads"
          on={isOn("installApproval")}
          onToggle={() => flip("installApproval")}
        />
        <ToggleRow
          label="Always ask before controlling the PC (mouse, keyboard, windows)"
          on={isOn("pcControlApproval")}
          onToggle={() => flip("pcControlApproval")}
        />
        <ToggleRow
          label="Write lessons to memory after failures"
          on={isOn("lessons")}
          onToggle={() => flip("lessons")}
        />
        <Button
          size="sm"
          variant="outline"
          className="mt-4"
          onClick={() => void navigate({ to: "/tools" })}
        >
          <SlidersHorizontal className="size-4" /> Open tool manager
        </Button>
      </HudPanel>

      <HudPanel
        title="Windows Security"
        hint={supported ? "read from this machine" : "desktop app only"}
      >
        {security ? (
          <ul className="space-y-2">
            {(
              Object.entries(security as Record<string, unknown>).filter(
                ([, value]) => typeof value === "string" || typeof value === "boolean",
              ) as [string, string | boolean][]
            ).map(([key, value]) => (
              <li
                key={key}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 pb-2 text-sm last:border-0"
              >
                <span className="truncate text-muted-foreground">{key}</span>
                <StatusPill
                  label={typeof value === "boolean" ? (value ? "on" : "off") : String(value)}
                  tone={value === false ? "warning" : "accent"}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Security state is reported by the FRIDAY desktop app.
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          className="mt-4"
          onClick={() => {
            if (supported) {
              openSecurity();
              return;
            }
            window.open(
              "https://support.microsoft.com/windows/stay-protected-with-windows-security",
              "_blank",
              "noopener",
            );
          }}
        >
          <ShieldCheck className="size-4" /> Open Windows Security
        </Button>
      </HudPanel>
    </div>
  );
}
