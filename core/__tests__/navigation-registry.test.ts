/**
 * Navigation registry: one list drives the sidebar, mobile strip, companion
 * and landing-page picker. Paths stay stable; labels may be corrected.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_NAV_ITEMS,
  NAV_GROUPS,
  SETTINGS_NAV,
  companionFeatures,
  importTargetLabel,
  resolveLandingPath,
  landingDestinations,
} from "../../src/lib/friday/navigation";

const REQUIRED_PATHS = [
  "/",
  "/brain",
  "/memory",
  "/library",
  "/self-management",
  "/status",
  "/system",
  "/skills",
  "/plugins",
  "/modules",
  "/agents",
  "/workflows",
  "/models",
  "/tools",
  "/browser",
  "/connectors",
  "/devices",
  "/hub",
  "/import",
  "/n8n",
  "/doctor",
  "/install-manager",
  "/tasks",
  "/projects",
  "/workspace",
  "/sandbox",
  "/terminal",
  "/logs",
];

describe("navigation registry", () => {
  it("keeps every previous sidebar destination reachable", () => {
    const paths = new Set(ALL_NAV_ITEMS.map((item) => item.to));
    for (const path of REQUIRED_PATHS) {
      expect(paths.has(path as (typeof ALL_NAV_ITEMS)[number]["to"]), path).toBe(true);
    }
  });

  it("gives Brain, Memory, FRIDAY Status and Hardware distinct accurate names", () => {
    const byPath = new Map(ALL_NAV_ITEMS.map((item) => [item.to, item.label]));
    expect(byPath.get("/brain")).toBe("Brain");
    expect(byPath.get("/memory")).toBe("Memory");
    expect(byPath.get("/library")).toBe("Library");
    expect(byPath.get("/projects")).toBe("Projects & Workspaces");
    expect(byPath.get("/status")).toBe("FRIDAY Status");
    expect(byPath.get("/system")).toBe("Hardware");
    const labels = ALL_NAV_ITEMS.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has unique paths and publishes companion groups from the same registry", () => {
    const paths = ALL_NAV_ITEMS.map((item) => item.to);
    expect(new Set(paths).size).toBe(paths.length);
    const groups = NAV_GROUPS.map((g) => g.group);
    expect(groups).toEqual(["Core", "Capabilities", "Connectivity", "Operations"]);
    const features = companionFeatures();
    expect(features.some((f) => f.id === "/memory")).toBe(true);
    expect(features.some((f) => f.id === SETTINGS_NAV.to)).toBe(true);
    expect(features.some((f) => f.id === "/")).toBe(true);
    expect(features.some((f) => f.id === "/logs" && f.read === "chat.sessions")).toBe(false);
    const featureIds = new Set(features.map((f) => f.id));
    for (const item of ALL_NAV_ITEMS) {
      expect(featureIds.has(item.to), item.to).toBe(true);
    }
    expect(features).toHaveLength(ALL_NAV_ITEMS.length + 1);
    for (const feature of features) {
      expect(groups).toContain(feature.group);
    }
  });

  it("resolves landing pages and import targets from the same registry", () => {
    expect(resolveLandingPath("Friday (Main Window)")).toBe("/");
    expect(resolveLandingPath("/models")).toBe("/models");
    expect(resolveLandingPath("Memory")).toBe("/memory");
    expect(resolveLandingPath("Settings")).toBe("/settings");
    expect(resolveLandingPath("not-a-page")).toBe("/");
    expect(importTargetLabel("/brain")).toBe("Brain");
    expect(importTargetLabel("/memory")).toBe("Memory");
    expect(landingDestinations().some((d) => d.to === "/settings")).toBe(true);
  });
});
