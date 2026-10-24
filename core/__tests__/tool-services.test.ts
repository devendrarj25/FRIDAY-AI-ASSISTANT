/**
 * Services FRIDAY starts for herself run while they are used and stop when they
 * are not, and a service she did not start is never stopped behind the owner's back.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const { createServices, SERVICES } = require_(path.join(root, "electron/tool-services.cjs"));

function world(over: Record<string, unknown> = {}) {
  const up = new Set<string>(); // health targets that answer: "url:...", "port:N"
  const log: string[] = [];
  let clock = 1_000_000;
  const deps = {
    now: () => clock,
    isWin: true,
    sleep: async () => {
      clock += 700;
    },
    ping: async (url: string) => up.has(`url:${url}`),
    tcp: async (port: number) => up.has(`port:${port}`),
    run: async (cmd: string, args: string[]) => {
      log.push(`run ${cmd} ${args.join(" ")}`);
      if (cmd === "lms" && args[1] === "start") up.add("url:http://127.0.0.1:1234/v1/models");
      if (cmd === "lms" && args[1] === "stop") up.delete("url:http://127.0.0.1:1234/v1/models");
      return "";
    },
    spawnDetached: async (cmd: string, args: string[]) => {
      log.push(`spawn ${cmd} ${args.join(" ")}`);
      if (/ollama/i.test(cmd)) up.add("url:http://127.0.0.1:11434/api/tags");
      return { pid: 4242 };
    },
    killTree: (pid: number) => {
      log.push(`kill ${pid}`);
      up.delete("url:http://127.0.0.1:11434/api/tags");
    },
    killImages: (names: string[]) => log.push(`images ${names.join(",")}`),
    exeFor: (id: string) => (id === "Ollama" ? "C:\\Ollama\\ollama.exe" : null),
    elevated: async (cmd: string, args: string[]) => {
      log.push(`admin ${cmd} ${args.join(" ")}`);
      if (args[0] === "start") up.add("port:5432");
      if (args[0] === "stop") up.delete("port:5432");
      return { ok: true };
    },
    winServices: async () => ["postgresql-x64-17", "Spooler"],
    ...over,
  };
  return { up, log, deps, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe("tool services", () => {
  it("starts a process service, owns it, and stops it by its process", async () => {
    const w = world();
    const svc = createServices(w.deps);
    const started = await svc.start("Ollama");
    expect(started).toMatchObject({ ok: true, running: true });
    expect(w.log).toContain("spawn C:\\Ollama\\ollama.exe serve");
    expect(svc.ownedIds()).toEqual(["Ollama"]);
    expect((await svc.status("Ollama")).ownedByFriday).toBe(true);
    const stopped = await svc.stop("Ollama");
    expect(stopped).toMatchObject({ ok: true, running: false });
    expect(w.log).toContain("kill 4242");
    expect(w.log.some((l) => l.startsWith("images ollama app.exe"))).toBe(true);
    expect(svc.ownedIds()).toEqual([]);
  });

  it("restart stops then starts, and starting a running service does nothing", async () => {
    const w = world();
    const svc = createServices(w.deps);
    await svc.start("Ollama");
    const before = w.log.length;
    expect((await svc.start("Ollama")).detail).toBe("already running");
    expect(w.log.length).toBe(before);
    const again = await svc.restart("Ollama");
    expect(again).toMatchObject({ ok: true, running: true });
    expect(w.log.filter((l) => l.startsWith("spawn")).length).toBe(2);
  });

  it("the idle sweep stops only what FRIDAY started and only after the idle time", async () => {
    const w = world();
    const svc = createServices(w.deps);
    svc.setIdleMinutes(20);
    await svc.start("Ollama");
    w.up.add("url:http://127.0.0.1:1234/v1/models"); // LM Studio: already running, not hers
    w.advance(10 * 60_000);
    expect(await svc.sweep()).toEqual([]);
    svc.touch("Ollama");
    w.advance(19 * 60_000);
    expect(await svc.sweep()).toEqual([]); // touched 19 minutes ago
    w.advance(2 * 60_000);
    expect(await svc.sweep()).toEqual(["Ollama"]);
    expect(w.up.has("url:http://127.0.0.1:1234/v1/models")).toBe(true);
    svc.setIdleMinutes(0);
    await svc.start("Ollama");
    w.advance(9 * 60 * 60_000);
    expect(await svc.sweep()).toEqual([]); // 0 means never
  });

  it("use elsewhere in FRIDAY (the usage ledger) keeps a service alive", async () => {
    let used = 0;
    const w = world({ lastUsed: () => used });
    const svc = createServices(w.deps);
    await svc.start("Ollama");
    w.advance(30 * 60_000);
    used = w.now() - 60_000;
    expect(await svc.sweep()).toEqual([]);
    w.advance(25 * 60_000);
    expect(await svc.sweep()).toEqual(["Ollama"]);
  });

  it("a CLI service is stopped with its own command", async () => {
    const w = world();
    const svc = createServices(w.deps);
    expect((await svc.start("LM Studio")).ok).toBe(true);
    expect((await svc.stop("LM Studio")).ok).toBe(true);
    expect(w.log).toContain("run lms server stop");
  });

  it("a Windows service goes through administrator rights, by its installed name, never in the sweep", async () => {
    const w = world();
    const svc = createServices(w.deps);
    const status = await svc.status("PostgreSQL");
    expect(status).toMatchObject({
      installed: true,
      running: false,
      needsAdmin: true,
      serviceName: "postgresql-x64-17",
    });
    expect((await svc.start("PostgreSQL")).ok).toBe(true);
    expect(w.log).toContain("admin sc start postgresql-x64-17");
    w.advance(10 * 60 * 60_000);
    expect(await svc.sweep()).toEqual([]);
    expect((await svc.stop("PostgreSQL")).ok).toBe(true);
    const missing = await svc.start("MongoDB");
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not installed/);
  });

  it("reports failures plainly", async () => {
    const w = world({ spawnDetached: async () => null });
    const svc = createServices(w.deps);
    expect(await svc.start("Ollama")).toMatchObject({ ok: false, running: false });
    expect((await svc.start("Nothing")).error).toMatch(/no service/);
    const stuck = world({ killTree: () => undefined, killImages: () => undefined });
    const s2 = createServices(stuck.deps);
    await s2.start("Ollama");
    const result = await s2.stop("Ollama");
    expect(result).toMatchObject({ ok: false, running: true });
  });

  it("quitting stops what FRIDAY started without a prompt", async () => {
    const w = world();
    const svc = createServices(w.deps);
    await svc.start("Ollama");
    svc.stopOwned();
    expect(w.log).toContain("kill 4242");
    expect(svc.ownedIds()).toEqual([]);
  });

  it("every service names how to reach it and how it runs", () => {
    for (const [id, spec] of Object.entries(SERVICES) as [string, Record<string, unknown>][]) {
      expect(spec["health"], id).toBeTruthy();
      expect(["process", "cli", "app", "winservice"], id).toContain(spec["kind"]);
    }
  });
});

describe("image kill", () => {
  it("stops a program by image name only on Windows and only for a plain .exe", async () => {
    const { createRequire } = await import("node:module");
    const lifecycle = createRequire(import.meta.url)("../../electron/app-lifecycle.cjs") as {
      killImage: (name: string, o: Record<string, unknown>) => boolean;
    };
    const calls: string[][] = [];
    const spawn = (_cmd: string, args: string[]) => (calls.push(args), { unref() {} });
    expect(lifecycle.killImage("ollama.exe", { platform: "win32", spawn })).toBe(true);
    expect(calls[0]).toEqual(["/F", "/IM", "ollama.exe"]);
    expect(lifecycle.killImage("a b; calc.exe", { platform: "win32", spawn })).toBe(false);
    expect(lifecycle.killImage("ollama.exe", { platform: "linux", spawn })).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
