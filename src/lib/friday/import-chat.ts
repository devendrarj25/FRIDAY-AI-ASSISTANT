/**
 * Import & Build chat — same Core Brain pipeline as ChatDock (`brain.send`),
 * grounded in the real classify / preview / pack-verify session. Consequential
 * actions reuse `imports.installNow` / `verifyPacks` (governance still gates
 * install). Never invents zip contents.
 */

import { brain } from "@/lib/friday/brain-engine";
import { imports, type ImportItem } from "@/lib/friday/import-engine";
import { upgrades } from "@/lib/friday/upgrade-engine";
import { APP_VERSION } from "@/lib/friday/version";

export type ImportChatAction = {
  type: "none" | "verify" | "install" | "describe" | "fix" | "ask" | "build" | "analyse" | "keep";
  itemId?: string;
  areas?: string[];
  identity?: "friday" | "other";
  kind?: "exe" | "zip" | "portable";
};

export type ImportChatReply = {
  text: string;
  action: ImportChatAction;
  grounded: boolean;
};

export function describeImportSession(items: ImportItem[]): string {
  if (!items.length) {
    return [
      "Import & Build session: no files are staged.",
      "Do not invent contents of a zip or folder that has not been scanned.",
      "Ask the owner to drop a file, paste a URL, or paste a manifest first.",
    ].join("\n");
  }
  return items
    .map((item, i) => {
      const dests = item.placements?.length
        ? item.placements
            .map(
              (d) =>
                `  - ${d.path} → ${d.dest} [${d.area}]${d.reason ? ` (${d.reason})` : ""}${
                  d.extract ? " extract" : ""
                }`,
            )
            .join("\n")
        : item.destinations?.length
          ? item.destinations.map((d) => `  - ${d.dir} (${d.files} files)`).join("\n")
          : "  (no destinations — scan empty or failed)";
      const areas = item.areas?.length
        ? item.areas.map((a) => `${a.area}:${a.files}`).join(", ")
        : "(none)";
      const verify = item.packVerify
        ? `pack-verify ok=${item.packVerify.ok} packs=${
            item.packVerify.packs
              .map((p) => `${p.kind}:${p.ok ? "pass" : p.skipped ? "skip" : "fail"}`)
              .join("; ") || "(none)"
          }`
        : "pack-verify not run yet";
      return [
        `Item ${i + 1} id=${item.id} name=${item.name} status=${item.status} source=${item.source}`,
        `areas: ${areas}`,
        verify,
        item.message ? `message: ${item.message}` : null,
        "destinations:",
        dests,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function latestReady(items: ImportItem[]): ImportItem | undefined {
  return (
    [...items].reverse().find((i) => i.status === "ready" || i.status === "error") ?? items.at(-1)
  );
}

export function parseImportAreas(text: string): string[] | undefined {
  const lower = text.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/\bskills?\b/, "skills"],
    [/\btools?\b/, "tools"],
    [/\bagents?\b/, "agents"],
    [/\bmodules?\b/, "modules"],
    [/\bplugins?\b/, "plugins"],
    [/\bworkflows?\b/, "workflows"],
    [/\bvoices?\b/, "voices"],
    [/\bconnectors?\b/, "connectors"],
    [/\bknowledge\b|\bpdfs?\b|\bdocs?\b/, "brain"],
  ];
  const areas: string[] = [];
  for (const [re, area] of map) {
    if (re.test(lower) && !areas.includes(area)) areas.push(area);
  }
  return areas.length ? areas : undefined;
}

function wantsOnlySubset(text: string): boolean {
  return /\bonly\b|\bskip the rest\b|\bjust (the )?/i.test(text) && Boolean(parseImportAreas(text));
}

export function interpretImportPrompt(prompt: string): ImportChatAction {
  const lower = prompt.trim().toLowerCase();
  if (!lower) return { type: "none" };
  if (
    /\bwhat('s| is|s) in\b|\bwhat did (you|we) find\b|\bclassify\b|\bpreview\b|\bdestinations?\b/i.test(
      lower,
    )
  ) {
    return { type: "describe" };
  }
  if (/\b(analys[e]?|analyze|self-upgrade|stage upgrade)\b/i.test(lower)) {
    return { type: "analyse" };
  }
  if (
    /\b(build|package)\b/.test(lower) &&
    /\b(exe|zip|installer|portable|friday|other)\b/.test(lower)
  ) {
    const other = /\bother\b|\bnew app\b|\bthis (project|import|folder)\b/.test(lower);
    const kind: "exe" | "zip" | "portable" = /\bportable\b/.test(lower)
      ? "portable"
      : /\bzip\b/.test(lower)
        ? "zip"
        : "exe";
    return { type: "build", identity: other ? "other" : "friday", kind };
  }
  if (
    /\bkeep (this|it|a copy)\b|\bsave (a copy|this)\b|\bdownload (this|the) (exe|zip|artifact|installer)\b/i.test(
      lower,
    )
  ) {
    return { type: "keep" };
  }
  if (/\b(test|verify|sandbox|dry[- ]?run)\b/i.test(lower)) {
    return { type: "verify" };
  }
  if (/\bfix (the )?(broken|failing|failed)\b|\brepair\b|\bupgrade (it|this)\b/i.test(lower)) {
    return { type: "fix" };
  }
  if (/\b(install|apply|route)\b/i.test(lower)) {
    const areas = wantsOnlySubset(lower) ? parseImportAreas(lower) : undefined;
    return { type: "install", ...(areas ? { areas } : {}) };
  }
  return { type: "ask" };
}

function waitForBrainReply(startedAt: number, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(text);
    };
    const unsub = brain.subscribe(() => {
      const snap = brain.getSnapshot();
      if (snap.activeRunId) return;
      const last = [...snap.messages]
        .reverse()
        .find((m) => m.role === "friday" && m.at >= startedAt);
      if (last?.text?.trim()) finish(last.text.trim());
    });
    const timer = setTimeout(() => {
      finish("Core Brain did not finish this import question in time.");
    }, timeoutMs);
    const snap = brain.getSnapshot();
    if (!snap.activeRunId) {
      const last = [...snap.messages]
        .reverse()
        .find((m) => m.role === "friday" && m.at >= startedAt);
      if (last?.text?.trim()) finish(last.text.trim());
    }
  });
}

/**
 * Grounded intents operate the same import-engine functions the buttons call.
 * Unknown prose goes to Core Brain with the session dump in `options.extra`.
 */
export async function handleImportIntent(
  prompt: string,
  items: ImportItem[],
): Promise<ImportChatReply> {
  const text = prompt.trim();
  const intent = interpretImportPrompt(text);
  const item = latestReady(items);

  if (intent.type === "none") {
    return {
      text: "Type a question about the current import, or an action such as “only install the skills”.",
      action: intent,
      grounded: true,
    };
  }

  if (intent.type === "describe") {
    return { text: describeImportSession(items), action: { type: "describe" }, grounded: true };
  }

  if (intent.type === "verify") {
    if (!item) {
      return {
        text: "Nothing is staged to verify. Import a pack first.",
        action: intent,
        grounded: true,
      };
    }
    const result = await imports.verifyPacks(item.id);
    const summary = result
      ? `Verify ${result.ok ? "passed" : "failed"} for ${item.name}. ${
          (result.packs ?? [])
            .map((p) => `${p.kind}: ${p.ok ? "pass" : p.skipped ? "skipped" : p.detail || "fail"}`)
            .join("; ") || "no forge packs"
        }`
      : `Could not verify ${item.name} (desktop import required).`;
    return { text: summary, action: { type: "verify", itemId: item.id }, grounded: true };
  }

  if (intent.type === "analyse") {
    if (!item) {
      return {
        text: "Nothing is staged to analyse. Import a file, zip or folder first.",
        action: intent,
        grounded: true,
      };
    }
    const runId = upgrades.start(item, { autoFix: true, runTests: true, bumpVersion: APP_VERSION });
    const msg = `Started analysis, tests and staged fixes for ${item.name} (run ${runId}). Watch the Self-upgrade tab — every stage FRIDAY runs is listed there. This page does not push FRIDAY's GitHub repository.`;
    imports.note("friday", msg);
    return { text: msg, action: { type: "analyse", itemId: item.id }, grounded: true };
  }

  if (intent.type === "build") {
    const identity = intent.identity === "other" ? "other" : "friday";
    const kind = intent.kind ?? "exe";
    if (identity === "other" && !item?.scanId) {
      const msg =
        "Other-app packaging needs an imported scan or a folder chosen on Build & package. This page does not use FRIDAY's GitHub repo.";
      imports.note("friday", msg);
      return { text: msg, action: { type: "build", identity, kind }, grounded: true };
    }
    const label =
      identity === "friday"
        ? `FRIDAY v${APP_VERSION} ${kind}`
        : `${item?.name || "other app"} ${kind}`;
    const buildOpts: {
      identity: "friday" | "other";
      actor: "friday";
      name?: string;
      version?: string;
      scanId?: string;
    } = { identity, actor: "friday" };
    if (identity === "other") {
      buildOpts.name = item?.name || "app";
      if (item?.scanId) buildOpts.scanId = item.scanId;
    }
    const jobId = imports.build(kind, label, buildOpts);
    const job = imports.getSnapshot().builds.find((b) => b.id === jobId);
    const msg =
      job?.status === "error"
        ? job.step
        : `Queued ${identity} ${kind} (${label}). Watch Build & package for live progress. FRIDAY's GitHub repo is not touched.`;
    return { text: msg, action: { type: "build", identity, kind }, grounded: true };
  }

  if (intent.type === "keep") {
    const artifact = imports
      .getSnapshot()
      .builds.find((b) => b.status === "done" && b.artifact)?.artifact;
    if (!artifact) {
      return {
        text: "No finished artifact is listed yet. Build first, then ask to keep or download it.",
        action: intent,
        grounded: true,
      };
    }
    const result = await imports.keepArtifact(artifact, "friday");
    const msg = result.ok
      ? `Kept a copy at ${"path" in result && result.path ? result.path : artifact}. You can download it or Install into FRIDAY from Build & package.`
      : result.error || "Could not keep that artifact.";
    return { text: msg, action: intent, grounded: true };
  }

  if (intent.type === "fix") {
    if (!item) {
      return { text: "Nothing is staged to fix.", action: intent, grounded: true };
    }
    const failed = item.packVerify?.packs.filter((p) => !p.ok && !p.skipped) ?? [];
    if (failed.length) {
      return {
        text: `Sandbox verify failed for: ${failed
          .map((p) => `${p.kind} (${p.detail || "error"})`)
          .join(
            "; ",
          )}. Chat will not invent a fix. Re-export a valid pack, or use Upgrade on this page when the scan is upgrade-ready.`,
        action: { type: "fix", itemId: item.id },
        grounded: true,
      };
    }
    return {
      text: `${item.name} has no recorded sandbox failure. Run Verify first, or use the Upgrade control on this page (same upgrade engine as the rest of FRIDAY). Chat cannot silently rewrite a pack.`,
      action: { type: "fix", itemId: item.id },
      grounded: true,
    };
  }

  if (intent.type === "install") {
    if (!item) {
      return { text: "Nothing is staged to install.", action: intent, grounded: true };
    }
    await imports.installNow(item.id, {
      ...(intent.areas ? { areas: intent.areas } : {}),
      actor: "friday",
    });
    const after = imports.list().find((i) => i.id === item.id);
    const gone = !after;
    const msg = gone
      ? `Install completed for ${item.name}${
          intent.areas ? ` (areas: ${intent.areas.join(", ")})` : ""
        }. The item left Import & Build and now lives only in its real section.`
      : after?.message
        ? `Install did not finish: ${after.message}`
        : `Install of ${item.name} is ${after?.status ?? "unknown"}.`;
    return {
      text: msg,
      action: {
        type: "install",
        itemId: item.id,
        ...(intent.areas ? { areas: intent.areas } : {}),
      },
      grounded: true,
    };
  }

  const extra = [
    "You are answering from the Import & Build page.",
    "Use ONLY the following real classify/preview session. Never invent files, destinations, or pass/fail results.",
    "This page does not push, PR, or edit FRIDAY's GitHub repository. Friday Hub is that section.",
    describeImportSession(items),
  ].join("\n\n");

  if (typeof window === "undefined") {
    return {
      text: `Core Brain chat needs the desktop session. Grounded classify/preview:\n${describeImportSession(items)}`,
      action: { type: "ask" },
      grounded: true,
    };
  }

  const startedAt = Date.now();
  const result = brain.send(text, { extra });
  if (!result.accepted) {
    return {
      text: result.message || result.reason || "Core Brain did not accept this turn.",
      action: { type: "ask" },
      grounded: true,
    };
  }
  const reply = await waitForBrainReply(startedAt);
  return { text: reply, action: { type: "ask" }, grounded: true };
}
