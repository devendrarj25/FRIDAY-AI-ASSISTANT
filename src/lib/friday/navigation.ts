/**
 * FRIDAY · one navigation / feature registry
 *
 * This is the single source of truth for "what sections FRIDAY has". The
 * desktop sidebar (AppShell) renders from it, and the phone companion builds
 * its menu from the very same list, exactly like the model list is kept in one
 * place and read by every selector.
 *
 * STANDING RULE: adding a new capability means adding ONE entry here. The
 * companion picks it up automatically — never hardcode a section in the
 * companion HTML.
 */
import {
  Activity,
  Blocks,
  Bot,
  Boxes,
  Brain,
  Briefcase,
  Cpu,
  Database,
  FlaskConical,
  FolderTree,
  Gauge,
  Globe,
  HardDriveDownload,
  Library,
  Link2,
  ListChecks,
  PackagePlus,
  Plug,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Stethoscope,
  Users,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import { Github } from "@/components/friday/icons/github";
import type { LucideIcon } from "lucide-react";
import type { FileRouteTypes } from "@/routeTree.gen";

export type NavPath = FileRouteTypes["fullPaths"];
export type NavItem = { to: NavPath; label: string; icon: LucideIcon };

export const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Core",
    items: [
      { to: "/", label: "Friday (Main Window)", icon: Bot },
      { to: "/brain", label: "Brain", icon: Brain },
      { to: "/memory", label: "Memory", icon: Database },
      { to: "/library", label: "Library", icon: Library },
      { to: "/self-management", label: "Self-Management", icon: ShieldCheck },
      { to: "/status", label: "FRIDAY Status", icon: Gauge },
      { to: "/system", label: "Hardware", icon: Cpu },
    ],
  },
  {
    group: "Capabilities",
    items: [
      { to: "/skills", label: "Skills", icon: Sparkles },
      { to: "/plugins", label: "Plugins", icon: Plug },
      { to: "/modules", label: "Modules", icon: Blocks },
      { to: "/agents", label: "Agents", icon: Users },
      { to: "/workflows", label: "Workflows", icon: Workflow },
      { to: "/models", label: "Models", icon: Boxes },
      { to: "/tools", label: "Tools", icon: Wrench },
    ],
  },
  {
    group: "Connectivity",
    items: [
      { to: "/browser", label: "FRIDAY Browser", icon: Globe },
      { to: "/connectors", label: "Connectors", icon: Link2 },
      { to: "/devices", label: "Devices", icon: Smartphone },
      { to: "/n8n", label: "n8n Automation", icon: Zap },
    ],
  },
  {
    group: "Operations",
    items: [
      { to: "/hub", label: "Friday Hub", icon: PackagePlus },
      { to: "/import", label: "Import & Build", icon: Github },
      { to: "/doctor", label: "Setup & Doctor", icon: Stethoscope },
      { to: "/install-manager", label: "Install Manager", icon: HardDriveDownload },
      { to: "/tasks", label: "Tasks", icon: ListChecks },
      { to: "/projects", label: "Projects & Workspaces", icon: Briefcase },
      { to: "/workspace", label: "Folders", icon: FolderTree },
      { to: "/sandbox", label: "Sandbox", icon: FlaskConical },
      { to: "/terminal", label: "Terminal", icon: SquareTerminal },
      { to: "/logs", label: "Logs", icon: Activity },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

/** Settings lives in the shell footer, not the grouped sidebar list. */
export const SETTINGS_NAV: NavItem = { to: "/settings", label: "Settings", icon: Settings };

/** Fired when Appearance → Sidebar default writes localStorage so the shell applies it. */
export const SIDEBAR_PREF_EVENT = "friday-sidebar-pref";

export type LandingPath = NavPath;

export function navLabel(to: string): string {
  if (to === SETTINGS_NAV.to) return SETTINGS_NAV.label;
  return ALL_NAV_ITEMS.find((item) => item.to === to)?.label ?? to;
}

export function resolveLandingPath(value: string | undefined | null): LandingPath {
  const raw = (value ?? "").trim();
  if (!raw) return "/";
  if (raw === SETTINGS_NAV.to || raw === SETTINGS_NAV.label) return SETTINGS_NAV.to;
  const byPath = ALL_NAV_ITEMS.find((item) => item.to === raw);
  if (byPath) return byPath.to;
  const byLabel = ALL_NAV_ITEMS.find((item) => item.label === raw);
  if (byLabel) return byLabel.to;
  return "/";
}

export function landingDestinations(): { to: LandingPath; label: string }[] {
  return [
    ...ALL_NAV_ITEMS.map((item) => ({ to: item.to as LandingPath, label: item.label })),
    { to: SETTINGS_NAV.to, label: SETTINGS_NAV.label },
  ];
}

/** Capability pages that accept file / folder / GitHub imports. */
export const IMPORT_TARGET_PATHS = [
  "/skills",
  "/plugins",
  "/modules",
  "/agents",
  "/workflows",
  "/models",
  "/tools",
  "/workspace",
  "/brain",
  "/memory",
] as const satisfies readonly NavPath[];

export function importTargetLabel(path: string): string | undefined {
  return IMPORT_TARGET_PATHS.includes(path as (typeof IMPORT_TARGET_PATHS)[number])
    ? navLabel(path)
    : undefined;
}

/** Serializable feature descriptor the companion (and anything else) reads. */
export type CompanionFeature = {
  id: string;
  label: string;
  group: string;
  /** Kernel method that produces a live read for this section, when one exists. */
  read: string | null;
  /** Field of the kernel result that holds the list, when it is a list. */
  field: string | null;
  /** Free-text fallback: FRIDAY answers about the section in chat. */
  prompt: string;
};

/**
 * Sections that already have a real kernel read. Anything NOT listed still
 * shows up on the phone — it simply falls back to asking FRIDAY through the
 * same chat pipeline, so a brand-new feature is never missing from the phone.
 */
const KERNEL_READS: Record<string, { read: string; field: string }> = {
  "/models": { read: "model.list", field: "models" },
  "/tools": { read: "tool.list", field: "tools" },
  "/modules": { read: "module.list", field: "modules" },
  "/tasks": { read: "task.list", field: "tasks" },
  "/status": { read: "kernel.status", field: "" },
  "/memory": { read: "memory.status", field: "" },
  "/workspace": { read: "workspace.get", field: "" },
  "/install-manager": { read: "runtime.list", field: "runtimes" },
  "/devices": { read: "companion.status", field: "phones" },
  "/settings": { read: "settings.get", field: "" },
};

/** Build the phone-facing feature list from the same nav registry. */
export function companionFeatures(): CompanionFeature[] {
  const items: { item: NavItem; group: string }[] = ALL_NAV_ITEMS.map((item) => ({
    item,
    group: NAV_GROUPS.find((g) => g.items.includes(item))?.group || "Core",
  }));
  items.push({ item: SETTINGS_NAV, group: "Core" });
  return items.map(({ item, group }) => {
    const mapped = KERNEL_READS[item.to];
    return {
      id: item.to,
      label: item.label,
      group,
      read: mapped?.read ?? null,
      field: mapped?.field || null,
      prompt: `Give me a short status of FRIDAY's "${item.label}" section and what I can do there right now.`,
    };
  });
}

export const SETTINGS_ICON = Settings;
