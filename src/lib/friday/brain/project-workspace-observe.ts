/**
 * FRIDAY · read-only project workspace observation
 *
 * Core Brain / Auto Mode read the live project snapshot. They never open a
 * second store. Write/exec still goes through tool-authority + handsOffAuto.
 */

import {
  formatProjectExtra,
  projectWorkspaceSnapshot,
  type ProjectWorkspaceSession,
} from "../project-workspace-awareness";
import { projectWorkspaces } from "../project-workspace-engine";
import { looksLikeProjectAsk } from "../project-workspace-logic";

export function projectLookRequested(text: string): boolean {
  return looksLikeProjectAsk(String(text || ""), projectWorkspaces.list());
}

export function shouldAttachProjectExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (projectLookRequested(text)) return true;
  if (/\bPROJECT WORKSPACE SESSION\b/.test(text)) return true;
  return Boolean(projectWorkspaces.active());
}

export type ProjectWorkspaceObservation = {
  readOnly: true;
  spawned: false;
  summary: string;
  extra: string;
};

export function observationFromProject(snap: ProjectWorkspaceSession): ProjectWorkspaceObservation {
  const items = snap.items.length ? snap.items : projectWorkspaces.list();
  const active = items.find((item) => item.id === snap.activeId) || projectWorkspaces.active();
  let summary: string;
  if (!items.length) summary = "projects idle — no owner workspace yet";
  else if (!active) summary = `projects ${items.length} saved, none active`;
  else {
    const lock = active.handsOffAuto || active.preferences.handsOffAuto ? ", Auto hands-off" : "";
    summary = `project ${active.name} (${active.kind})${lock}`;
  }
  return {
    readOnly: true,
    spawned: false,
    summary,
    extra: formatProjectExtra(),
  };
}

export function observeProjectWorkspaceState(): ProjectWorkspaceObservation {
  return observationFromProject(projectWorkspaceSnapshot());
}
