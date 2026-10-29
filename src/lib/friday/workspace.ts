/**
 * Primary folder (workspace root) handling.
 *
 * In the packaged app the folder is chosen during install / first launch via a
 * native picker, persisted by the Electron main process, and scanned by the
 * kernel — which then re-scans on every app restart and watches for changes.
 * In the browser preview everything below falls back to localStorage + mock
 * scan results so the flow can be reviewed.
 */

export type DetectedFolder = {
  path: string;
  kind: "code-root" | "docs" | "data" | "models" | "other";
  stack?: string;
  files: number;
  indexed: boolean;
};

export type WorkspaceScan = {
  root: string;
  scannedAt: string;
  files: number;
  folders: number;
  changedSinceLastRun: number;
  watching: boolean;
  detected: DetectedFolder[];
};

const KEY = "friday.workspaceRoot";

type DesktopApi = {
  pickFolder?: () => Promise<string | null>;
  getWorkspaceRoot?: () => Promise<string | null>;
  setWorkspaceRoot?: (path: string) => Promise<string>;
};

const desktop = (): DesktopApi | undefined =>
  typeof window !== "undefined" ? (window.friday as DesktopApi | undefined) : undefined;

export async function getWorkspaceRoot(): Promise<string | null> {
  const api = desktop();
  if (api?.getWorkspaceRoot) return api.getWorkspaceRoot();
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export async function setWorkspaceRoot(path: string): Promise<string> {
  const api = desktop();
  if (api?.setWorkspaceRoot) return api.setWorkspaceRoot(path);
  window.localStorage.setItem(KEY, path);
  return path;
}

export async function pickWorkspaceRoot(): Promise<string | null> {
  const api = desktop();
  if (api?.pickFolder) return api.pickFolder();
  return null;
}

/** Map a real desktop scan onto the folder view model. No estimates. */
export function fromScanResult(result: {
  root: string;
  scannedAt: number;
  folders?: {
    name: string;
    path: string;
    kind: DetectedFolder["kind"];
    files: number;
    subfolders: number;
    indexed: boolean;
  }[];
  totals?: { files: number; folders: number };
  missing?: string[];
}): WorkspaceScan {
  const folders = result.folders ?? [];
  return {
    root: result.root,
    scannedAt: new Date(result.scannedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    files: result.totals?.files ?? folders.reduce((n, f) => n + f.files, 0),
    folders: result.totals?.folders ?? folders.length,
    changedSinceLastRun: 0,
    watching: true,
    detected: folders.map((f) => ({
      path: f.path,
      kind: f.kind,
      stack: `${f.subfolders} sub-folders`,
      files: f.files,
      indexed: f.indexed,
    })),
  };
}

/** Mock scan used by the browser preview. */
export function mockScan(root: string): WorkspaceScan {
  const base = root.replace(/[\\/]+$/, "");
  return {
    root: base,
    scannedAt: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    files: 12480,
    folders: 962,
    changedSinceLastRun: 37,
    watching: true,
    detected: [
      {
        path: `${base}\\apps\\web`,
        kind: "code-root",
        stack: "Node · pnpm · TypeScript",
        files: 3140,
        indexed: true,
      },
      {
        path: `${base}\\services\\api`,
        kind: "code-root",
        stack: "Python · poetry",
        files: 1892,
        indexed: true,
      },
      {
        path: `${base}\\scripts`,
        kind: "code-root",
        stack: "PowerShell",
        files: 64,
        indexed: true,
      },
      { path: `${base}\\docs`, kind: "docs", files: 218, indexed: true },
      { path: `${base}\\data`, kind: "data", files: 6702, indexed: false },
      { path: `${base}\\models`, kind: "models", files: 12, indexed: false },
      { path: `${base}\\archive`, kind: "other", files: 452, indexed: false },
    ],
  };
}
