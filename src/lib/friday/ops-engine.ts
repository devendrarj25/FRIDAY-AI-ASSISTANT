/**
 * Ops engine — the live state behind the registry pages (agents, plugins,
 * skills, workflows, modules, tools, runtimes, tasks and the terminal).
 *
 * Everything here runs in the renderer so the console behaves identically in
 * the browser preview and inside the Electron shell. When the desktop bridge
 * is present the same actions are forwarded to the Python kernel.
 */

import {
  modules as seedModules,
  runtimes as seedRuntimes,
  tasks as seedTasks,
  tools as seedTools,
} from "./mock";
import type { Agent, Plugin, Skill, Workflow } from "./hud-types";
import type { ModuleEntry, RuntimeEntry, Task, ToolDef } from "./types";
import { isDesktopApp } from "./desktop";
import {
  onTerminalOutput,
  terminalAvailable,
  terminalCancel,
  terminalCd,
  terminalExec,
  terminalRoot,
  terminalShells,
  terminalWrite,
  type TerminalRunResult,
  type TerminalShell,
} from "./terminal";
import {
  classifyCommand,
  classifyConsoleInput,
  resolveTerminalShell,
  TERMINAL_HELP,
} from "./terminal-command";
import {
  publishTerminalSession,
  registerTerminalRunner,
  requestTerminalAsk,
} from "./terminal-awareness";
import { actionMode } from "./brain/action-risk";
import { projectWorkspaces } from "./project-workspace-engine";

/**
 * Agents, plugins, skills, and workflows start empty and fill from the
 * workspace scan. Module, tool, runtime, and task seeds stay for the browser
 * preview only. The desktop app replaces those from the real scan.
 */
const preview = <T>(list: T[]): T[] => (isDesktopApp() ? [] : list);

export type OpsLogLevel = "info" | "ok" | "warn" | "error";
export type OpsLogLine = { id: string; at: string; level: OpsLogLevel; line: string };

export type TerminalLine = {
  id: string;
  kind: "cmd" | "out" | "warn" | "err" | "ok";
  text: string;
};

export type PendingCommand = { id: string; command: string; cwd: string; risk: "write" | "exec" };

/** One manifest folder found by the workspace scan. */
export type DiskItem = { id: string; name: string; version?: string | null; enabled?: boolean };

/** Registry lists as they exist on disk in the FRIDAY workspace. */
export type DiskRegistries = {
  agents?: DiskItem[] | undefined;
  skills?: DiskItem[] | undefined;
  plugins?: DiskItem[] | undefined;
  modules?: DiskItem[] | undefined;
  workflows?: DiskItem[] | undefined;
  tools?: DiskItem[] | undefined;
};

export type OpsState = {
  agents: Agent[];
  plugins: Plugin[];
  skills: Skill[];
  workflows: Workflow[];
  modules: ModuleEntry[];
  tools: ToolDef[];
  runtimes: RuntimeEntry[];
  tasks: Task[];
  installing: Record<string, number>;
  busy: string | null;
  terminal: TerminalLine[];
  cwd: string;
  /** Shell profile the console runs commands with (cmd, powershell, python…). */
  shell: string;
  /** Shell profiles available on this machine (desktop only). */
  shells: TerminalShell[];
  /** Run id of the command currently executing, if any. */
  runningCommand: string | null;
  pendingCommand: PendingCommand | null;
  /** Recent commands the owner (or FRIDAY) typed, newest first. */
  history: string[];

  log: OpsLogLine[];
};

const uid = () => Math.random().toString(36).slice(2, 10);
const clock = () =>
  new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const FS: Record<string, string[]> = {
  "C:\\FRIDAY\\workspace": ["my-project", "notes", "models", "README.md"],
  "C:\\FRIDAY\\workspace\\my-project": ["src", "package.json", "vite.config.ts"],
  "C:\\FRIDAY\\workspace\\notes": ["daily.md", "ideas.md"],
  "C:\\FRIDAY\\workspace\\models": ["qwen2.5-32b.gguf", "bge-m3.gguf"],
};

class OpsStore {
  private listeners = new Set<() => void>();
  /** Last disk scan signature — stops repeated hydration from re-running. */
  private diskSignature = "";
  /** Real-terminal wiring: done once, on first desktop use. */
  private rootReady = false;
  private unsubscribeOutput: (() => void) | null = null;
  private activeRun: string | null = null;
  private state: OpsState = {
    agents: [],
    plugins: [],
    skills: [],
    workflows: [],
    modules: preview(seedModules).map((m) => ({ ...m })),
    tools: preview(seedTools).map((t) => ({ ...t })),
    runtimes: preview(seedRuntimes).map((r) => ({ ...r })),
    tasks: preview(seedTasks).map((t) => ({ ...t, steps: t.steps.map((s) => ({ ...s })) })),
    installing: {},
    busy: null,
    terminal: [
      { id: uid(), kind: "out", text: "FRIDAY shell — type `help` for the command list." },
    ],
    cwd: "C:\\FRIDAY\\workspace",
    shell: "cmd",
    shells: [],
    runningCommand: null,
    pendingCommand: null,
    history: [],

    log: [],
  };

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<OpsState>) {
    this.state = { ...this.state, ...patch };
    this.syncSession();
    this.listeners.forEach((l) => l());
  }

  private syncSession() {
    publishTerminalSession({
      cwd: this.state.cwd,
      shell: this.state.shell,
      running: Boolean(this.state.runningCommand),
      lastCommand: this.state.history[0] ?? null,
      lines: this.state.terminal.map((line) => ({ kind: line.kind, text: line.text })),
      shells: this.state.shells.map((s) => ({
        id: s.id,
        label: s.label,
        available: s.available,
        ...(s.reason ? { reason: s.reason } : {}),
      })),
      history: this.state.history,
      desktop: terminalAvailable(),
    });
  }

  log(level: OpsLogLevel, line: string) {
    this.set({
      log: [{ id: uid(), at: clock(), level, line }, ...this.state.log].slice(0, 200),
    });
  }

  // ---------- registries on disk ----------
  /**
   * Merges the real workspace scan (manifests found on disk) into the registry
   * lists. Adds what is genuinely installed, refreshes versions of known
   * entries and never duplicates or removes anything the user added by hand.
   */
  hydrateFromDisk(scan: DiskRegistries) {
    const sig = JSON.stringify([
      scan.agents?.map((i) => `${i.id}@${i.version ?? ""}`),
      scan.skills?.map((i) => i.id),
      scan.plugins?.map((i) => `${i.id}@${i.version ?? ""}`),
      scan.modules?.map((i) => `${i.id}@${i.version ?? ""}`),
      scan.workflows?.map((i) => i.id),
      scan.tools?.map((i) => i.id),
    ]);
    if (sig === this.diskSignature) return;
    this.diskSignature = sig;

    const has = (list: { name: string }[], name: string) =>
      list.some((e) => e.name.toLowerCase() === name.toLowerCase());

    const agents = [...this.state.agents];
    for (const item of scan.agents ?? [])
      if (!has(agents, item.name))
        agents.push({
          name: item.name,
          role: "Installed",
          status: item.enabled === false ? "Inactive" : "Ready",
          tasks: 0,
          activity: "Low",
        });

    const skills = [...this.state.skills];
    for (const item of scan.skills ?? [])
      if (!has(skills, item.name))
        skills.push({
          name: item.name,
          category: "Installed",
          status: item.enabled === false ? "Inactive" : "Ready",
          level: "Basic",
          lastUsed: "never",
        });

    let plugins = [...this.state.plugins];
    for (const item of scan.plugins ?? []) {
      const version = item.version ?? "0.0.0";
      if (has(plugins, item.name)) {
        plugins = plugins.map((p) =>
          p.name.toLowerCase() === item.name.toLowerCase() ? { ...p, version } : p,
        );
      } else {
        plugins.push({
          name: item.name,
          kind: "Custom",
          version,
          status: item.enabled === false ? "Inactive" : "Ready",
          latest: version,
        });
      }
    }

    let modules = [...this.state.modules];
    for (const item of scan.modules ?? []) {
      const version = item.version ?? "0.1.0";
      if (has(modules, item.name)) {
        modules = modules.map((m) =>
          m.name.toLowerCase() === item.name.toLowerCase() ? { ...m, version } : m,
        );
      } else {
        modules.push({
          name: item.name,
          version,
          description: "Installed in the FRIDAY workspace.",
          permissions: [],
          entry: `modules/${item.id}`,
          enabled: item.enabled !== false,
        });
      }
    }

    const workflows = [...this.state.workflows];
    for (const item of scan.workflows ?? [])
      if (!has(workflows, item.name))
        workflows.push({
          name: item.name,
          status: "Scheduled",
          lastRun: "never",
          nextRun: "on demand",
        });

    const tools = [...this.state.tools];
    for (const item of scan.tools ?? [])
      if (!has(tools, item.name))
        tools.push({
          name: item.name,
          summary: "Imported tool from the FRIDAY workspace.",
          risk: "write",
          enabled: item.enabled !== false,
        });

    const added =
      agents.length -
      this.state.agents.length +
      (skills.length - this.state.skills.length) +
      (plugins.length - this.state.plugins.length) +
      (modules.length - this.state.modules.length) +
      (workflows.length - this.state.workflows.length) +
      (tools.length - this.state.tools.length);

    this.set({ agents, skills, plugins, modules, workflows, tools });
    if (added > 0) this.log("ok", `registry scan — ${added} item(s) found on disk`);
  }

  // ---------- agents ----------
  toggleAgent(name: string) {
    this.set({
      agents: this.state.agents.map((a) =>
        a.name === name
          ? {
              ...a,
              status: a.status === "Inactive" ? "Active" : "Inactive",
              tasks: a.status === "Inactive" ? a.tasks : 0,
            }
          : a,
      ),
    });
    this.log("info", `agent ${name} toggled`);
  }

  addAgent(name: string, role: string) {
    if (!name.trim()) return;
    this.set({
      agents: [
        ...this.state.agents,
        {
          name: name.trim(),
          role: role.trim() || "General",
          status: "Ready",
          tasks: 0,
          activity: "Low",
        },
      ],
    });
    this.log("ok", `agent ${name} registered`);
  }

  removeAgent(name: string) {
    this.set({ agents: this.state.agents.filter((a) => a.name !== name) });
    this.log("warn", `agent ${name} removed`);
  }

  // ---------- skills ----------
  addSkill(name: string, category: string) {
    if (!name.trim()) return;
    this.set({
      skills: [
        ...this.state.skills,
        {
          name: name.trim(),
          category: category.trim() || "General",
          status: "Learning",
          level: "Basic",
          lastUsed: "never",
        },
      ],
    });
    this.log("ok", `skill ${name} added — learning started`);
  }

  trainSkill(name: string) {
    const order = ["Basic", "Intermediate", "Advanced", "Expert"] as const;
    this.set({
      skills: this.state.skills.map((s) => {
        if (s.name !== name) return s;
        const next = order[Math.min(order.indexOf(s.level) + 1, order.length - 1)]!;
        return { ...s, level: next, status: "Active", lastUsed: "just now" };
      }),
    });
    this.log("ok", `skill ${name} practised`);
  }

  removeSkill(name: string) {
    this.set({ skills: this.state.skills.filter((s) => s.name !== name) });
    this.log("warn", `skill ${name} removed`);
  }

  // ---------- plugins ----------
  togglePlugin(name: string) {
    this.set({
      plugins: this.state.plugins.map((p) =>
        p.name === name ? { ...p, status: p.status === "Inactive" ? "Active" : "Inactive" } : p,
      ),
    });
    this.log("info", `plugin ${name} toggled`);
  }

  addPlugin(name: string) {
    if (!name.trim()) return;
    this.set({
      plugins: [
        ...this.state.plugins,
        { name: name.trim(), kind: "Custom", version: "0.1.0", status: "Ready", latest: "0.1.0" },
      ],
    });
    this.log("ok", `plugin ${name} installed from folder`);
  }

  updatePlugin(name: string) {
    this.set({
      plugins: this.state.plugins.map((p) =>
        p.name === name ? { ...p, version: p.latest, status: "Active" } : p,
      ),
    });
    this.log("ok", `plugin ${name} updated`);
  }

  async checkPluginUpdates() {
    this.set({ busy: "plugins" });
    this.log("info", "checking plugin registry…");
    await wait(700);
    const pending = this.state.plugins.filter((p) => p.version !== p.latest).length;
    this.set({ busy: null });
    this.log(
      pending ? "warn" : "ok",
      pending ? `${pending} plugin update(s) available` : "all plugins up to date",
    );
    return pending;
  }

  updateAllPlugins() {
    const n = this.state.plugins.filter((p) => p.version !== p.latest).length;
    this.set({ plugins: this.state.plugins.map((p) => ({ ...p, version: p.latest })) });
    this.log("ok", `${n} plugin(s) updated`);
    return n;
  }

  // ---------- modules ----------
  toggleModule(name: string) {
    this.set({
      modules: this.state.modules.map((m) => (m.name === name ? { ...m, enabled: !m.enabled } : m)),
    });
    this.log(
      "info",
      `module ${name} ${this.state.modules.find((m) => m.name === name)?.enabled ? "enabled" : "disabled"}`,
    );
  }

  loadModule(name: string) {
    if (!name.trim()) return;
    this.set({
      modules: [
        ...this.state.modules,
        {
          name: name.trim(),
          version: "0.1.0",
          description: "Loaded from a local folder manifest.",
          permissions: ["fs.read"],
          entry: `modules/${name.trim()}/main.py`,
          enabled: false,
        },
      ],
    });
    this.log("ok", `module ${name} loaded — enable it to let the kernel use it`);
  }

  // ---------- tools ----------
  toggleTool(name: string) {
    const next = this.state.tools.map((t) => (t.name === name ? { ...t, enabled: !t.enabled } : t));
    this.set({ tools: next });
    this.log(
      "info",
      `tool ${name} ${next.find((t) => t.name === name)?.enabled ? "allowed" : "blocked"}`,
    );
  }

  // ---------- runtimes ----------
  installRuntime(name: string) {
    const rt = this.state.runtimes.find((r) => r.name === name);
    if (!rt || this.state.installing[name] !== undefined) return;
    if (isDesktopApp()) {
      // Real runtime installs belong to the Sandbox/Install Manager engines,
      // which drive the machine. Never fake progress in the desktop app.
      this.log("warn", `${name} install runs from Install Manager — use that section`);
      return;
    }
    this.log("info", `installing ${name} ${rt.latest} from ${rt.source}`);
    this.set({ installing: { ...this.state.installing, [name]: 0 } });
    const tick = setInterval(() => {
      const pct = (this.state.installing[name] ?? 0) + 12 + Math.random() * 10;
      if (pct >= 100) {
        clearInterval(tick);
        const rest = { ...this.state.installing };
        delete rest[name];
        this.set({
          installing: rest,
          runtimes: this.state.runtimes.map((r) =>
            r.name === name ? { ...r, installed: r.latest } : r,
          ),
        });
        this.log("ok", `${name} ${rt.latest} ready`);
      } else {
        this.set({ installing: { ...this.state.installing, [name]: pct } });
      }
    }, 320);
  }

  async checkRuntimeUpdates() {
    this.set({ busy: "runtimes" });
    this.log("info", "querying official sources…");
    await wait(800);
    const outdated = this.state.runtimes.filter(
      (r) => r.installed && r.installed !== r.latest,
    ).length;
    this.set({ busy: null });
    this.log(
      outdated ? "warn" : "ok",
      outdated ? `${outdated} runtime update(s) available` : "runtimes up to date",
    );
    return outdated;
  }

  // ---------- workflows ----------
  addWorkflow(name: string, when: string) {
    if (!name.trim()) return;
    this.set({
      workflows: [
        ...this.state.workflows,
        {
          name: name.trim(),
          status: "Scheduled",
          lastRun: "never",
          nextRun: when.trim() || "on demand",
        },
      ],
    });
    this.log("ok", `workflow ${name} scheduled`);
  }

  runWorkflow(name: string) {
    this.set({
      workflows: this.state.workflows.map((w) =>
        w.name === name ? { ...w, status: "Running" } : w,
      ),
    });
    this.log("info", `workflow ${name} started`);
    setTimeout(() => {
      this.set({
        workflows: this.state.workflows.map((w) =>
          w.name === name ? { ...w, status: "Completed", lastRun: "just now" } : w,
        ),
      });
      this.log("ok", `workflow ${name} completed`);
    }, 1800);
  }

  removeWorkflow(name: string) {
    this.set({ workflows: this.state.workflows.filter((w) => w.name !== name) });
    this.log("warn", `workflow ${name} deleted`);
  }

  // ---------- tasks ----------
  resolveTask(id: string, allow: boolean) {
    this.set({
      tasks: this.state.tasks.map((t) => {
        if (t.id !== id) return t;
        const steps = t.steps.map((s) =>
          s.state === "blocked"
            ? {
                ...s,
                state: allow ? ("done" as const) : ("failed" as const),
                detail: allow ? "approved by Dev" : "denied by Dev",
              }
            : s,
        );
        return { ...t, state: allow ? ("done" as const) : ("failed" as const), steps };
      }),
    });
    this.log(allow ? "ok" : "warn", `${id} ${allow ? "approved" : "denied"}`);
  }

  // ---------- terminal ----------
  private print(kind: TerminalLine["kind"], text: string) {
    this.set({ terminal: [...this.state.terminal, { id: uid(), kind, text }].slice(-400) });
  }

  clearTerminal() {
    this.set({ terminal: [] });
  }

  /** Echo a line (Ask FRIDAY busy, clipboard, etc.) without executing it. */
  note(kind: TerminalLine["kind"], text: string) {
    this.print(kind, text);
  }

  /** Switch the shell profile every following command runs in. */
  setShell(id: string) {
    const known = this.state.shells.find((s) => s.id === id);
    if (this.state.shells.length && !known) {
      this.print("err", `unknown shell: ${id}`);
      return;
    }
    if (known && !known.available) {
      this.print("err", `${known.label} is not installed on this PC`);
      return;
    }
    this.set({ shell: id });
    this.print("ok", `shell → ${known?.label ?? id}`);
  }

  submitCommand(raw: string) {
    const command = raw.trim();
    if (!command) return;
    // While a command is running, input goes to its stdin (interactive prompts).
    if (this.state.runningCommand) {
      this.print("cmd", `> ${command}`);
      void terminalWrite(this.state.runningCommand, command);
      return;
    }
    const classified = classifyConsoleInput(command);
    if (classified.kind === "ask") {
      this.print("cmd", `? ${classified.text}`);
      if (!requestTerminalAsk(classified.text)) {
        this.print(
          "warn",
          "Ask FRIDAY from this Terminal page (Ask panel) or Chat — I can see this buffer.",
        );
      }
      return;
    }
    const line = classified.text;
    this.print("cmd", `> ${line}`);
    this.remember(line);
    const risky = classifyCommand(line) === "exec";
    const execTool = this.state.tools.find((t) => t.name === "shell.cmd");
    if (risky) {
      if (execTool && !execTool.enabled) {
        this.print("err", "shell.cmd is blocked in Tools & Runtimes");
        return;
      }
      this.set({ pendingCommand: { id: uid(), command: line, cwd: this.state.cwd, risk: "exec" } });
      this.print("warn", "! approval required (exec) — confirm below");
      this.log("warn", `approval required for \`${line}\``);
      return;
    }
    this.execute(line);
  }

  private remember(command: string) {
    const next = [command, ...this.state.history.filter((item) => item !== command)].slice(0, 50);
    this.set({ history: next });
  }

  resolveCommand(allow: boolean) {
    const pending = this.state.pendingCommand;
    if (!pending) return;
    this.set({ pendingCommand: null });
    if (!allow) {
      this.print("err", "denied by Dev");
      this.log("warn", `denied \`${pending.command}\``);
      return;
    }
    this.log("ok", `approved \`${pending.command}\``);
    this.execute(pending.command);
  }

  /**
   * Points the shell at the real FRIDAY workspace root and loads the shell
   * profiles this machine actually has. Runs once, the first time the desktop
   * terminal is used.
   */
  async initTerminal(): Promise<void> {
    if (this.rootReady || !terminalAvailable()) return;
    this.rootReady = true;
    const [root, shells] = await Promise.all([terminalRoot(), terminalShells()]);
    const patch: Partial<OpsState> = {};
    if (root) patch.cwd = root;
    if (shells.length) {
      patch.shells = shells;
      const current = shells.find((s) => s.id === this.state.shell && s.available);
      if (!current) {
        patch.shell =
          (shells.find((s) => s.default && s.available) ?? shells.find((s) => s.available))?.id ??
          this.state.shell;
      }
    }
    this.set(patch);
    this.unsubscribeOutput?.();
    this.unsubscribeOutput = onTerminalOutput((event) => {
      if (event.phase !== "output" || !event.text) return;
      for (const line of String(event.text).replace(/\r/g, "").split("\n")) {
        if (line.length) this.print(event.kind === "err" ? "err" : "out", line);
      }
    });
  }

  /** Cancels the command currently running in the desktop terminal. */
  cancelCommand(): void {
    const runId = this.activeRun ?? this.state.runningCommand;
    if (!runId) return;
    this.print("warn", "stopping…");
    void terminalCancel(runId);
  }

  private execute(command: string) {
    if (terminalAvailable()) {
      void this.executeReal(command);
      return;
    }
    this.executePreview(command);
  }

  /**
   * Programmatic shell access for the rest of FRIDAY (brain, agents, tasks,
   * self-repair). Everything is echoed into the console so the owner can see
   * exactly what FRIDAY ran, and the real result is returned to the caller.
   */
  async runShell(
    command: string,
    options: { shell?: string; cwd?: string; timeoutMs?: number; actor?: string } = {},
  ) {
    if (!terminalAvailable())
      return { ok: false, skipped: true, error: "terminal is desktop-only" };
    await this.initTerminal();
    this.print("cmd", `> ${options.actor ? `[${options.actor}] ` : ""}${command}`);
    this.remember(command);
    const builtin = await this.tryBuiltin(command);
    if (builtin) return builtin;
    return this.spawn(command, options);
  }

  /** Real execution: a child process in the FRIDAY workspace. */
  private async executeReal(command: string) {
    await this.initTerminal();
    const builtin = await this.tryBuiltin(command);
    if (builtin) return builtin;
    return this.spawn(command, {});
  }

  /**
   * Session builtins (`cd`, `home`, `pwd`, …) must run here — a child `cd`
   * cannot change the console cwd. Same path for the owner and for FRIDAY.
   */
  private async tryBuiltin(command: string): Promise<TerminalRunResult | null> {
    const [bin, ...args] = command.split(/\s+/);
    const lower = String(bin || "").toLowerCase();
    if (lower === "clear" || lower === "cls") {
      this.clearTerminal();
      return { ok: true };
    }
    if (lower === "help") {
      this.printHelp();
      return { ok: true };
    }
    if (lower === "shells") {
      for (const s of this.state.shells) {
        this.print(
          s.available ? "out" : "warn",
          `${s.id.padEnd(12)} ${s.label} ${s.available ? "" : "(not installed)"}`,
        );
      }
      return { ok: true };
    }
    if (lower === "shell") {
      if (!args[0]) {
        this.print("out", `current shell: ${this.state.shell}`);
        return { ok: true, output: this.state.shell };
      }
      this.setShell(String(args[0]));
      return { ok: true };
    }
    if (lower === "cd") {
      const moved = await terminalCd(this.state.cwd, args.join(" "));
      if (moved.ok) {
        this.set({ cwd: moved.cwd });
        return { ok: true, cwd: moved.cwd };
      }
      this.print("err", moved.error || "cannot change directory");
      return { ok: false, error: moved.error || "cannot change directory" };
    }
    if (lower === "pwd") {
      this.print("out", this.state.cwd);
      return { ok: true, cwd: this.state.cwd, output: this.state.cwd };
    }
    if (lower === "home") {
      const moved = await terminalCd(this.state.cwd, "");
      if (moved.ok) {
        this.set({ cwd: moved.cwd });
        return { ok: true, cwd: moved.cwd };
      }
      this.print("err", moved.error || "cannot return to the FRIDAY root");
      return { ok: false, error: moved.error || "cannot return to the FRIDAY root" };
    }
    if (lower === "history") {
      if (!this.state.history.length) {
        this.print("out", "(no commands this session)");
        return { ok: true, output: "" };
      }
      this.state.history.forEach((item, i) => this.print("out", `${i + 1}  ${item}`));
      return { ok: true, output: this.state.history.join("\n") };
    }
    return null;
  }

  /** cmd / PowerShell / bash — not the Python or Node REPL profiles. */
  private systemShellId(): string {
    const ids = ["cmd", "powershell", "pwsh", "wsl", "git-bash", "bash", "sh"];
    if (ids.includes(this.state.shell)) return this.state.shell;
    const available = this.state.shells.find((s) => s.available && ids.includes(s.id));
    if (available) return available.id;
    const fallback = this.state.shells.find((s) => s.default && s.available);
    return fallback?.id ?? "cmd";
  }

  /** One real child process, with the console wired to its live output. */
  private async spawn(
    command: string,
    options: { shell?: string; cwd?: string; timeoutMs?: number },
  ) {
    const runId = `term-${uid()}`;
    this.activeRun = runId;
    this.set({ busy: "terminal", runningCommand: runId });
    const requested = options.shell ?? this.state.shell;
    const shell = resolveTerminalShell(requested, this.systemShellId(), command);
    if (shell !== requested) {
      this.print("warn", `using ${shell} — ${requested} cannot run that command`);
    }
    const cwd = options.cwd ?? this.state.cwd;
    if (actionMode() === "auto") {
      const skip = projectWorkspaces.skipAutoWrite({
        prompt: command,
        paths: [cwd],
        risk: "exec",
        mode: "auto",
      });
      if (skip.block) {
        this.activeRun = null;
        this.set({ busy: null, runningCommand: null });
        this.print("err", skip.note);
        this.log("warn", skip.note);
        return { ok: false, error: skip.note, cwd };
      }
    }
    const result = await terminalExec({
      command,
      cwd,
      shell,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      runId,
    });
    this.activeRun = null;
    this.set({ busy: null, runningCommand: null });
    publishTerminalSession({
      lastExitOk: result.ok,
      lastExitCode: result.code ?? null,
    });
    if (result.error) this.print("err", result.error);
    else if (!result.ok) this.print("err", `exit ${result.code ?? "?"}`);
    else this.print("ok", `exit 0 · ${result.ms ?? 0}ms`);
    this.log(result.ok ? "ok" : "warn", `${command} → ${result.ok ? "ok" : "failed"}`);
    return result;
  }

  private printHelp() {
    for (const line of TERMINAL_HELP.split("\n")) this.print("out", line);
  }

  /**
   * Browser-preview shell. It never runs in the desktop app — the preview has
   * no machine to talk to, so the console still needs something to answer.
   */
  private executePreview(command: string) {
    const [bin, ...args] = command.split(/\s+/);
    const cwd = this.state.cwd;
    switch (bin) {
      case "help":
        this.print("out", TERMINAL_HELP);
        this.print(
          "out",
          "preview shell: git status · node -v · python -V · npm ci (needs approval)",
        );
        return;
      case "pwd":
        this.print("out", cwd);
        return;
      case "clear":
        this.clearTerminal();
        return;
      case "cd": {
        const target = args.join(" ");
        if (!target || target === "\\" || target === "/") {
          this.set({ cwd: "C:\\FRIDAY\\workspace" });
          return;
        }
        if (target === "..") {
          const parts = cwd.split("\\");
          if (parts.length > 3) parts.pop();
          this.set({ cwd: parts.join("\\") });
          return;
        }
        const next = `${cwd}\\${target}`;
        if (FS[next]) this.set({ cwd: next });
        else this.print("err", `The system cannot find the path specified: ${target}`);
        return;
      }
      case "ls":
      case "dir": {
        const entries = FS[cwd];
        if (!entries) this.print("out", "(empty)");
        else entries.forEach((e) => this.print("out", e));
        return;
      }
      case "cat": {
        const file = args.join(" ");
        if (!file) return this.print("err", "usage: cat <file>");
        if (!(FS[cwd] ?? []).includes(file)) return this.print("err", `no such file: ${file}`);
        this.print("out", `— ${file} —`);
        this.print("out", "(file preview is available in the desktop app with fs.read enabled)");
        return;
      }
      case "echo":
        this.print("out", args.join(" "));
        return;
      case "git":
        if (args[0] === "status") {
          this.print("out", "On branch fix/lockfile-node20");
          this.print("ok", "nothing to commit, working tree clean");
        } else this.print("out", `git ${args.join(" ")}: ok`);
        return;
      case "node":
        this.print("out", "v20.15.1");
        return;
      case "python":
        this.print("out", "Python 3.12.4");
        return;
      case "ollama":
        this.print("out", "NAME                     SIZE");
        this.print("out", "deepseek-coder-v2:16b    9.2 GB");
        return;
      case "npm":
      case "bun":
      case "pip":
        this.print("ok", `${command} completed in ${(2 + Math.random() * 4).toFixed(1)}s`);
        return;
      default:
        this.print("err", `'${bin}' is not recognized as a command. Type 'help'.`);
    }
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const ops = new OpsStore();
registerTerminalRunner(async (command, options) => {
  if (!terminalAvailable()) {
    return { ok: false, skipped: true, error: "workspace terminal is desktop-only" };
  }
  return ops.runShell(command, options);
});
