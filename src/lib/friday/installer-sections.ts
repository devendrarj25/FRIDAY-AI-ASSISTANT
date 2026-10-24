/**
 * The Install Manager's sections. Each panel on the page belongs to exactly one,
 * so nothing is hidden and nothing is shown twice. The counts are live.
 */
export const INSTALL_SECTIONS = [
  { key: "software", label: "Software" },
  { key: "queue", label: "Queue & Updates" },
  { key: "services", label: "Services" },
  { key: "health", label: "Health & Maintenance" },
  { key: "activity", label: "Activity" },
  { key: "ask", label: "Ask FRIDAY" },
] as const;

export type InstallSection = (typeof INSTALL_SECTIONS)[number]["key"];

/** Which section every panel title lives under (kept in step with the page by a test). */
export const PANEL_SECTIONS: Record<string, InstallSection | "always"> = {
  // Above the section tabs, so the counts are in view whichever section is open.
  "Environment Summary": "always",
  "Software Catalog": "software",
  "Package details": "software",
  "Install Queue": "queue",
  "Update Manager": "queue",
  "Background services": "services",
  "Coverage by Category": "health",
  "Installer Capabilities": "health",
  Maintenance: "health",
  "Installer Log": "activity",
  "Install History": "activity",
  "Ask FRIDAY": "ask",
};
