import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { EditField, SelectField } from "@/components/friday/settings/fields";
import { landingDestinations, resolveLandingPath } from "@/lib/friday/navigation";
import { githubConfig, githubSetConfig, githubCheck } from "@/lib/friday/github-updates";
import { desktopApi } from "@/lib/friday/desktop";
import { DATE_FORMATS, LANGUAGES, TIME_FORMATS, TIMEZONES } from "@/lib/friday/settings-runtime";

type StartupBridge = {
  getStartWithWindows?: () => Promise<boolean>;
  setStartWithWindows?: (enabled: boolean) => Promise<boolean>;
};

/**
 * General settings — startup, locale, tray, updates, imports.
 */
export function GeneralSettings() {
  const navigate = useNavigate();
  const prefs = usePreferences();
  const isOn = (k: string) => prefs.toggles[k] === true;
  const flip = (k: string) => preferences.setToggle(k, !isOn(k));
  const field = (k: string) => prefs.fields[k] ?? "";
  const setField = (k: string) => (value: string) => preferences.setField(k, value);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");

  useEffect(() => {
    const api = desktopApi() as StartupBridge | null;
    if (!api?.getStartWithWindows) return;
    void api.getStartWithWindows().then((on) => {
      if (typeof on === "boolean") preferences.setToggle("startup", on);
    });
    void githubConfig().then((cfg) => {
      preferences.setToggle("updateCheck", Boolean(cfg.autoCheck));
      preferences.setToggle("autoUpdate", Boolean(cfg.autoApply));
      if (cfg.updateChannel) {
        preferences.setField("updateChannel", cfg.updateChannel === "test" ? "Test" : "Stable");
      }
    });
  }, []);

  const saveGithubToken = () => {
    const token = githubTokenDraft.trim();
    if (!token) return;
    void githubSetConfig({ token }).then((result) => {
      if (result.ok) {
        setGithubTokenDraft("");
        toast.success("GitHub token saved to the credential store");
        return;
      }
      toast.error(result.error || "Could not save GitHub token");
    });
  };

  const flipStartup = () => {
    const next = !isOn("startup");
    preferences.setToggle("startup", next);
    const api = desktopApi() as StartupBridge | null;
    if (!api?.setStartWithWindows) {
      toast.info("Start with Windows is applied by the FRIDAY desktop app");
      return;
    }
    void api.setStartWithWindows(next).then((on) => {
      if (typeof on === "boolean") preferences.setToggle("startup", on);
    });
  };

  const flipUpdateCheck = () => {
    const next = !isOn("updateCheck");
    preferences.setToggle("updateCheck", next);
    void githubSetConfig({ autoCheck: next }).then((result) => {
      if (!result.ok) toast.error(result.error || "Could not save update check");
    });
  };

  const flipAutoUpdate = () => {
    const next = !isOn("autoUpdate");
    preferences.setToggle("autoUpdate", next);
    void githubSetConfig({ autoApply: next }).then((result) => {
      if (!result.ok) toast.error(result.error || "Could not save auto-update");
      else if (next) {
        toast.info(
          "Packaged EXE still never silent-installs — auto-apply is for source updates only",
        );
      }
    });
  };

  const timezoneValue = (() => {
    const raw = field("timezone");
    const match = TIMEZONES.find((zone) => raw.includes(zone.value) || raw === zone.label);
    return match?.value ?? "Asia/Kolkata";
  })();

  return (
    <>
      <HudPanel title="General Settings">
        <ToggleRow
          label="Start Friday on system startup"
          on={isOn("startup")}
          onToggle={flipStartup}
        />
        <ToggleRow
          label="Launch minimized to the tray"
          on={isOn("launchMinimized")}
          onToggle={() => flip("launchMinimized")}
        />
        <p className="mb-2 text-[11px] text-muted-foreground">
          Needs Minimize to system tray. The tray icon still opens FRIDAY.
        </p>
        <ToggleRow
          label="Minimize to system tray"
          on={isOn("tray")}
          onToggle={() => flip("tray")}
        />
        <ToggleRow
          label="Run background services"
          on={isOn("background")}
          onToggle={() => flip("background")}
        />
        <ToggleRow label="Auto-update" on={isOn("autoUpdate")} onToggle={flipAutoUpdate} />
        <ToggleRow
          label="Check for updates on startup"
          on={isOn("updateCheck")}
          onToggle={flipUpdateCheck}
        />
        <ToggleRow
          label="Confirm before closing while tasks run"
          on={isOn("confirmExit")}
          onToggle={() => flip("confirmExit")}
        />
        <ToggleRow
          label="Desktop notifications"
          on={isOn("notifications")}
          onToggle={() => flip("notifications")}
        />
        <ToggleRow label="Sound effects" on={isOn("sounds")} onToggle={() => flip("sounds")} />
        <ToggleRow
          label="Write extra diagnostic breadcrumbs locally"
          on={isOn("telemetry")}
          onToggle={() => flip("telemetry")}
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Language"
            value={field("language") || "English"}
            options={LANGUAGES.map((item) => ({ value: item.value, label: item.label }))}
            onChange={setField("language")}
          />
          <SelectField
            label="Timezone"
            value={timezoneValue}
            options={TIMEZONES.map((item) => ({ value: item.value, label: item.label }))}
            onChange={(value) => {
              const zone = TIMEZONES.find((item) => item.value === value);
              preferences.setField("timezone", zone?.label ?? value);
            }}
          />
          <SelectField
            label="Date Format"
            value={
              DATE_FORMATS.includes(field("dateFormat") as (typeof DATE_FORMATS)[number])
                ? field("dateFormat")
                : "DD-MM-YYYY"
            }
            options={DATE_FORMATS.map((name) => ({ value: name, label: name }))}
            onChange={setField("dateFormat")}
          />
          <SelectField
            label="Time Format"
            value={
              TIME_FORMATS.includes(field("timeFormat") as (typeof TIME_FORMATS)[number])
                ? field("timeFormat")
                : "12 Hour"
            }
            options={TIME_FORMATS.map((name) => ({ value: name, label: name }))}
            onChange={setField("timeFormat")}
          />
          <SelectField
            label="Update channel"
            value={field("updateChannel") === "Test" ? "Test" : "Stable"}
            options={["Stable", "Test"].map((name) => ({ value: name, label: name }))}
            onChange={(value) => {
              preferences.setField("updateChannel", value);
              void githubSetConfig({ updateChannel: value === "Test" ? "test" : "stable" }).then(
                (result) => {
                  if (!result.ok) toast.error(result.error || "Could not save update channel");
                },
              );
            }}
          />
          <SelectField
            label="Default landing page"
            value={resolveLandingPath(field("landingPage"))}
            options={landingDestinations().map((item) => ({ value: item.to, label: item.label }))}
            onChange={setField("landingPage")}
          />
        </div>
      </HudPanel>

      <HudPanel title="Imports, GitHub & Builds">
        <ToggleRow
          label="Auto-scan imported folders and index them"
          on={isOn("autoIndex")}
          onToggle={() => flip("autoIndex")}
        />
        <ToggleRow
          label="Watch workspace files and rescan on change"
          on={isOn("repoWatch")}
          onToggle={() => flip("repoWatch")}
        />
        <ToggleRow
          label="Rebuild EXE + ZIP after a successful self-update"
          on={isOn("autoBuild")}
          onToggle={() => flip("autoBuild")}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Rebuilds stay on Friday Hub → Build &amp; Release. This switch records the owner
          preference; FRIDAY does not run NSIS by herself.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Default import target"
            value={field("importTarget") || "Workspace"}
            options={["Workspace", "Skills", "Tools", "Agents"].map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={setField("importTarget")}
          />
          <EditField
            label="Build output"
            value={field("buildOutput")}
            onChange={setField("buildOutput")}
          />
          <SelectField
            label="Archive format"
            value={field("archiveFormat") || "ZIP (all files)"}
            options={["ZIP (all files)", "TAR.GZ"].map((name) => ({ value: name, label: name }))}
            onChange={setField("archiveFormat")}
          />
          <EditField
            label="GitHub token"
            value={githubTokenDraft}
            onChange={setGithubTokenDraft}
            onBlur={saveGithubToken}
          />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate({ to: "/workspace" })}>
            <FolderOpen className="size-4" /> Manage folders →
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void githubCheck().then((result) => {
                if (result.ok) toast.success(result.label || "Update check finished");
                else toast.error(result.error || "Update check needs the desktop app");
              });
              void navigate({ to: "/settings", search: { section: "updates" } as never });
            }}
          >
            Check for updates now
          </Button>
        </div>
      </HudPanel>
    </>
  );
}
