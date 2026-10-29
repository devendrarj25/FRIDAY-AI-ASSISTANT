/**
 * FRIDAY · live Projects & Workspaces session (renderer)
 *
 * One snapshot so Chat, Auto Mode, and Core Brain see the same active project
 * the owner is looking at. Durable store: electron/project-workspaces.cjs.
 */

import { projectWorkspaces, type ProjectWorkspace } from "./project-workspace-engine";
import { formatProjectWorkspaceExtra } from "./project-workspace-logic";

export type ProjectWorkspaceSession = {
  desktop: boolean;
  dir: string;
  items: ProjectWorkspace[];
  activeId: string | null;
  tab: string;
};

const empty = (): ProjectWorkspaceSession => ({
  desktop: false,
  dir: "",
  items: [],
  activeId: null,
  tab: "overview",
});

let session: ProjectWorkspaceSession = empty();
let asker: ((prompt: string) => void) | null = null;

export function projectWorkspaceSnapshot(): ProjectWorkspaceSession {
  return session;
}

export function publishProjectWorkspaceSession(
  patch: Partial<ProjectWorkspaceSession>,
): ProjectWorkspaceSession {
  session = {
    ...session,
    ...patch,
    items: patch.items ? patch.items.slice(0, 200) : session.items,
  };
  return session;
}

export function registerProjectWorkspaceAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestProjectWorkspaceAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function formatProjectExtra(maxChars = 8000): string {
  const snap = session.items.length ? session : { ...session, items: projectWorkspaces.list() };
  const active =
    snap.items.find((item) => item.id === (snap.activeId || projectWorkspaces.activeId())) ||
    projectWorkspaces.active();
  return formatProjectWorkspaceExtra(active, maxChars);
}

export { formatProjectWorkspaceExtra };
