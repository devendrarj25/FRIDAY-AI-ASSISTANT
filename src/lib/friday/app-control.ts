/**
 * Restart and shutdown of FRIDAY herself.
 * Heard speech, a document, and a page can ask. They cannot run it.
 */

export const APP_RESTART_TOOL = "app_restart";
export const APP_SHUTDOWN_TOOL = "app_shutdown";

const SELF_RESTART =
  /^(?:please\s+)?(?:friday[,:\s]+)?(?:restart|reboot)(?:\s+(?:yourself|the\s+app|friday|kar(?:\s+do)?|now|please))*[\s!.।]*$/i;

const SELF_SHUTDOWN =
  /^(?:please\s+)?(?:friday[,:\s]+)?(?:shut\s*down|shutdown|band\s+kar(?:\s+do|o)?)(?:\s+(?:yourself|the\s+app|friday|kar(?:\s+do)?|now|please))*[\s!.।]*$/i;

export type AppControlTool = typeof APP_RESTART_TOOL | typeof APP_SHUTDOWN_TOOL;

export function selfLifecycleAction(
  text: string,
  options: { untrusted?: boolean } = {},
): { tool: AppControlTool; risk: "exec"; label: string } | null {
  if (options.untrusted) return null;
  const line = String(text || "").trim();
  if (!line || line.length > 80) return null;
  if (SELF_RESTART.test(line)) {
    return { tool: APP_RESTART_TOOL, risk: "exec", label: "restart FRIDAY" };
  }
  if (SELF_SHUTDOWN.test(line)) {
    return { tool: APP_SHUTDOWN_TOOL, risk: "exec", label: "shut FRIDAY down" };
  }
  return null;
}

export function appControlNeedsApproval(tool: string): boolean {
  return tool === APP_RESTART_TOOL || tool === APP_SHUTDOWN_TOOL;
}

export type LifecyclePreview = {
  tasks?: number;
  downloads?: number;
  listening?: boolean;
  auto?: boolean;
  agents?: number;
};

export function lifecycleConfirmLines(preview: LifecyclePreview = {}): string[] {
  const tasks = Math.max(0, Number(preview.tasks) || 0);
  const downloads = Math.max(0, Number(preview.downloads) || 0);
  const agents = Math.max(0, Number(preview.agents) || 0);
  const lines = [
    tasks ? `${tasks} running task${tasks === 1 ? "" : "s"} will be cancelled` : "No running tasks",
    downloads
      ? `${downloads} download${downloads === 1 ? "" : "s"} will be paused on this PC`
      : "No downloads in progress",
    preview.listening
      ? preview.auto
        ? "Auto mode is listening — the microphone will be released"
        : "The microphone will be released"
      : "The microphone is not listening",
    agents ? `${agents} agent run${agents === 1 ? "" : "s"} will be cancelled` : "No agent runs",
    "Start at login stays as you set it. If it is on, FRIDAY opens again at the next sign-in.",
  ];
  return lines;
}
