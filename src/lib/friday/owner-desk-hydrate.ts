/**
 * FRIDAY · owner desk hydrate (Library + Projects)
 *
 * One boot pull so Chat, Voice, Auto, companion, and Core Brain see the same
 * disk index the sections use. AppShell calls this once — pages must not add
 * their own poll loops.
 */

import { isDesktopApp } from "./desktop";
import { library } from "./library-engine";
import { publishLibrarySession } from "./library-awareness";
import { projectWorkspaces } from "./project-workspace-engine";
import { publishProjectWorkspaceSession } from "./project-workspace-awareness";

export async function hydrateOwnerDesk(): Promise<void> {
  const desktop = isDesktopApp();
  await Promise.all([library.refreshFromDesktop(), projectWorkspaces.refreshFromDesktop()]);
  for (const item of projectWorkspaces.list()) {
    projectWorkspaces.refreshLibrarySources(item.id);
  }
  const libItems = library.list();
  publishLibrarySession({
    desktop,
    dir: library.dirPath(),
    items: libItems,
    pinned: libItems.filter((item) => item.pinnedForAuto).map((item) => item.id),
    selectedId: null,
  });
  publishProjectWorkspaceSession({
    desktop,
    dir: projectWorkspaces.dirPath(),
    items: projectWorkspaces.list(true),
    activeId: projectWorkspaces.activeId(),
    tab: "overview",
  });
}

/** Coarse companion subtitle. Empty when the desks are idle so "healthy" stays exact. */
export function formatOwnerDeskLine(): string {
  const items = library.list();
  const pins = items.filter((item) => item.pinnedForAuto).length;
  const active = projectWorkspaces.active();
  const bits: string[] = [];
  if (items.length) bits.push(`library ${items.length}${pins ? ` (${pins} pin)` : ""}`);
  if (active) {
    const lock = active.handsOffAuto || active.preferences.handsOffAuto ? " hands-off" : "";
    bits.push(`project ${active.name}${lock}`);
  }
  return bits.join(" · ");
}
