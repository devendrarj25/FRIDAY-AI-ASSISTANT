/**
 * Extra wire shapes for the FRIDAY HUD sections (skills, plugins, agents,
 * workflows, installations, hardware). Same contract the local kernel emits.
 */

export type ActivityState = "Active" | "Ready" | "Idle" | "Learning" | "Inactive" | "Offline";

export type Skill = {
  name: string;
  category: string;
  status: ActivityState;
  level: "Basic" | "Intermediate" | "Advanced" | "Expert";
  lastUsed: string;
};

export type Plugin = {
  name: string;
  kind: "Core" | "Custom";
  version: string;
  status: ActivityState;
  latest: string;
};

export type Agent = {
  name: string;
  role: string;
  status: ActivityState;
  tasks: number;
  activity: "High" | "Medium" | "Low";
};

export type Workflow = {
  name: string;
  status: "Running" | "Completed" | "Scheduled" | "Failed";
  lastRun: string;
  nextRun: string;
};

export type Installation = {
  pkg: string;
  installed: string | null;
  latest: string;
  status: "Up to date" | "Update available" | "Not installed";
};

export type ActivityEvent = {
  at: string;
  source: string;
  detail: string;
  tone: "primary" | "accent" | "warning" | "magenta" | "muted";
};

export type ComponentHealth = {
  name: string;
  status: "Active" | "Loaded" | "Online" | "Running" | "Optimal" | "Degraded";
  details: string;
  uptime: string;
};

export type HardwareStat = {
  label: string;
  value: number;
  detail: string;
  tone: "primary" | "accent" | "warning" | "magenta";
};

export type FolderEntry = {
  name: string;
  path: string;
  files: number;
  size: string;
};

export type PermissionEntry = {
  label: string;
  mode: "Allowed" | "Ask" | "Blocked";
};

export type Overview = {
  label: string;
  value: number | string;
  state: string;
  icon: string;
};
