/**
 * FRIDAY · uninstall contract.
 *
 * The Windows uninstaller (build/installer.nsh) offers exactly two modes on its
 * welcome page and nothing in between:
 *
 *   "keep"   (default, checkbox unticked) — remove the application, its caches
 *            and its registry values. The FRIDAY root folder (models, memory,
 *            chats, config, backups, credentials, runtimes, voices, tools) is
 *            preserved untouched, together with HKCU\Software\FRIDAY\WorkspacePath
 *            so a later installation reuses the same workspace.
 *
 *   "delete" (checkbox ticked + a second YES/NO warning) — everything the
 *            "keep" mode removes PLUS the whole FRIDAY root folder, %APPDATA%\FRIDAY
 *            and %LOCALAPPDATA%\FRIDAY. Permanent and not undoable.
 *
 * electron-builder.yml keeps `deleteAppDataOnUninstall: false` on purpose: the
 * app-data decision belongs to the mode chosen here, not to a build flag that
 * would wipe data even when the user asked to keep it.
 *
 * This module types and documents that contract so no future code can quietly
 * widen the blast radius of either mode.
 */
export type UninstallMode = "keep" | "delete";

export interface UninstallPlan {
  /** Which of the two uninstaller modes this plan describes. */
  mode: UninstallMode;
  /** Paths the uninstaller deletes from the PC. */
  removes: string[];
  /** Paths that must survive an uninstall, untouched. */
  preserves: string[];
  /** Shown to the user before the mode runs. */
  warning: string;
}

/** Removed by BOTH modes: the application itself, never user content. */
const APPLICATION_REMOVES: string[] = [
  "%LOCALAPPDATA%\\Programs\\FRIDAY (the installed program folder)",
  "%LOCALAPPDATA%\\friday-cache",
  "%LOCALAPPDATA%\\friday-updater",
  "<INSTDIR>\\runtime (the isolated Python environment created by Setup)",
  "Start Menu shortcut",
  "Desktop shortcut",
  "HKCU\\Software\\FRIDAY\\InstallPath",
  "HKCU\\Software\\FRIDAY\\PythonSetupPending",
  "HKCU\\Software\\FRIDAY\\LastInstallMode",
];

const WORKSPACE_CONTENT =
  "The FRIDAY folder chosen at install time (all memory, chats, agents, skills, tools, plugins, models, database, config and backups inside it)";

export const KEEP_DATA_PLAN: UninstallPlan = {
  mode: "keep",
  removes: [...APPLICATION_REMOVES],
  preserves: [WORKSPACE_CONTENT, "%APPDATA%\\FRIDAY", "HKCU\\Software\\FRIDAY\\WorkspacePath"],
  warning: "FRIDAY will be removed from this PC. Your FRIDAY data folder is kept exactly as it is.",
};

/**
 * Last-line guard for "keep": electron-builder's uninstall section always ends
 * with an unconditional `RMDir /r $INSTDIR`. If an old pointer, a silent install
 * or an upgrade left the FRIDAY root inside the program folder, the uninstaller
 * moves that root to %USERPROFILE%\FRIDAY (or …\FRIDAY-preserved) and rewrites
 * WorkspacePath before the program folder is removed, so "keep" never loses data.
 */
export const KEEP_RESCUE_TARGETS = ["%USERPROFILE%\\FRIDAY", "%USERPROFILE%\\FRIDAY-preserved"];

export const DELETE_EVERYTHING_PLAN: UninstallPlan = {
  mode: "delete",
  removes: [
    ...APPLICATION_REMOVES,
    WORKSPACE_CONTENT,
    "%APPDATA%\\FRIDAY",
    "%LOCALAPPDATA%\\FRIDAY",
    "%LOCALAPPDATA%\\Programs\\FRIDAY (swept after the uninstaller exits)",
    "HKCU\\Software\\FRIDAY (the whole key, including WorkspacePath)",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\FRIDAY",
  ],
  preserves: [],
  warning:
    "This permanently deletes EVERYTHING in your FRIDAY folder — chats, memory, settings, credentials, models, runtimes and voices. This cannot be undone.",
};

export const UNINSTALL_MODES: Record<UninstallMode, UninstallPlan> = {
  keep: KEEP_DATA_PLAN,
  delete: DELETE_EVERYTHING_PLAN,
};

/** The default an uninstall runs with when the user changes nothing. */
export const UNINSTALL_PLAN: UninstallPlan = KEEP_DATA_PLAN;

export function planFor(mode: UninstallMode): UninstallPlan {
  return UNINSTALL_MODES[mode] ?? KEEP_DATA_PLAN;
}

/**
 * A TEST build shares the production root and may never remove it, whichever
 * mode was selected — removing FRIDAY Test only clears its own profile.
 */
export const TEST_BUILD_PLAN: UninstallPlan = {
  mode: "keep",
  removes: [...APPLICATION_REMOVES, "<FRIDAY root>\\profiles\\test", "HKCU\\Software\\FRIDAY Test"],
  preserves: [WORKSPACE_CONTENT, "HKCU\\Software\\FRIDAY\\WorkspacePath"],
  warning:
    "FRIDAY Test will be removed. The shared FRIDAY data folder used by the official build is never touched.",
};

export function assertPreservesWorkspace(root: string, targets: string[]): void {
  const normalized = root.replace(/\\+$/, "").toLowerCase();
  for (const target of targets) {
    if (target.replace(/\\+$/, "").toLowerCase().startsWith(normalized)) {
      throw new Error(`Uninstall refused: ${target} is inside the FRIDAY folder`);
    }
  }
}
