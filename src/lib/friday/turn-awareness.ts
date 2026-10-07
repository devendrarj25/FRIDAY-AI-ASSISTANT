/**
 * Live desk extras attached to a turn.
 *
 * Typed chat, Auto Mode voice, and the phone companion all go through Core
 * Brain. This is the one place that decides which live surfaces (terminal,
 * sandbox, logs, tasks, …) ride along, so the same question does not arrive
 * with a different context depending on how it was asked.
 */

import { conversationDigest } from "./brain/conversation-state";
import { shouldAttachBrowserExtra } from "./brain/browser-observe";
import { shouldAttachDoctorExtra } from "./brain/doctor-observe";
import { shouldAttachInstallerExtra } from "./brain/installer-observe";
import { shouldAttachLibraryExtra } from "./brain/library-observe";
import { shouldAttachLogsExtra } from "./brain/logs-observe";
import { shouldAttachProjectExtra } from "./brain/project-workspace-observe";
import { shouldAttachSandboxExtra } from "./brain/sandbox-observe";
import { shouldAttachTasksExtra } from "./brain/tasks-observe";
import { shouldAttachTerminalExtra } from "./brain/terminal-observe";
import { formatBrowserExtra } from "./browser-awareness";
import { formatDoctorExtra } from "./doctor-awareness";
import { formatInstallerExtra } from "./installer-awareness";
import { formatLibraryExtra } from "./library-awareness";
import { formatLogsExtra } from "./logs-awareness";
import { formatProjectExtra } from "./project-workspace-awareness";
import { formatSandboxExtra, sandboxSnapshot } from "./sandbox-awareness";
import { formatTasksExtra } from "./tasks-awareness";
import { formatTerminalExtra, terminalSnapshot } from "./terminal-awareness";

export type TurnAwarenessKind = "typed" | "voice" | "phone";

export function mergeTurnExtra(...blocks: Array<string | undefined | null>): string {
  return blocks
    .map((block) => String(block || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build the awareness block for one turn.
 *
 * Voice always carries a non-empty terminal/sandbox snapshot (the owner is
 * not looking at those pages). Typed and phone turns attach a surface only
 * when the prompt is actually about it, plus an optional library force-in
 * when files were just taught.
 */
export function turnAwarenessExtra(
  prompt: string,
  options: { kind?: TurnAwarenessKind; forceLibrary?: boolean } = {},
): string {
  const kind = options.kind ?? "typed";
  const parts: string[] = [];
  try {
    if (kind === "voice" || kind === "phone") {
      const digest = conversationDigest();
      if (digest) {
        parts.push(`${kind === "voice" ? "VOICE SESSION" : "PHONE SESSION"}: ${digest}`);
      }
    }
    if (kind === "voice") {
      const snap = terminalSnapshot();
      if (snap.cwd || snap.lines.length) parts.push(formatTerminalExtra());
      const sandbox = sandboxSnapshot();
      if (sandbox.projectId || sandbox.output) parts.push(formatSandboxExtra());
    } else {
      if (shouldAttachTerminalExtra(prompt)) parts.push(formatTerminalExtra());
      if (shouldAttachSandboxExtra(prompt)) parts.push(formatSandboxExtra());
    }
    if (shouldAttachLogsExtra(prompt)) parts.push(formatLogsExtra());
    if (shouldAttachTasksExtra(prompt)) parts.push(formatTasksExtra());
    if (shouldAttachDoctorExtra(prompt)) parts.push(formatDoctorExtra());
    if (shouldAttachInstallerExtra(prompt)) parts.push(formatInstallerExtra());
    if (options.forceLibrary || shouldAttachLibraryExtra(prompt)) {
      parts.push(formatLibraryExtra());
    }
    if (shouldAttachProjectExtra(prompt)) parts.push(formatProjectExtra());
    if (shouldAttachBrowserExtra(prompt)) parts.push(formatBrowserExtra());
  } catch {
    /* session store unavailable in tests / preview */
  }
  return mergeTurnExtra(...parts);
}
