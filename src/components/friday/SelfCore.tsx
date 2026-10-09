/**
 * FRIDAY · self core panels
 *
 * Her own identity rules, her own skills (write → sandbox-verify → install →
 * improve) and her own browser. Everything here is live: nothing is displayed
 * as working unless the desktop bridge really performed it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { deferEffect } from "@/lib/friday/defer-effect";
import { Globe, Play, Plus, RotateCcw, ShieldCheck, Sparkles, Trash2, Wrench } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { identity as selfIdentity, type IdentityState } from "@/lib/friday/brain/identity";
import {
  forgeSkill,
  improveSkill,
  invokeSkill,
  listSkills,
  removeSkill,
  rollbackSkill,
  setSkillEnabled,
  skillsAvailable,
  upgradeCandidates,
  type ForgeRun,
  type SkillManifest,
} from "@/lib/friday/brain/skill-forge";
import { browserAvailable, research, type SearchResult } from "@/lib/friday/browser-engine";

const serverState = selfIdentity.getSnapshot();

function useIdentity(): IdentityState {
  return useSyncExternalStore(selfIdentity.subscribe, selfIdentity.getSnapshot, () => serverState);
}

/* ------------------------------------------------------------- identity */

export function IdentityPanel() {
  const state = useIdentity();
  const [draft, setDraft] = useState("");
  const active = state.rules.filter((rule) => rule.enabled && rule.approved).length;

  useEffect(() => {
    selfIdentity.sync();
  }, []);

  return (
    <HudPanel
      title="Identity & rule book"
      hint={`${active} active of ${state.rules.length} rules · v${state.version}`}
    >
      <div className="space-y-3">
        <p className="font-mono text-[11px] text-muted-foreground">
          {state.profile.name} · owner {state.profile.owner} · voice {state.profile.voice}
        </p>

        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a standing rule for FRIDAY…"
            className="h-8 font-mono text-xs"
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim()) {
                selfIdentity.addRule(draft, { source: "owner" });
                setDraft("");
              }
            }}
          />
          <Button
            size="sm"
            className="h-8"
            disabled={!draft.trim()}
            onClick={() => {
              selfIdentity.addRule(draft, { source: "owner" });
              setDraft("");
            }}
          >
            <Plus className="size-3.5" /> Add
          </Button>
        </div>

        <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
          {[...state.rules]
            .sort((a, b) => b.priority - a.priority)
            .map((rule) => (
              <div
                key={rule.id}
                className="rounded-sm border border-border/60 bg-background/60 p-2 font-mono text-[11px]"
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={
                      rule.enabled && rule.approved ? "" : "text-muted-foreground line-through"
                    }
                  >
                    {rule.text}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <StatusPill
                      label={rule.source}
                      tone={
                        rule.source === "owner"
                          ? "accent"
                          : rule.source === "self"
                            ? "warning"
                            : "primary"
                      }
                    />
                    {!rule.approved ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={() => selfIdentity.approveRule(rule.id)}
                      >
                        <ShieldCheck className="size-3" /> Approve
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      onClick={() => selfIdentity.updateRule(rule.id, { enabled: !rule.enabled })}
                    >
                      {rule.enabled ? "Off" : "On"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-destructive"
                      onClick={() => selfIdentity.removeRule(rule.id)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </HudPanel>
  );
}

/* ---------------------------------------------------------------- skills */

export function SkillForgePanel() {
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [goal, setGoal] = useState("");
  const [run, setRun] = useState<ForgeRun | null>(null);
  const [busy, setBusy] = useState(false);
  // Destination for a newly forged skill: keep it on this PC only (default),
  // or also push it to a repo. Empty repo = local only.
  const [publishTo, setPublishTo] = useState("");
  const [publish, setPublish] = useState(false);
  const available = skillsAvailable();

  const refresh = useCallback(async () => setSkills(await listSkills()), []);
  useEffect(() => deferEffect(() => void refresh()), [refresh]);

  const candidates = useMemo(() => upgradeCandidates(skills), [skills]);

  const forge = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    const result = await forgeSkill(goal.trim(), {
      onProgress: setRun,
      publishTo: publish ? publishTo.trim() : "",
    });
    setRun(result);
    setBusy(false);
    if (result.stage === "done") setGoal("");
    await refresh();
  };

  return (
    <HudPanel
      title="Skill forge"
      hint={
        available ? `${skills.length} skills · ${candidates.length} need work` : "desktop app only"
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Teach FRIDAY a new skill — describe what it should do…"
            className="h-8 font-mono text-xs"
            disabled={!available || busy}
            onKeyDown={(event) => {
              if (event.key === "Enter") void forge();
            }}
          />
          <Button
            size="sm"
            className="h-8"
            disabled={!available || busy || !goal.trim()}
            onClick={() => void forge()}
          >
            <Sparkles className="size-3.5" /> {busy ? "Forging…" : "Forge"}
          </Button>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={publish}
              disabled={!available || busy}
              onChange={(event) => setPublish(event.target.checked)}
            />
            Also push to GitHub
          </label>
          {publish ? (
            <Input
              value={publishTo}
              onChange={(event) => setPublishTo(event.target.value)}
              placeholder="owner/repo"
              className="h-7 w-48 font-mono text-[10px]"
              disabled={busy}
            />
          ) : (
            <span>Keep in FRIDAY only.</span>
          )}
        </div>

        {run ? (
          <pre className="max-h-32 overflow-auto rounded-sm bg-background p-2 font-mono text-[10px] leading-relaxed">
            {run.log.map((line, index) => (
              <div
                key={`${line.at}-${index}`}
                className={line.ok ? "text-accent" : "text-destructive"}
              >
                {line.text}
              </div>
            ))}
            {run.error ? <div className="text-destructive">{run.error}</div> : null}
          </pre>
        ) : null}

        <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
          {skills.map((skill) => (
            <div key={skill.id} className="rounded-sm border border-border/60 bg-background/60 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px]">{skill.name}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {skill.category} · v{skill.version} · {skill.runs} runs / {skill.failures}{" "}
                    failed
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusPill
                    label={skill.builtin ? "native" : skill.risk}
                    tone={skill.builtin ? "primary" : "warning"}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={async () => {
                      await invokeSkill(skill.id, {});
                      await refresh();
                    }}
                  >
                    <Play className="size-3" />
                  </Button>
                  {!skill.builtin ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={async () => {
                          setBusy(true);
                          setRun(
                            await improveSkill(skill.id, "reduce failures and handle bad input", {
                              onProgress: setRun,
                            }),
                          );
                          setBusy(false);
                          await refresh();
                        }}
                      >
                        <Wrench className="size-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={async () => {
                          await rollbackSkill(skill.id);
                          await refresh();
                        }}
                      >
                        <RotateCcw className="size-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-destructive"
                        onClick={async () => {
                          await removeSkill(skill.id);
                          await refresh();
                        }}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              <ToggleRow
                label="Enabled"
                hint={skill.capabilities.join(", ") || "no extra capabilities"}
                on={skill.enabled}
                onToggle={async () => {
                  await setSkillEnabled(skill.id, !skill.enabled);
                  await refresh();
                }}
              />
            </div>
          ))}
          {!skills.length ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              {available
                ? "No skills yet — forge the first one above."
                : "Open FRIDAY on Windows to use skills."}
            </p>
          ) : null}
        </div>
      </div>
    </HudPanel>
  );
}

/* --------------------------------------------------------------- browser */

export function BrowserPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [reading, setReading] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = browserAvailable();

  const go = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(null);
    const found = await research(query.trim(), 2);
    setResults(found.results);
    setReading(
      found.pages
        .filter((page) => page.ok)
        .map((page) => `— ${page.title ?? page.url}\n${(page.text ?? "").slice(0, 800)}`)
        .join("\n\n"),
    );
    if (!found.ok) setError(found.error ?? "search failed");
    setBusy(false);
  };

  return (
    <HudPanel title="FRIDAY's browser" hint={available ? "live web access" : "desktop app only"}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search and read the web…"
            className="h-8 font-mono text-xs"
            disabled={!available || busy}
            onKeyDown={(event) => {
              if (event.key === "Enter") void go();
            }}
          />
          <Button
            size="sm"
            className="h-8"
            disabled={!available || busy || !query.trim()}
            onClick={() => void go()}
          >
            <Globe className="size-3.5" /> {busy ? "Reading…" : "Search"}
          </Button>
        </div>
        {error ? <p className="font-mono text-[11px] text-destructive">{error}</p> : null}
        <div className="max-h-40 space-y-1.5 overflow-auto pr-1">
          {results.map((result) => (
            <a
              key={result.url}
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-sm border border-border/60 bg-background/60 p-2 font-mono text-[11px] hover:border-primary/60"
            >
              <span className="text-primary">{result.title}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {result.snippet}
              </span>
            </a>
          ))}
        </div>
        {reading ? (
          <Textarea
            readOnly
            value={reading}
            className="h-32 resize-none font-mono text-[10px] leading-relaxed"
          />
        ) : null}
      </div>
    </HudPanel>
  );
}

export function SelfCoreSection() {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <IdentityPanel />
      <SkillForgePanel />
      <BrowserPanel />
    </div>
  );
}
