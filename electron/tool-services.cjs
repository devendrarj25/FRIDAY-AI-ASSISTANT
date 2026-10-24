/**
 * Start, stop and restart the background services of tools FRIDAY uses, so they
 * run when work needs them and not otherwise.
 *
 * A service FRIDAY starts herself is hers: it is stopped when it has been idle
 * (default 20 minutes) and when FRIDAY quits, so a database or a model server
 * does not keep loading the PC. A service that was already running when FRIDAY
 * looked is never stopped by the sweep; only an explicit Stop does that. A
 * Windows service needs administrator rights, so it is started and stopped only
 * on request (with the owner's UAC approval) and never by the sweep.
 *
 * Everything outside this file is injected, which keeps it testable without a
 * network, a clock or a process.
 */

const IDLE_DEFAULT_MIN = 20;
const SWEEP_MS = 60_000;

/**
 * kind:
 *  - process  FRIDAY spawns `start` detached and kills that process tree to stop.
 *  - cli      the tool has its own start and stop commands.
 *  - app      a desktop app is launched; `stop` is its own documented command.
 *  - winservice  a Windows service by name, started with `sc` (administrator).
 * health:
 *  - { url } answers HTTP 200-499 | { port } accepts a TCP connection | { cli } exits 0
 */
const SERVICES = {
  Ollama: {
    kind: "process",
    health: { url: "http://127.0.0.1:11434/api/tags" },
    start: (ctx) => [ctx.exe || "ollama", ["serve"]],
    images: ["ollama app.exe", "ollama.exe", "ollama_llama_server.exe"],
    note: "the local model server",
  },
  "LM Studio": {
    kind: "cli",
    health: { url: "http://127.0.0.1:1234/v1/models" },
    start: () => ["lms", ["server", "start"]],
    stop: () => ["lms", ["server", "stop"]],
    note: "LM Studio's local server",
  },
  "Docker Desktop": {
    kind: "app",
    health: { cli: ["docker", ["info"]] },
    start: (ctx) => [
      ctx.exe ||
        `${process.env.ProgramFiles || "C:\\Program Files"}\\Docker\\Docker\\Docker Desktop.exe`,
      [],
    ],
    stop: () => ["docker", ["desktop", "stop"]],
    note: "the container engine",
  },
  "Redis (Memurai)": {
    kind: "winservice",
    names: ["Memurai", "Redis"],
    health: { port: 6379 },
    note: "the Redis-compatible store",
  },
  PostgreSQL: {
    kind: "winservice",
    match: /^postgresql/i,
    health: { port: 5432 },
    note: "the PostgreSQL database",
  },
  MongoDB: {
    kind: "winservice",
    names: ["MongoDB"],
    health: { port: 27017 },
    note: "the MongoDB database",
  },
  MySQL: {
    kind: "winservice",
    match: /^mysql/i,
    health: { port: 3306 },
    note: "the MySQL database",
  },
  MariaDB: {
    kind: "winservice",
    match: /^mariadb/i,
    health: { port: 3306 },
    note: "the MariaDB database",
  },
};

const serviceIds = () => Object.keys(SERVICES);
const hasService = (id) => Boolean(SERVICES[id]);

/**
 * @param {object} deps
 *  run(cmd,args,timeout) -> stdout|null     capture a command
 *  spawnDetached(cmd,args) -> {pid}|null    start a process that outlives the call
 *  killTree(pid)                            stop a process tree
 *  killImages(names)                        stop processes by image name
 *  ping(url) -> bool, tcp(port) -> bool     reachability
 *  exeFor(id) -> string|null                installed executable of the tool
 *  installed(id) -> bool                    the Install Manager scan found the tool
 *  elevated(cmd,args) -> {ok,error}         run with administrator rights
 *  winServices() -> string[]                names of installed Windows services
 *  lastUsed(id) -> ms|0                     the last time FRIDAY used the service
 *  now() -> ms, isWin
 */
function createServices(deps) {
  const d = {
    now: () => Date.now(),
    isWin: process.platform === "win32",
    lastUsed: () => 0,
    winServices: async () => [],
    ...deps,
  };
  const owned = new Map(); // id -> { pid, startedAt }
  const touched = new Map(); // id -> ms
  let idleMinutes = IDLE_DEFAULT_MIN;
  let timer = null;

  const healthy = async (spec) => {
    const h = spec.health || {};
    if (h.url) return Boolean(await d.ping(h.url));
    if (h.port) return Boolean(await d.tcp(h.port));
    if (h.cli) return (await d.run(h.cli[0], h.cli[1], 8000)) !== null;
    return false;
  };

  /** The Windows service that stands for this entry, if installed. */
  async function winName(spec) {
    if (!d.isWin) return null;
    const have = await d.winServices();
    if (spec.names) return spec.names.find((n) => have.includes(n)) || null;
    if (spec.match) return have.find((n) => spec.match.test(n)) || null;
    return null;
  }

  function schedule() {
    const sweepable = [...owned.keys()].some((id) => SERVICES[id]?.kind !== "winservice");
    if (sweepable && !timer) {
      timer = setInterval(() => void sweep(), SWEEP_MS);
      if (timer.unref) timer.unref();
    } else if (!sweepable && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  const touch = (id) => touched.set(id, d.now());

  async function status(id) {
    const spec = SERVICES[id];
    if (!spec) return { id, supported: false };
    const running = await healthy(spec);
    const win = spec.kind === "winservice" ? await winName(spec) : null;
    const installed =
      spec.kind === "winservice"
        ? Boolean(win)
        : Boolean(running || (d.installed && d.installed(id)) || d.exeFor(id));
    const own = owned.get(id);
    const idleMs =
      d.now() - Math.max(touched.get(id) || 0, d.lastUsed(id) || 0, own?.startedAt || 0);
    return {
      id,
      supported: true,
      kind: spec.kind,
      note: spec.note,
      installed,
      running,
      ownedByFriday: running && Boolean(own),
      needsAdmin: spec.kind === "winservice",
      canStart: installed && !running,
      canStop: running,
      idleMinutes: own ? Math.floor(idleMs / 60_000) : null,
      ...(win ? { serviceName: win } : {}),
    };
  }

  async function waitUp(spec, ms = 20_000) {
    const until = d.now() + ms;
    while (d.now() < until) {
      if (await healthy(spec)) return true;
      await (d.sleep ? d.sleep(700) : new Promise((r) => setTimeout(r, 700)));
    }
    return healthy(spec);
  }

  async function start(id) {
    const spec = SERVICES[id];
    if (!spec) return { ok: false, id, error: `no service called "${id}"` };
    if (await healthy(spec)) {
      touch(id);
      return { ok: true, id, running: true, detail: "already running" };
    }
    if (spec.kind === "winservice") {
      const name = await winName(spec);
      if (!name)
        return {
          ok: false,
          id,
          running: false,
          error: `${id} is not installed as a Windows service`,
        };
      const res = await d.elevated("sc", ["start", name]);
      if (!res.ok)
        return {
          ok: false,
          id,
          running: false,
          error: res.error || "Windows did not start the service",
        };
      const up = await waitUp(spec);
      if (up) touch(id);
      return up
        ? { ok: true, id, running: true, detail: `started the ${name} service` }
        : {
            ok: false,
            id,
            running: false,
            error: `the ${name} service started but nothing answers yet`,
          };
    }
    const exe = d.exeFor(id) || null;
    const [cmd, args] = spec.start({ exe });
    // A CLI service starts with a command that returns once the server is up.
    const child =
      spec.kind === "cli"
        ? (await d.run(cmd, args, 60_000)) !== null && { pid: 0 }
        : await d.spawnDetached(cmd, args);
    if (!child) return { ok: false, id, running: false, error: `${cmd} could not be started` };
    const up = await waitUp(spec);
    if (!up)
      return { ok: false, id, running: false, error: `${cmd} started but nothing answers yet` };
    owned.set(id, { pid: child.pid || 0, startedAt: d.now() });
    touch(id);
    schedule();
    return { ok: true, id, running: true, detail: `started ${cmd}` };
  }

  async function stop(id) {
    const spec = SERVICES[id];
    if (!spec) return { ok: false, id, error: `no service called "${id}"` };
    if (!(await healthy(spec))) {
      owned.delete(id);
      schedule();
      return { ok: true, id, running: false, detail: "already stopped" };
    }
    if (spec.kind === "winservice") {
      const name = await winName(spec);
      const res = name
        ? await d.elevated("sc", ["stop", name])
        : { ok: false, error: "service not found" };
      if (!res.ok)
        return {
          ok: false,
          id,
          running: true,
          error: res.error || "Windows did not stop the service",
        };
    } else if (spec.stop) {
      const [cmd, args] = spec.stop();
      await d.run(cmd, args, 30_000);
    } else if (spec.kind === "process") {
      const own = owned.get(id);
      if (own?.pid) d.killTree(own.pid);
      // The Ollama tray app respawns its server, so an explicit Stop ends the family.
      if (spec.images) d.killImages(spec.images);
    }
    let down = false;
    for (let i = 0; i < 12 && !down; i += 1) {
      down = !(await healthy(spec));
      if (!down) await (d.sleep ? d.sleep(500) : new Promise((r) => setTimeout(r, 500)));
    }
    if (down) {
      owned.delete(id);
      schedule();
    }
    return down
      ? { ok: true, id, running: false, detail: "stopped" }
      : { ok: false, id, running: true, error: "it is still answering after the stop command" };
  }

  async function restart(id) {
    const stopped = await stop(id);
    if (!stopped.ok) return stopped;
    return start(id);
  }

  /** Stop what FRIDAY started and nobody has used for the idle time. */
  async function sweep() {
    if (idleMinutes <= 0) return [];
    const stopped = [];
    for (const [id, own] of [...owned]) {
      if (SERVICES[id]?.kind === "winservice") continue;
      const last = Math.max(touched.get(id) || 0, d.lastUsed(id) || 0, own.startedAt || 0);
      if (d.now() - last < idleMinutes * 60_000) continue;
      const result = await stop(id);
      if (result.ok) stopped.push(id);
    }
    return stopped;
  }

  /** At quit: stop what FRIDAY started, without waiting and without a UAC prompt. */
  function stopOwned() {
    for (const [id, own] of [...owned]) {
      const spec = SERVICES[id];
      if (!spec || spec.kind === "winservice") continue;
      try {
        if (spec.kind === "process" && own.pid) d.killTree(own.pid);
        else if (spec.stop) {
          const [cmd, args] = spec.stop();
          d.spawnDetached(cmd, args);
        }
      } catch {
        /* the process may already be gone */
      }
      owned.delete(id);
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    ids: serviceIds,
    has: hasService,
    status,
    statusAll: async () => Promise.all(serviceIds().map((id) => status(id))),
    start,
    stop,
    restart,
    touch,
    sweep,
    stopOwned,
    ownedIds: () => [...owned.keys()],
    setIdleMinutes: (n) => {
      idleMinutes = Math.max(0, Math.min(24 * 60, Number(n) || 0));
      return idleMinutes;
    },
    getIdleMinutes: () => idleMinutes,
  };
}

module.exports = { SERVICES, IDLE_DEFAULT_MIN, SWEEP_MS, serviceIds, hasService, createServices };
