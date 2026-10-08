/**
 * Shared install and download decisions for the voice stack.
 * Install Manager, the speech installer, and the model downloader call this.
 * A pip package is never labelled Manual just because Python was missing.
 */

const CAUSES = {
  "no-python":
    "No supported Python interpreter was found, and the managed 3.12 runtime could not be created.",
  "no-pip": "Python is present but pip is missing in that interpreter.",
  network: "The download did not resolve a host. Check DNS, then retry.",
  tls: "The TLS check failed. Retry uses the system certificate store.",
  proxy: "A proxy refused the connection. Set the system proxy, then retry.",
  disk: "The disk does not have room for this step.",
  permission: "The interpreter cannot write its site-packages. Check the folder, then retry.",
  antivirus: "A security tool blocked the installer. Allow this Python, then retry.",
  wheel: "No compatible wheel is published for this Python. Retry uses the managed 3.12 runtime.",
  timeout: "The step timed out. Retry when the network is idle.",
  "import-failed": "The package step finished but the import check failed.",
  "vendor-manual": "This step stays with the vendor.",
  unknown: "The step failed.",
  ok: "Ready.",
};

function explain(cause, detail) {
  const base = CAUSES[cause] || CAUSES.unknown;
  const extra = String(detail || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-180);
  if (!extra || cause === "vendor-manual" || cause === "ok") return base;
  return `${base} ${extra}`;
}

function classifyInstallLog(text) {
  const s = String(text || "");
  if (!s.trim()) return "unknown";
  if (/certificate verify failed|CERT_|SSL|TLS|unable to get local issuer/i.test(s)) return "tls";
  if (/proxy|407 Proxy|tunnel connection failed/i.test(s)) return "proxy";
  if (/timed out|timeout|ETIMEDOUT/i.test(s)) return "timeout";
  if (/No space left|ENOSPC|disk full/i.test(s)) return "disk";
  if (/antivirus|WinError 225|virus/i.test(s)) return "antivirus";
  if (/Access is denied|Permission denied|EPERM|EACCES|WinError 5/i.test(s)) return "permission";
  if (/No matching distribution|not a supported wheel|Could not find a version/i.test(s))
    return "wheel";
  if (
    /getaddrinfo|ENOTFOUND|Name or service not known|Temporary failure in name|EAI_AGAIN/i.test(s)
  )
    return "network";
  if (/No module named pip|pip is not installed/i.test(s)) return "no-pip";
  if (/No supported Python|Python was not found|not recognized as an internal/i.test(s))
    return "no-python";
  return "unknown";
}

function parts(value) {
  return String(value || "")
    .split(".")
    .map((piece) => Number(piece) || 0);
}

function versionAtLeast(version, floor) {
  const left = parts(version);
  const right = parts(floor);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
  }
  return true;
}

function pathUnsafe(file) {
  const value = String(file || "");
  if (!value) return true;
  if (value.length > 240) return true;
  return /[\u0000-\u001f]/.test(value);
}

function proveInterpreter(probe) {
  const version = String(probe?.version || "");
  const floor = String(probe?.floor || "3.12.10");
  if (!version) return { ok: false, cause: "no-python", reason: explain("no-python") };
  if (!versionAtLeast(version, floor)) {
    return {
      ok: false,
      cause: "no-python",
      reason: `Python ${version} is below the floor ${floor}.`,
    };
  }
  if (!probe?.hasPip) return { ok: false, cause: "no-pip", reason: explain("no-pip") };
  if (probe?.writable === false)
    return { ok: false, cause: "permission", reason: explain("permission") };
  if (pathUnsafe(probe?.exe)) {
    return {
      ok: false,
      cause: "permission",
      reason: "The interpreter path is too long or contains a broken character.",
    };
  }
  return { ok: true, cause: "ok", reason: `Python ${version} with pip can write site-packages.` };
}

/**
 * Manual is only a vendor step that has no pip package.
 * A missing interpreter is a failure with the real cause.
 */
function installOutcome(input) {
  if (input?.importOk) return { ok: true, phase: "Done", manual: false, cause: "ok", error: "" };
  if (input?.vendorOnly) {
    const error = String(input.vendorStep || explain("vendor-manual"));
    return { ok: false, phase: "Manual", manual: true, cause: "vendor-manual", error };
  }
  const cause =
    input?.cause || (!input?.pythonFound ? "no-python" : classifyInstallLog(input?.log));
  return {
    ok: false,
    phase: "Failed",
    manual: false,
    cause,
    error: explain(cause, input?.log),
  };
}

function blockedPip(manual) {
  return /does not install/i.test(String(manual || ""));
}

const MODEL_ORDER = ["large-v3", "medium", "small", "base", "tiny"];

function smallerModel(name) {
  const index = MODEL_ORDER.indexOf(name);
  if (index < 0) return "base";
  return MODEL_ORDER[Math.min(MODEL_ORDER.length - 1, index + 1)];
}

function bootModel(input) {
  const known = new Set(MODEL_ORDER);
  const requested = String(input?.requested || "auto");
  const locked = known.has(requested) ? requested : "";
  const elapsed = Number(input?.elapsedMs || 0);
  const budget = Number(input?.budgetMs || 0);
  const slow = Boolean(input?.failed) || (budget > 0 && elapsed > budget);
  if (locked) {
    if (slow) {
      return {
        model: smallerModel(locked),
        upgrade: null,
        reason: "load failed or ran past the budget, so a smaller model is used",
      };
    }
    return { model: locked, upgrade: null, reason: "the owner locked this size" };
  }
  if (slow) {
    return {
      model: input?.baseCached ? "base" : "tiny",
      upgrade: null,
      reason: "the first load was slow, so listening starts on a smaller model",
    };
  }
  if (input?.baseCached && !input?.smallCached) {
    return {
      model: "base",
      upgrade: "small",
      reason: "base is on disk, so listening starts now and small loads after",
    };
  }
  if (!input?.baseCached && !input?.smallCached) {
    return {
      model: "base",
      upgrade: "small",
      reason: "base loads first so listening starts sooner, then small",
    };
  }
  return { model: "small", upgrade: null, reason: "small is ready" };
}

function loadBudgetMs(model) {
  if (model === "tiny" || model === "base") return 45000;
  if (model === "small") return 120000;
  return 180000;
}

function classifyDownloadError(text) {
  const s = String(text || "");
  if (/cancel/i.test(s)) {
    return { cause: "cancel", line: "The download was cancelled. The partial file can resume." };
  }
  if (/401|403|unauthorized|gated repo|HF auth/i.test(s)) {
    return {
      cause: "hf-auth",
      line: "The model host refused the download. A gated file needs a token already on this PC.",
    };
  }
  if (/ENOSPC|disk full|No space/i.test(s)) {
    return { cause: "disk", line: "The disk filled up. Free space, then resume." };
  }
  if (/CERT_|certificate|TLS|SSL/i.test(s)) {
    return { cause: "tls", line: "TLS failed. Retry uses the system certificate store." };
  }
  if (/proxy|407/i.test(s)) return { cause: "proxy", line: "A proxy blocked the download." };
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN|\bDNS\b/i.test(s)) {
    return { cause: "dns", line: "DNS did not resolve the model host." };
  }
  if (/EPERM|EACCES|permission denied/i.test(s)) {
    return { cause: "path", line: "The cache path could not be written." };
  }
  if (/timeout|ETIMEDOUT/i.test(s)) {
    return { cause: "timeout", line: "The download timed out. Resume keeps the partial file." };
  }
  return {
    cause: "network",
    line: s.replace(/\s+/g, " ").trim().slice(-180) || "The download failed.",
  };
}

function downloadSelfCheck(input) {
  if (!input?.writable)
    return { ok: false, cause: "path", line: "The cache folder is not writable." };
  const free = Number(input?.freeBytes);
  const need = Number(input?.needBytes || 0);
  if (Number.isFinite(free) && need > free) {
    return { ok: false, cause: "disk", line: "Not enough free disk for a test download." };
  }
  return { ok: true, cause: "ok", line: "A test download can start." };
}

function hfHostList(env) {
  const source = env || {};
  const custom = String(source.HF_ENDPOINT || source.HF_HUB_ENDPOINT || "").replace(/\/$/, "");
  const hosts = ["https://huggingface.co", "https://hf-mirror.com"];
  if (/^https:\/\//i.test(custom)) hosts.unshift(custom);
  return hosts;
}

const INSTALL_PROBES = [
  ["no-interpreter", "no-python"],
  ["venv-missing", "no-python"],
  ["pip-failure", "no-pip"],
  ["proxy-block", "proxy"],
  ["tls-block", "tls"],
  ["package-without-model", "import-failed"],
  ["interrupted-download", "cancel"],
  ["model-timeout", "timeout"],
  ["worker-crash", "unknown"],
  ["permission-denied", "permission"],
  ["disk-full", "disk"],
  ["wheel-missing", "wheel"],
  ["antivirus-block", "antivirus"],
  ["tts-ok-stt-dead", "import-failed"],
];

function probeInstall(id) {
  const row = INSTALL_PROBES.find((item) => item[0] === id);
  const cause = row ? row[1] : "unknown";
  const downloadish = cause === "cancel" || cause === "timeout";
  const reason = downloadish ? classifyDownloadError(cause).line : explain(cause);
  return { id, cause, reason, manual: false };
}

module.exports = {
  explain,
  classifyInstallLog,
  proveInterpreter,
  installOutcome,
  blockedPip,
  bootModel,
  loadBudgetMs,
  classifyDownloadError,
  downloadSelfCheck,
  hfHostList,
  probeInstall,
  INSTALL_PROBES,
};
