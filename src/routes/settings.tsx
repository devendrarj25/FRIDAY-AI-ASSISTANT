import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import {
  Brain,
  HardDriveDownload,
  Lock,
  Palette,
  Save,
  ShieldCheck,
  Mic,
  Activity,
  Bell,
  Bot,
  Sliders,
  Sparkles,
  Terminal,
} from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { HudPanel } from "@/components/friday/ui";
import { preferences } from "@/lib/friday/preferences";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CompanionSettings } from "@/components/friday/character/CompanionSettings";
import { AutonomySettings } from "@/components/friday/settings/AutonomySettings";
import { GeneralSettings } from "@/components/friday/settings/GeneralSettings";
import { AISettings } from "@/components/friday/settings/AISettings";
import { MemorySettings } from "@/components/friday/settings/MemorySettings";
import { NotificationSettings } from "@/components/friday/settings/NotificationSettings";
import { PermissionSettings } from "@/components/friday/settings/PermissionSettings";
import { SystemSettings } from "@/components/friday/settings/SystemSettings";
import { GithubUpdates } from "@/components/friday/settings/GithubUpdates";
import { AppearanceSettings } from "@/components/friday/settings/AppearanceSettings";
import { VoiceSettings } from "@/components/friday/settings/VoiceSettings";
import { SecuritySettings } from "@/components/friday/settings/SecuritySettings";
import { BackupSettings } from "@/components/friday/settings/BackupSettings";
import { AdvancedSettings } from "@/components/friday/settings/AdvancedSettings";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — FRIDAY Console" },
      {
        name: "description",
        content:
          "Configure FRIDAY: appearance and accent colors, AI routing, memory limits, permissions, security, folders and backups.",
      },
      { property: "og:title", content: "Settings — FRIDAY Console" },
      {
        property: "og:description",
        content: "Appearance, AI, memory, permissions, security and folder settings.",
      },
    ],
  }),
  component: SettingsPage,
});

const SECTIONS = [
  { key: "general", label: "General", icon: Sliders },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "ai", label: "AI Settings", icon: Brain },
  { key: "autonomy", label: "Autonomy", icon: Bot },
  { key: "voice", label: "Voice", icon: Mic },
  { key: "companion", label: "Companion", icon: Sparkles },
  { key: "memory", label: "Memory", icon: HardDriveDownload },
  { key: "permissions", label: "Permissions", icon: ShieldCheck },
  { key: "security", label: "Security", icon: Lock },
  { key: "performance", label: "Performance", icon: Activity },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "updates", label: "Updates", icon: HardDriveDownload },
  { key: "backup", label: "Backup & Restore", icon: Save },
  { key: "advanced", label: "Advanced", icon: Terminal },
] as const;

function SettingsPage() {
  const navigate = useNavigate();
  const sectionParam = useRouterState({
    select: (s) => {
      const raw = s.location.search;
      if (typeof raw === "string") return new URLSearchParams(raw).get("section") ?? undefined;
      const section = (raw as { section?: unknown }).section;
      return typeof section === "string" ? section : undefined;
    },
  });
  const requested =
    sectionParam && SECTIONS.some((s) => s.key === sectionParam) ? sectionParam : "";
  const [section, setSection] = useState<string>(requested || "general");
  const [seenSection, setSeenSection] = useState(requested);
  if (requested && seenSection !== requested) {
    setSeenSection(requested);
    setSection(requested);
  }

  return (
    <AppShell
      title="Settings"
      subtitle="Every knob FRIDAY exposes — stored locally"
      actions={
        <Button
          size="sm"
          onClick={() => {
            void preferences.flush().then(() => toast.success("Settings saved"));
          }}
        >
          <Save className="size-4" /> Save
        </Button>
      }
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <HudPanel title="Settings" bodyClassName="max-h-[min(70vh,40rem)] overflow-y-auto p-2">
          <nav className="space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setSection(s.key);
                  void navigate({
                    to: "/settings",
                    search: { section: s.key } as never,
                  });
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm border px-2.5 py-2 text-left text-sm transition-colors",
                  section === s.key
                    ? "border-primary/50 bg-primary/12 text-primary"
                    : "border-transparent text-muted-foreground hover:border-primary/25 hover:text-foreground",
                )}
              >
                <s.icon className="size-4 shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
          </nav>
        </HudPanel>

        <div className="space-y-4">
          {section === "general" ? <GeneralSettings /> : null}
          {section === "appearance" ? <AppearanceSettings /> : null}
          {section === "ai" ? <AISettings /> : null}
          {section === "voice" ? <VoiceSettings /> : null}
          {section === "companion" ? <CompanionSettings /> : null}
          {section === "autonomy" ? <AutonomySettings /> : null}
          {section === "performance" ? <SystemSettings /> : null}
          {section === "notifications" ? <NotificationSettings /> : null}
          {section === "updates" ? <GithubUpdates /> : null}
          {section === "memory" ? <MemorySettings /> : null}
          {section === "permissions" ? <PermissionSettings /> : null}
          {section === "security" ? <SecuritySettings /> : null}
          {section === "backup" ? <BackupSettings /> : null}
          {section === "advanced" ? <AdvancedSettings /> : null}
        </div>
      </div>
    </AppShell>
  );
}
