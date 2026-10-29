/**
 * FRIDAY · core/permissions
 *
 * Single decision point for anything that touches the machine: filesystem
 * writes, process launches, shell/PowerShell, network, registry, plugins.
 * Stages ask this broker; nothing else may decide on its own.
 */
import type { FridayModule, ModuleContext } from "../types";
import { bus } from "../event-bus";

export type Capability =
  | "fs.read"
  | "fs.write"
  | "process.spawn"
  | "shell.exec"
  | "network.request"
  | "registry.write"
  | "plugin.load"
  | "system.control";

export type Decision = "allow" | "deny" | "ask";

export interface PermissionRequest {
  capability: Capability;
  /** Concrete target: a path, host, command or plugin id. */
  target: string;
  /** Who is asking — agent/skill/tool/plugin id. */
  requester: string;
  reason?: string;
}

export interface PermissionResult {
  granted: boolean;
  decision: Decision;
  remembered: boolean;
  reason?: string;
}

/** Conservative defaults: reads are free, anything that mutates is asked for. */
const DEFAULT_POLICY: Record<Capability, Decision> = {
  "fs.read": "allow",
  "fs.write": "ask",
  "process.spawn": "ask",
  "shell.exec": "ask",
  "network.request": "ask",
  "registry.write": "ask",
  "plugin.load": "ask",
  "system.control": "ask",
};

export type AskHandler = (request: PermissionRequest) => Promise<boolean>;

export class PermissionBroker {
  private policy: Record<Capability, Decision> = { ...DEFAULT_POLICY };
  private remembered = new Map<string, boolean>();
  private ask: AskHandler | null = null;

  /** The UI (or the Electron main process) installs the prompt handler. */
  setAskHandler(handler: AskHandler | null): void {
    this.ask = handler;
  }

  setPolicy(capability: Capability, decision: Decision): void {
    this.policy[capability] = decision;
    bus.emit("permissions:policy", { capability, decision });
  }

  getPolicy(): Record<Capability, Decision> {
    return { ...this.policy };
  }

  remember(request: PermissionRequest, granted: boolean): void {
    this.remembered.set(this.key(request), granted);
  }

  forgetAll(): void {
    this.remembered.clear();
  }

  async request(request: PermissionRequest): Promise<PermissionResult> {
    const key = this.key(request);
    if (this.remembered.has(key)) {
      const granted = this.remembered.get(key)!;
      return { granted, decision: granted ? "allow" : "deny", remembered: true };
    }

    const decision = this.policy[request.capability] ?? "ask";
    if (decision === "allow") return { granted: true, decision, remembered: false };
    if (decision === "deny")
      return { granted: false, decision, remembered: false, reason: "blocked by policy" };

    if (!this.ask) {
      // No one can answer — refuse rather than silently escalating.
      bus.emit("permissions:unanswered", request);
      return { granted: false, decision, remembered: false, reason: "no approval handler" };
    }

    bus.emit("permissions:asked", request);
    const granted = await this.ask(request);
    bus.emit("permissions:answered", { request, granted });
    return { granted, decision, remembered: false };
  }

  private key(request: PermissionRequest): string {
    return `${request.requester}::${request.capability}::${request.target}`;
  }
}

export const permissions = new PermissionBroker();

export type PermissionsModule = FridayModule;

export const permissionsModule: PermissionsModule = {
  id: "core/permissions",
  init(ctx: ModuleContext) {
    bus.on("permissions:unanswered", (request) =>
      ctx.log("warn", "permission request had no handler", request),
    );
  },
  dispose() {
    permissions.setAskHandler(null);
    permissions.forgetAll();
  },
};

export default permissionsModule;
