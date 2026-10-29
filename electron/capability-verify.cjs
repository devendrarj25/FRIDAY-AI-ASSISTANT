// FRIDAY · test-before-enable for installed capabilities.
//
// A freshly imported skill / tool / agent / module / workflow / plugin is
// written to disk *disabled*. It only becomes enabled after it really ran:
//
//   1. smoke test  — the pack is loaded inside sandbox.runIsolated() (the same
//                    isolation Skills already use) and, when the pack declares
//                    a self-test or example input, actually invoked.
//   2. dependency  — if the run failed because something is missing (a Python
//      resolution    import, a binary, a node module) the missing name is
//                    matched against the real Install Manager catalog
//                    (electron/toolchain.cjs) and installed through the exact
//                    same winget/pip/npm/cargo jobs the Install Manager runs.
//                    Then the smoke test is retried.
//   3. guidance    — when the dependency is not in the catalog, or cannot be
//                    installed unattended, the owner gets a real step-by-step
//                    card instead of a silent failure, plus a retry.
//
// Nothing here duplicates an installer or a sandbox: every real action is
// delegated to sandbox.cjs, skills.cjs and toolchain.cjs.
const fs = require("fs");
const path = require("path");

const sandbox = require("./sandbox.cjs");
const skills = require("./skills.cjs");
const toolchain = require("./toolchain.cjs");

/* ------------------------------------------------------------ dependencies */

// Real failure signatures from the three runtimes a pack can be written in.
const MISSING_PATTERNS = [
  /ModuleNotFoundError: No module named ['"]([\w.\-]+)['"]/i,
  /ImportError: No module named ['"]?([\w.\-]+)['"]?/i,
  /Cannot find module ['"]([^'"]+)['"]/i,
  /ERR_MODULE_NOT_FOUND[^\n]*['"]([^'"]+)['"]/i,
  /spawn ([\w.\-]+) ENOENT/i,
  /['"]?([\w.\-]+)['"]? is not recognized as an internal or external command/i,
  /([\w.\-]+): command not found/i,
  /command not found: ([\w.\-]+)/i,
];

/** The first genuinely missing dependency named by a failed run, if any. */
function missingFromOutput(output) {
  const text = String(output || "");
  for (const pattern of MISSING_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit && hit[1]) {
      // A relative path is the pack's own broken file, not a dependency.
      const name = hit[1].trim();
      if (name.startsWith(".") || name.startsWith("/") || /^[a-z]:\\/i.test(name)) return null;
      return name.split("/")[0].replace(/^node:/, "");
    }
  }
  return null;
}

const lower = (value) => String(value || "").toLowerCase();

/**
 * Match a dependency name against the real Install Manager catalog.
 * Matching mirrors how the catalog itself describes a component: its row id,
 * its command, its pip distribution / import name, or its npm package.
 */
function resolveDependency(name) {
  const wanted = lower(name);
  if (!wanted) return null;
  const direct = toolchain.toolById ? toolchain.toolById(String(name)) : null;
  if (direct) return direct;
  for (const tool of toolchain.TOOLS) {
    if (
      lower(tool.id) === wanted ||
      lower(tool.cmd) === wanted ||
      lower(tool.pip) === wanted ||
      lower(tool.pipImport) === wanted ||
      lower(tool.npm) === wanted ||
      lower(tool.cargo) === wanted
    ) {
      return tool;
    }
  }
  // "python3.12", "node18" and similar version suffixes still mean the runtime.
  for (const tool of toolchain.TOOLS) {
    if (
      tool.cmd &&
      wanted.startsWith(lower(tool.cmd)) &&
      /^[\d.]+$/.test(wanted.slice(String(tool.cmd).length))
    )
      return tool;
  }
  return null;
}

/** Can this catalog row be installed without the owner clicking through a GUI? */
function isAutomatable(tool) {
  if (!tool) return false;
  if (tool.manual && !tool.winget && !tool.pip && !tool.npm && !tool.cargo && !tool.installerUrl)
    return false;
  return Boolean(
    tool.winget || tool.pip || tool.npm || tool.cargo || tool.installerUrl || tool.optionalFeature,
  );
}

/**
 * Honest, specific manual guidance — the same step-card shape the rest of the
 * app renders (title + numbered steps + a link), never a vague failure.
 */
function manualGuide(name, tool, reason) {
  const label = tool?.id || String(name);
  const steps = [];
  if (tool) {
    steps.push(`Open the download page for ${label} and install it for this Windows account.`);
    if (tool.optionalFeature)
      steps.push(
        `${label} is a Windows optional feature — enable it in "Turn Windows features on or off", then restart Windows.`,
      );
    if (tool.manual) steps.push(String(tool.manual));
    steps.push(`Reopen a new terminal so the new PATH entry is picked up.`);
  } else {
    steps.push(
      `"${name}" is not in FRIDAY's Install Manager catalog, so it cannot be installed automatically.`,
    );
    steps.push(
      `Find the official installer or package for "${name}" and install it manually (an account, licence key or GUI installer may be required).`,
    );
    steps.push(
      `If it is a Python package run "pip install ${name}"; if it is a Node package run "npm install -g ${name}".`,
    );
  }
  steps.push(`Come back here and press Retry — FRIDAY will run the same real test again.`);
  return {
    kind: "step_card",
    title: `Install ${label} manually`,
    reason:
      reason ||
      (tool
        ? `${label} has no unattended installer on this machine.`
        : `${name} is not in the Install Manager catalog.`),
    dependency: String(name),
    catalogId: tool?.id || null,
    url: tool?.url || null,
    steps,
    retryable: true,
  };
}

/* -------------------------------------------------------------- smoke test */

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Node harness: load the entry with require(), then run its self-test. */
function nodeHarness(entryFile, selfTest) {
  const call = selfTest
    ? `const fn = mod && (typeof mod[${JSON.stringify(selfTest.export || "selfTest")}] === "function"
        ? mod[${JSON.stringify(selfTest.export || "selfTest")}]
        : typeof mod.run === "function" ? mod.run
        : typeof mod === "function" ? mod : null);
      if (!fn) throw new Error("pack declares a self-test but exports no runnable function");
      value = await fn(${JSON.stringify(selfTest.input ?? {})});
      if (value === undefined) value = null;`
    : `if (!mod || (typeof mod !== "object" && typeof mod !== "function"))
        throw new Error("entry file exported nothing");`;
  return `import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(${JSON.stringify(entryFile)});
let value = null;
try {
  const mod = require(${JSON.stringify(entryFile)});
  ${call}
  writeFileSync("result.json", JSON.stringify({ ok: true, value }));
  console.log("capability loaded");
} catch (error) {
  console.error(String(error && error.stack || error));
  process.exit(1);
}
`;
}

/** Python harness: import the module by path, then run its self-test. */
function pythonHarness(entryFile, selfTest) {
  const name = JSON.stringify(selfTest?.export || "self_test");
  const input = JSON.stringify(JSON.stringify(selfTest?.input ?? {}));
  return `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("friday_pack", ${JSON.stringify(entryFile)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
value = None
${
  selfTest
    ? `fn = getattr(mod, ${name}, None) or getattr(mod, "run", None)
if fn is None:
    raise SystemExit("pack declares a self-test but exposes no runnable function")
value = fn(json.loads(${input}))`
    : ""
}
open("result.json", "w", encoding="utf-8").write(json.dumps({"ok": True, "value": value}, default=str))
print("capability loaded")
`;
}

function entryOf(dir, tree) {
  const manifest =
    tree === "skills"
      ? readJson(path.join(dir, "skill.json"))
      : readJson(path.join(dir, "manifest.json")) ||
        readJson(path.join(dir, "plugin.json")) ||
        readJson(path.join(dir, "tool.json")) ||
        readJson(path.join(dir, "agent.json")) ||
        readJson(path.join(dir, "workflow.json")) ||
        readJson(path.join(dir, "module.json"));
  const declared = manifest?.entry ? String(manifest.entry) : null;
  const candidates = [
    declared,
    tree === "skills" ? "skill.mjs" : null,
    "index.cjs",
    "index.js",
    "index.mjs",
    "main.py",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = path.join(dir, candidate);
    if (fs.existsSync(file) && fs.statSync(file).isFile())
      return { manifest, file, name: candidate };
  }
  return { manifest, file: null, name: declared };
}

/**
 * Run one installed capability through the real sandbox.
 * @returns {Promise<{ok:boolean, output:string, mode:string, value:any}>}
 */
async function smokeTest({ root, dir, tree }) {
  if (!root) return { ok: false, mode: "sandbox", output: "No FRIDAY workspace is selected." };
  if (!dir || !fs.existsSync(dir))
    return { ok: false, mode: "sandbox", output: "The installed capability folder is missing." };

  const { manifest, file, name } = entryOf(dir, tree);
  const selfTest = manifest?.selfTest || manifest?.self_test || null;

  if (!file) {
    // Manifest-only capabilities (most workflows) have nothing to execute; the
    // honest check is that the manifest parses and declares no missing entry.
    if (name)
      return { ok: false, mode: "manifest", output: `entry file "${name}" is missing on disk` };
    return manifest
      ? {
          ok: true,
          mode: "manifest",
          output: "manifest validated (no executable entry)",
          value: null,
        }
      : { ok: false, mode: "manifest", output: "no readable manifest" };
  }

  const allowNetwork = Boolean(
    manifest?.allowNetwork ||
    (Array.isArray(manifest?.capabilities) && manifest.capabilities.includes("web.access")) ||
    (Array.isArray(manifest?.permissions) && manifest.permissions.includes("network")),
  );

  // Skills already have a real sandbox harness — reuse it exactly.
  if (tree === "skills" && file.endsWith(".mjs")) {
    const code = fs.readFileSync(file, "utf8");
    const source = selfTest
      ? skills.harness(code, selfTest.input ?? {})
      : `${code}\nimport { writeFileSync } from "node:fs";\nif (typeof run !== "function") { console.error("skill does not define run(input)"); process.exit(1); }\nwriteFileSync("result.json", JSON.stringify({ ok: true, value: null }));\nconsole.log("skill loaded");\n`;
    const result = await sandbox.runIsolated({
      root,
      code: source,
      language: "node",
      timeoutMs: 30000,
      allowNetwork,
    });
    return {
      ok: Boolean(result.ok && result.result?.ok),
      mode: selfTest ? "self-test" : "load",
      output: result.output || "",
      value: result.result?.value ?? null,
    };
  }

  const python = file.endsWith(".py");
  const result = await sandbox.runIsolated({
    root,
    code: python ? pythonHarness(file, selfTest) : nodeHarness(file, selfTest),
    language: python ? "python" : "node",
    timeoutMs: 45000,
    allowNetwork,
  });
  return {
    ok: Boolean(result.ok && result.result?.ok),
    mode: selfTest ? "self-test" : "load",
    output: result.output || "",
    value: result.result?.value ?? null,
  };
}

/* ------------------------------------------------------------ orchestration */

/** Install one dependency through the Install Manager's own job runner. */
async function installDependency(root, name, emit) {
  const tool = resolveDependency(name);
  if (!tool) return { ok: false, guide: manualGuide(name, null) };
  if (!isAutomatable(tool)) return { ok: false, tool: tool.id, guide: manualGuide(name, tool) };

  emit({ phase: "Installing dependency", dependency: name, catalogId: tool.id });
  const job = await toolchain.runJob({ id: tool.id, action: "install", root }, (event) =>
    emit({ phase: "Installing dependency", dependency: name, catalogId: tool.id, ...event }),
  );
  if (job?.ok) return { ok: true, tool: tool.id };
  return {
    ok: false,
    tool: tool.id,
    guide: manualGuide(name, tool, `The automatic install of ${tool.id} did not finish.`),
  };
}

/** Declared runtime requirements, checked through the real Install Manager. */
function declaredDependencies(dir, tree) {
  const { manifest } = entryOf(dir, tree);
  const raw = [
    ...(Array.isArray(manifest?.requiresTools) ? manifest.requiresTools : []),
    ...(Array.isArray(manifest?.dependencies) ? manifest.dependencies : []),
    ...(Array.isArray(manifest?.runtimes) ? manifest.runtimes : []),
  ];
  return [...new Set(raw.map(String).filter(Boolean))];
}

/**
 * Full test-before-enable pass for one installed capability.
 *
 * @returns {Promise<{ok:boolean, status:string, error?:string, guide?:object,
 *                    installed?:string[], attempts:object[]}>}
 */
async function verifyCapability({ root }, { id, tree, dir }, options = {}) {
  const emit = typeof options.emit === "function" ? options.emit : () => {};
  const allowInstall = options.allowInstall !== false;
  const attempts = [];
  const installed = [];
  const tried = new Set();

  // Declared requirements first — a pack that says it needs ffmpeg should not
  // have to crash before FRIDAY installs ffmpeg.
  if (allowInstall) {
    for (const dependency of declaredDependencies(dir, tree)) {
      const tool = resolveDependency(dependency);
      if (!tool) {
        emit({ phase: "Manual step", dependency });
        return {
          ok: false,
          id,
          status: "needs-manual-step",
          error: `"${dependency}" is required but is not in the Install Manager catalog.`,
          guide: manualGuide(dependency, null),
          attempts,
          installed,
        };
      }
      tried.add(lower(dependency));
      const verify = await toolchain.runJob({ id: tool.id, action: "verify", root }, () => {});
      if (verify?.ok) continue;
      const result = await installDependency(root, dependency, emit);
      if (!result.ok)
        return {
          ok: false,
          id,
          status: "needs-manual-step",
          error: `${dependency} could not be installed automatically.`,
          guide: result.guide,
          attempts,
          installed,
        };
      installed.push(result.tool);
    }
  }

  for (let round = 0; round < 3; round += 1) {
    emit({ phase: round === 0 ? "Testing" : "Retesting", id });
    const test = await smokeTest({ root, dir, tree });
    attempts.push({ ok: test.ok, mode: test.mode, output: String(test.output || "").slice(-2000) });
    if (test.ok)
      return {
        ok: true,
        id,
        status: "verified",
        mode: test.mode,
        value: test.value ?? null,
        installed,
        attempts,
      };

    const missing = missingFromOutput(test.output);
    if (!missing || !allowInstall || tried.has(lower(missing))) {
      return {
        ok: false,
        id,
        status: missing ? "needs-manual-step" : "failed",
        error: String(test.output || "").slice(-1200) || "the capability failed its smoke test",
        ...(missing ? { guide: manualGuide(missing, resolveDependency(missing)) } : {}),
        attempts,
        installed,
      };
    }
    tried.add(lower(missing));
    const result = await installDependency(root, missing, emit);
    if (!result.ok)
      return {
        ok: false,
        id,
        status: "needs-manual-step",
        error: `${missing} is required by this capability and could not be installed automatically.`,
        guide: result.guide,
        attempts,
        installed,
      };
    installed.push(result.tool);
  }

  return {
    ok: false,
    id,
    status: "failed",
    error: "the capability still failed after its dependencies were installed",
    attempts,
    installed,
  };
}

module.exports = {
  missingFromOutput,
  resolveDependency,
  isAutomatable,
  manualGuide,
  smokeTest,
  declaredDependencies,
  installDependency,
  verifyCapability,
};
