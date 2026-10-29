import { afterEach, describe, expect, it } from "vitest";
import { preferences, DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import { considerMemory } from "../../src/lib/friday/brain/memory-policy";
import { identity } from "../../src/lib/friday/brain/identity";
import {
  coerceMemoryTier,
  formatOwnerDate,
  notificationAllowed,
  prefOn,
  shouldRememberChats,
  alertsAudible,
  inQuietHours,
  SETTINGS_BACKUP_KIND,
} from "../../src/lib/friday/settings-runtime";

afterEach(() => {
  preferences.setToggle("rememberChats", true);
  preferences.setToggle("longTerm", true);
  preferences.setToggle("notifyHealth", true);
  preferences.setToggle("doNotDisturb", false);
  preferences.setToggle("quietHours", false);
  preferences.setField("personality", DEFAULT_PREFERENCES.fields["personality"] ?? "");
  preferences.setField("timezone", DEFAULT_PREFERENCES.fields["timezone"] ?? "");
  preferences.setField("dateFormat", DEFAULT_PREFERENCES.fields["dateFormat"] ?? "");
  preferences.setField("timeFormat", DEFAULT_PREFERENCES.fields["timeFormat"] ?? "");
});

describe("settings runtime", () => {
  it("defaults conversation memory on so existing installs keep storing", () => {
    expect(DEFAULT_PREFERENCES.toggles["rememberChats"]).toBe(true);
    expect(shouldRememberChats()).toBe(true);
  });

  it("pauses considerMemory when rememberChats is off", () => {
    preferences.setToggle("rememberChats", false);
    const verdict = considerMemory({
      text: "always use local models for coding work on this desk",
      ok: true,
    });
    expect(verdict.keep).toBe(false);
    expect(verdict.reason).toMatch(/paused/i);
    preferences.setToggle("rememberChats", true);
    expect(
      considerMemory({
        text: "always use local models for coding work on this desk",
        ok: true,
      }).keep,
    ).toBe(true);
  });

  it("coerces long-term tiers to temporary when longTerm is off", () => {
    preferences.setToggle("longTerm", false);
    expect(coerceMemoryTier("permanent")).toBe("temporary");
    expect(coerceMemoryTier("working")).toBe("working");
    preferences.setToggle("longTerm", true);
    expect(coerceMemoryTier("permanent")).toBe("permanent");
  });

  it("filters notification categories from the owner toggles", () => {
    preferences.setToggle("notifyHealth", false);
    expect(notificationAllowed("Doctor", "warn")).toBe(false);
    expect(notificationAllowed("Network", "info")).toBe(true);
    preferences.setToggle("notifyHealth", true);
  });

  it("formats dates with the General timezone and format fields", () => {
    preferences.setField("timezone", "(UTC+05:30) Asia/Kolkata");
    preferences.setField("dateFormat", "DD-MM-YYYY");
    preferences.setField("timeFormat", "24 Hour");
    const stamp = formatOwnerDate(Date.parse("2026-09-07T12:00:00.000Z"));
    expect(stamp).toMatch(/07-09-2026/);
  });

  it("compiles personality notes into the identity prompt", () => {
    preferences.setField("personality", "Never mention the weather.");
    const prompt = identity.compile();
    expect(prompt).toContain("Never mention the weather.");
  });

  it("reads unset toggles from shipped defaults", () => {
    expect(prefOn("execApproval", false)).toBe(true);
  });

  it("mutes audible alerts during do-not-disturb without dropping the hub record", () => {
    preferences.setToggle("doNotDisturb", true);
    expect(alertsAudible()).toBe(false);
    expect(notificationAllowed("Network", "info")).toBe(true);
    preferences.setToggle("doNotDisturb", false);
    expect(alertsAudible()).toBe(true);
  });

  it("treats overnight quiet hours as wrapping midnight in the owner timezone", () => {
    preferences.setToggle("quietHours", true);
    preferences.setField("timezone", "UTC");
    preferences.setField("quietStart", "22:00");
    preferences.setField("quietEnd", "07:00");
    expect(inQuietHours(Date.parse("2026-09-07T23:00:00.000Z"))).toBe(true);
    expect(inQuietHours(Date.parse("2026-09-07T12:00:00.000Z"))).toBe(false);
    preferences.setToggle("quietHours", false);
  });

  it("exports a combined backup kind the Backup panel round-trips", () => {
    expect(SETTINGS_BACKUP_KIND).toBe("friday-settings-backup");
  });
});
